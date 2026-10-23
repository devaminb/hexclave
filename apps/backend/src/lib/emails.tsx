import { globalPrismaClient } from '@/prisma-client';
import { runAsynchronouslyAndWaitUntil } from '@/utils/background-tasks';
import { EmailOutboxCreatedWith } from '@/generated/prisma/client';
import { DEFAULT_EMAIL_THEMES, DEFAULT_TEMPLATE_IDS } from '@hexclave/shared/dist/helpers/emails';
import { UsersCrud } from '@hexclave/shared/dist/interface/crud/users';
import { getEnvBoolean, getEnvVariable } from '@hexclave/shared/dist/utils/env';
import { HexclaveAssertionError, throwErr } from '@hexclave/shared/dist/utils/errors';
import { escapeHtml } from '@hexclave/shared/dist/utils/html';
import { Json } from '@hexclave/shared/dist/utils/json';
import { randomUUID } from 'node:crypto';
import { createEmailSendDiagnosticLogger } from './email-send-diagnostics';
import { createTemplateComponentFromHtml } from './email-rendering';
import { runEmailQueueStep, serializeRecipient } from './email-queue-step';
import { LowLevelEmailConfig, isSecureEmailPort } from './emails-low-level';
import { getNotificationCategoryByName } from './notification-categories';
import { Tenancy } from './tenancies';


/**
 * Describes where an email should be delivered. Each outbox entry targets exactly one recipient entity.
 *
 * user-primary-email: the email is being sent to the primary email address of a user (determined at the time of sending, NOT the time of creation/rendering). if the user unsubscribes, they will not receive the email.
 * user-custom-emails: the email is being sent to a list of custom emails, but if the user unsubscribes, they will no longer receive the email.
 * custom-emails: the email is being sent to a list of custom emails. there is no associated user object and the recipient cannot unsubscribe. cannot be used to send non-transactional emails.
 */
export type EmailOutboxRecipient =
  | { type: "user-primary-email", userId: string }
  | { type: "user-custom-emails", userId: string, emails: string[] }
  | { type: "custom-emails", emails: string[] };

function getDefaultEmailTemplate(tenancy: Tenancy, type: keyof typeof DEFAULT_TEMPLATE_IDS) {
  const templateList = new Map(Object.entries(tenancy.config.emails.templates));
  const defaultTemplateIdsMap = new Map(Object.entries(DEFAULT_TEMPLATE_IDS));
  const defaultTemplateId = defaultTemplateIdsMap.get(type);
  if (defaultTemplateId) {
    const template = templateList.get(defaultTemplateId);
    if (!template) {
      throw new HexclaveAssertionError(`Default email template not found: ${type}`);
    }
    return template;
  }
  throw new HexclaveAssertionError(`Unknown email template type: ${type}`);
}

export async function sendEmailToMany(options: {
  tenancy: Tenancy,
  recipients: EmailOutboxRecipient[],
  tsxSource: string,
  extraVariables: Record<string, Json>,
  themeId: string | null,
  isHighPriority: boolean,
  shouldSkipDeliverabilityCheck: boolean,
  scheduledAt: Date,
  createdWith: { type: "draft", draftId: string } | { type: "programmatic-call", templateId: string | null },
  overrideSubject?: string,
  overrideNotificationCategoryId?: string,
}) {
  await globalPrismaClient.emailOutbox.createMany({
    data: options.recipients.map(recipient => ({
      tenancyId: options.tenancy.id,
      tsxSource: options.tsxSource,
      themeId: options.themeId,
      isHighPriority: options.isHighPriority,
      createdWith: options.createdWith.type === "draft" ? EmailOutboxCreatedWith.DRAFT : EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
      emailDraftId: options.createdWith.type === "draft" ? options.createdWith.draftId : undefined,
      emailProgrammaticCallTemplateId: options.createdWith.type === "programmatic-call" ? options.createdWith.templateId : undefined,
      to: serializeRecipient(recipient)!,
      extraRenderVariables: options.extraVariables,
      scheduledAt: options.scheduledAt,
      shouldSkipDeliverabilityCheck: options.shouldSkipDeliverabilityCheck,
      overrideSubject: options.overrideSubject,
      overrideNotificationCategoryId: options.overrideNotificationCategoryId,
    })),
  });

  triggerEmailQueue();
}

function triggerEmailQueue() {
  if (!getEnvBoolean("STACK_EMAIL_BRANCHING_DISABLE_QUEUE_AUTO_TRIGGER")) {
    // The cron job should run runEmailQueueStep() to process the emails, but we call it here again for those self-hosters
    // who didn't set up the cron job correctly, and also just in case something happens to the cron job.
    runAsynchronouslyAndWaitUntil(runEmailQueueStep());
  }
}

function getDefaultAuthEmailContent(templateType: keyof typeof DEFAULT_TEMPLATE_IDS, projectName: string, variables: Record<string, Json>) {
  const requireString = (name: string, { nonEmpty = true } = {}): string => {
    const value = variables[name];
    if (typeof value !== 'string' || (nonEmpty && value.trim().length === 0)) {
      throw new HexclaveAssertionError('Default auth email is missing a required string variable', { templateType, variable: name });
    }
    return value;
  };

  let subject: string;
  let paragraphs: string[];
  let link: string;
  switch (templateType) {
    case 'magic_link': {
      const otp = requireString('otp');
      subject = `Sign in to ${projectName}: Your code is ${otp}`;
      paragraphs = [`Sign in to ${projectName}`, 'Your one-time sign-in code is:', otp, 'Or use this link to sign in:'];
      link = requireString('magicLink');
      break;
    }
    case 'password_reset': {
      subject = `Reset your password at ${projectName}`;
      paragraphs = [`Use this link to reset your password for ${projectName}:`];
      link = requireString('passwordResetLink');
      break;
    }
    case 'email_verification': {
      subject = `Verify your email at ${projectName}`;
      paragraphs = [`Use this link to verify your email address for ${projectName}:`];
      link = requireString('emailVerificationLink');
      break;
    }
    case 'team_invitation': {
      const teamName = requireString('teamDisplayName', { nonEmpty: false });
      subject = `You have been invited to join ${teamName}`;
      paragraphs = [`Use this link to accept your invitation to ${teamName}:`];
      link = requireString('teamInvitationLink');
      break;
    }
    case 'sign_in_invitation': {
      subject = `You have been invited to sign in to ${projectName}`;
      paragraphs = [`You have been invited to sign in to ${projectName}. Use this link:`];
      link = requireString('signInInvitationLink');
      break;
    }
    case 'payment_receipt':
    case 'payment_failed':
    case 'trial_will_end': {
      return null;
    }
    default: {
      throw new HexclaveAssertionError('Unknown default email template', { templateType: templateType satisfies never });
    }
  }

  const footer = 'If you were not expecting this email, you can safely ignore it.';
  return {
    subject,
    text: [...paragraphs, link, footer].join('\n\n'),
    html: paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('')
      + `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(footer)}</p>`,
  };
}

export async function sendEmailFromDefaultTemplate(options: {
  tenancy: Tenancy,
  user: UsersCrud["Admin"]["Read"] | null,
  email: string,
  templateType: keyof typeof DEFAULT_TEMPLATE_IDS,
  extraVariables: Record<string, Json>,
  shouldSkipDeliverabilityCheck: boolean,
}) {
  // Static auth content bypasses template execution, while a completed render in
  // the outbox keeps quota accounting, deliverability checks, and retries shared
  // with every other email. A worker must never claim these rows for rendering.
  const logEmail = createEmailSendDiagnosticLogger(options.templateType);
  logEmail({ stage: 'preparing' });
  const content = getDefaultAuthEmailContent(options.templateType, options.tenancy.project.display_name, options.extraVariables);
  if (content !== null) {
    const category = getNotificationCategoryByName('Transactional') ?? throwErr('The built-in Transactional notification category must exist for auth emails');
    const recipient: EmailOutboxRecipient = options.user == null
      ? { type: 'custom-emails', emails: [options.email] }
      : { type: 'user-custom-emails', userId: options.user.id, emails: [options.email] };
    const renderedAt = new Date();
    const outbox = await globalPrismaClient.emailOutbox.create({
      data: {
        tenancyId: options.tenancy.id,
        to: serializeRecipient(recipient) ?? throwErr('A default email recipient must serialize to a non-null JSON value'),
        tsxSource: createTemplateComponentFromHtml(content.html),
        themeId: null,
        extraRenderVariables: options.extraVariables,
        createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        emailProgrammaticCallTemplateId: DEFAULT_TEMPLATE_IDS[options.templateType],
        overrideSubject: content.subject,
        overrideNotificationCategoryId: category.id,
        isHighPriority: true,
        shouldSkipDeliverabilityCheck: options.shouldSkipDeliverabilityCheck,
        scheduledAt: renderedAt,
        renderedByWorkerId: randomUUID(),
        startedRenderingAt: renderedAt,
        finishedRenderingAt: renderedAt,
        renderedSubject: content.subject,
        renderedHtml: content.html,
        renderedText: content.text,
        renderedIsTransactional: true,
        renderedNotificationCategoryId: category.id,
      },
      select: { id: true },
    });
    logEmail({ stage: 'queued', deliveryId: outbox.id });
    triggerEmailQueue();
    return;
  }

  const template = getDefaultEmailTemplate(options.tenancy, options.templateType);

  await sendEmailToMany({
    tenancy: options.tenancy,
    recipients: [options.user ? { type: "user-custom-emails", userId: options.user.id, emails: [options.email] } : { type: "custom-emails", emails: [options.email] }],
    tsxSource: template.tsxSource,
    extraVariables: options.extraVariables,
    themeId: template.themeId === false ? null : (template.themeId ?? options.tenancy.config.emails.selectedThemeId),
    createdWith: { type: "programmatic-call", templateId: DEFAULT_TEMPLATE_IDS[options.templateType] },
    isHighPriority: true,  // always make emails sent via default template high priority
    shouldSkipDeliverabilityCheck: options.shouldSkipDeliverabilityCheck,
    scheduledAt: new Date(),
  });
}

const DEFAULT_TEMPLATE_ID_SET: ReadonlySet<string> = new Set(Object.values(DEFAULT_TEMPLATE_IDS));
const DEFAULT_EMAIL_THEME_ID_SET: ReadonlySet<string> = new Set(Object.keys(DEFAULT_EMAIL_THEMES));

/** Whether an email was rendered with a project-defined custom (non-default) theme. */
function isCustomEmailTheme(themeId: string | null | undefined): boolean {
  return themeId !== null && themeId !== undefined && !DEFAULT_EMAIL_THEME_ID_SET.has(themeId);
}

/** Whether an outbox email is project-defined custom content that should get the shared-server dev wrapper. */
export function isCustomEmailForSharedServer(recipient: EmailOutboxRecipient, createdWith: EmailOutboxCreatedWith, programmaticCallTemplateId: string | null, themeId: string | null | undefined): boolean {
  // A custom (non-default) theme makes even a default/system email (verification, password reset, ...) look
  // like the project's own production email, so it should carry the dev notice regardless of recipient or
  // template. Hexclave's own internal notifications always send with themeId === null, so they stay exempt.
  if (isCustomEmailTheme(themeId)) {
    return true;
  }
  // Hexclave's own system notifications (credential-scanning alerts, internal feedback) send raw HTML to bare
  // "custom-emails" addresses and must go out verbatim; the send-email API always targets the project's users.
  if (recipient.type === "custom-emails") {
    return false;
  }
  if (createdWith === EmailOutboxCreatedWith.DRAFT) {
    return true;
  }
  return programmaticCallTemplateId === null || !DEFAULT_TEMPLATE_ID_SET.has(programmaticCallTemplateId);
}

export function wrapSharedDevEmail(content: { subject: string, html?: string, text?: string }): { subject: string, html?: string, text?: string } {
  const wrappedSubject = `[Hexclave dev email] ${content.subject}`;

  const noticeHtml = `<div style="margin:0 0 16px 0;padding:12px 16px;border:1px solid #f0c000;border-radius:8px;background:#fff8e1;color:#5b4a00;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;">`
    + `<strong>This is a development email from an app built on Hexclave.</strong><br />`
    + `The app hasn't configured its own email server yet, so it was sent through Hexclave's shared development email server. If this is your app, set up a custom email server in your Hexclave dashboard to send emails from your own domain. If you don't recognize this app, you can ignore this email.`
    + `</div>`;

  const noticeText = `[Development email from an app built on Hexclave]\n`
    + `The app hasn't configured its own email server yet, so it was sent through Hexclave's shared development email server. If this is your app, set up a custom email server in your Hexclave dashboard to send emails from your own domain. If you don't recognize this app, you can ignore this email.\n\n`;

  return {
    subject: wrappedSubject,
    html: content.html === undefined ? undefined : injectDevNoticeIntoHtml(content.html, noticeHtml),
    text: content.text === undefined ? undefined : noticeText + content.text,
  };
}

// Insert the notice just inside <body> so it stays valid markup for full HTML documents; fall back to prepending for fragments.
function injectDevNoticeIntoHtml(html: string, noticeHtml: string): string {
  const bodyOpenTag = /<body[^>]*>/i;
  if (bodyOpenTag.test(html)) {
    return html.replace(bodyOpenTag, (match) => match + noticeHtml);
  }
  return noticeHtml + html;
}

export async function getEmailConfig(tenancy: Tenancy): Promise<LowLevelEmailConfig> {
  const projectEmailConfig = tenancy.config.emails.server;

  if (projectEmailConfig.isShared) {
    return await getSharedEmailConfig(tenancy.project.display_name);
  } else {
    if (projectEmailConfig.provider === "managed") {
      if (!projectEmailConfig.password || !projectEmailConfig.managedSubdomain || !projectEmailConfig.managedSenderLocalPart) {
        throw new HexclaveAssertionError("Managed email config is incomplete despite provider being managed", {
          projectId: tenancy.id,
          emailConfig: projectEmailConfig,
        });
      }
      return {
        host: "smtp.resend.com",
        port: 465,
        username: "resend",
        password: projectEmailConfig.password,
        senderEmail: `${projectEmailConfig.managedSenderLocalPart}@${projectEmailConfig.managedSubdomain}`,
        senderName: tenancy.project.display_name,
        secure: true,
        type: "managed",
      };
    }

    if (!projectEmailConfig.host || !projectEmailConfig.port || !projectEmailConfig.username || !projectEmailConfig.password || !projectEmailConfig.senderEmail || !projectEmailConfig.senderName) {
      throw new HexclaveAssertionError("Email config is not complete despite not being shared. This should never happen?", { projectId: tenancy.id, emailConfig: projectEmailConfig });
    }
    return {
      host: projectEmailConfig.host,
      port: projectEmailConfig.port,
      username: projectEmailConfig.username,
      password: projectEmailConfig.password,
      senderEmail: projectEmailConfig.senderEmail,
      senderName: projectEmailConfig.senderName,
      secure: isSecureEmailPort(projectEmailConfig.port),
      type: 'standard',
    };
  }
}


export async function getSharedEmailConfig(displayName: string): Promise<LowLevelEmailConfig> {
  return {
    host: getEnvVariable('STACK_EMAIL_HOST'),
    port: parseInt(getEnvVariable('STACK_EMAIL_PORT')),
    username: getEnvVariable('STACK_EMAIL_USERNAME'),
    password: getEnvVariable('STACK_EMAIL_PASSWORD'),
    senderEmail: getEnvVariable('STACK_EMAIL_SENDER'),
    senderName: displayName,
    secure: isSecureEmailPort(getEnvVariable('STACK_EMAIL_PORT')),
    type: 'shared',
  };
}

export function normalizeEmail(email: string): string {
  if (typeof email !== 'string') {
    throw new TypeError('normalize-email expects a string');
  }


  const emailLower = email.trim().toLowerCase();
  const emailParts = emailLower.split(/@/);

  if (emailParts.length !== 2) {
    throw new HexclaveAssertionError('Invalid email address', { email });
  }

  let [username, domain] = emailParts;

  return `${username}@${domain}`;
}

import.meta.vitest?.test('normalizeEmail(...)', async ({ expect }) => {
  expect(normalizeEmail('Example.Test@gmail.com')).toBe('example.test@gmail.com');
  expect(normalizeEmail('Example.Test+123@gmail.com')).toBe('example.test+123@gmail.com');
  expect(normalizeEmail('exampletest@gmail.com')).toBe('exampletest@gmail.com');
  expect(normalizeEmail('EXAMPLETEST@gmail.com')).toBe('exampletest@gmail.com');

  expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  expect(normalizeEmail('user.name+tag@example.com')).toBe('user.name+tag@example.com');

  expect(() => normalizeEmail('test@multiple@domains.com')).toThrow();
  expect(() => normalizeEmail('invalid.email')).toThrow();
});

if (import.meta.vitest != null) {
  const { test, expect } = import.meta.vitest;
  const link = 'https://example.com/callback?code=abcdef123456';
  const cases: { templateType: keyof typeof DEFAULT_TEMPLATE_IDS, variables: Record<string, Json>, subject: string }[] = [
    { templateType: 'magic_link', variables: { magicLink: link, otp: 'A1B2C3' }, subject: 'Sign in to Example: Your code is A1B2C3' },
    { templateType: 'password_reset', variables: { passwordResetLink: link }, subject: 'Reset your password at Example' },
    { templateType: 'email_verification', variables: { emailVerificationLink: link }, subject: 'Verify your email at Example' },
    { templateType: 'team_invitation', variables: { teamInvitationLink: link, teamDisplayName: 'Example Team' }, subject: 'You have been invited to join Example Team' },
    { templateType: 'sign_in_invitation', variables: { signInInvitationLink: link }, subject: 'You have been invited to sign in to Example' },
  ];

  test('default auth emails preserve subjects and usable links in both formats', ({ expect }) => {
    for (const { templateType, variables, subject } of cases) {
      const content = getDefaultAuthEmailContent(templateType, 'Example', variables);
      if (content === null) throw new HexclaveAssertionError('Auth template unexpectedly produced no email content', { templateType });
      expect(content.subject).toBe(subject);
      expect(content.text).toContain(link);
      expect(content.html).toContain(`<a href="${link}">${link}</a>`);
    }
    const magicLink = getDefaultAuthEmailContent('magic_link', 'Example', { magicLink: link, otp: 'A1B2C3' });
    expect(magicLink?.text).toContain('\n\nA1B2C3\n\n');
    expect(magicLink?.html.match(/>([A-Z0-9]{6})<\/p>/)?.[1]).toBe('A1B2C3');
  });

  test('default auth emails reject missing variables and invalid codes or links', ({ expect }) => {
    for (const { templateType, variables } of cases) {
      for (const name of Object.keys(variables)) {
        const invalidValues: Json[] = name === 'teamDisplayName'
          ? [null, 123, false, [], {}]
          : ['', ' \n ', null, 123, false, [], {}];
        const missingVariable = { ...variables };
        delete missingVariable[name];
        expect(() => getDefaultAuthEmailContent(templateType, 'Example', missingVariable)).toThrow(HexclaveAssertionError);
        for (const value of invalidValues) {
          expect(() => getDefaultAuthEmailContent(templateType, 'Example', { ...variables, [name]: value })).toThrow(HexclaveAssertionError);
        }
      }
    }
  });

  test.each(['', ' \n '])('team invitations accept the valid display name %j', (teamDisplayName) => {
    const content = getDefaultAuthEmailContent('team_invitation', 'Example', { teamInvitationLink: link, teamDisplayName });
    expect(content?.subject).toBe(`You have been invited to join ${teamDisplayName}`);
    expect(content?.text).toContain(link);
    expect(content?.html).toContain(`<a href="${link}">${link}</a>`);
  });

  test('default auth emails escape project names, team names, and URLs in HTML', ({ expect }) => {
    const specialLink = 'https://example.com/callback?code=abc&label="<invite>"';
    const escapedLink = 'https://example.com/callback?code=abc&amp;label=&quot;&lt;invite&gt;&quot;';
    const magicLink = getDefaultAuthEmailContent('magic_link', '<Project & "Partners">', { magicLink: specialLink, otp: 'A1B2C3' });
    const invitation = getDefaultAuthEmailContent('team_invitation', 'Example', { teamInvitationLink: specialLink, teamDisplayName: '<Team & "Friends">' });
    expect(magicLink?.html).toContain('<p>Sign in to &lt;Project &amp; &quot;Partners&quot;&gt;</p>');
    expect(invitation?.html).toContain('&lt;Team &amp; &quot;Friends&quot;&gt;');
    for (const content of [magicLink, invitation]) {
      expect(content?.html).toContain(`<a href="${escapedLink}">${escapedLink}</a>`);
      expect(content?.html).not.toContain('<invite>');
      expect(content?.text).toContain(specialLink);
    }
  });

  test('payment emails remain on the template rendering path', ({ expect }) => {
    expect([
      getDefaultAuthEmailContent('payment_receipt', 'Example', {}),
      getDefaultAuthEmailContent('payment_failed', 'Example', {}),
      getDefaultAuthEmailContent('trial_will_end', 'Example', {}),
    ]).toMatchInlineSnapshot(`
      [
        null,
        null,
        null,
      ]
    `);
  });
}
