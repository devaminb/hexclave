import { DEFAULT_TEMPLATE_IDS } from "@hexclave/shared/dist/helpers/emails";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it, localRedirectUrl } from "../../../../../helpers";
import { Project, User, backendContext, niceBackendFetch, waitForOutboxEmailWithStatus, withInternalProject } from "../../../../backend-helpers";

async function getEmailAllowance(ownerTeamId: string): Promise<number> {
  return await withInternalProject(async () => {
    const response = await niceBackendFetch(`/api/v1/payments/items/team/${encodeURIComponent(ownerTeamId)}/emails_per_month`, {
      accessType: "server",
    });
    const quantity: unknown = response.body.quantity;
    if (response.status !== 200 || typeof quantity !== "number" || !Number.isFinite(quantity)) {
      throw new Error("Expected a finite email allowance for the project's billing team");
    }
    return quantity;
  });
}

async function waitForEmailAllowance(ownerTeamId: string, expected: number): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (true) {
    const quantity = await getEmailAllowance(ownerTeamId);
    if (quantity === expected) return;
    if (performance.now() >= deadline) {
      throw new Error(`Expected email allowance ${expected}, received ${quantity}`);
    }
    await wait(250);
  }
}

async function setEmailAllowance(ownerTeamId: string, quantity: number): Promise<void> {
  const current = await getEmailAllowance(ownerTeamId);
  await withInternalProject(async () => {
    const response = await niceBackendFetch(`/api/v1/payments/items/team/${encodeURIComponent(ownerTeamId)}/emails_per_month/update-quantity?allow_negative=true`, {
      method: "POST",
      accessType: "server",
      body: { delta: quantity - current },
    });
    if (response.status !== 200) {
      throw new Error("Failed to set the billing team's email allowance");
    }
  });
  await waitForEmailAllowance(ownerTeamId, quantity);
}

async function createResetProject(displayName: string): Promise<string> {
  const { createProjectResponse } = await Project.createAndSwitch({ display_name: displayName });
  const ownerTeamId: unknown = createProjectResponse.body.owner_team_id;
  if (typeof ownerTeamId !== "string") {
    throw new Error("Expected a billing team on the test project");
  }
  await User.create({
    primary_email: backendContext.value.mailbox.emailAddress,
    primary_email_verified: true,
    primary_email_auth_enabled: true,
  });
  return ownerTeamId;
}

async function requestPasswordReset() {
  return await niceBackendFetch("/api/v1/auth/password/send-reset-code", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      callback_url: localRedirectUrl,
    },
  });
}

it("blocks static password reset emails when the monthly allowance is exhausted", async ({ expect }) => {
  const ownerTeamId = await createResetProject("Exhausted Auth Email Allowance");
  await setEmailAllowance(ownerTeamId, 0);

  const response = await requestPasswordReset();
  expect(response.status).toBe(200);
  const emails = await waitForOutboxEmailWithStatus("Reset your password at Exhausted Auth Email Allowance", "server-error");
  expect(emails[0]).toMatchObject({
    has_rendered: true,
    is_transactional: true,
    skip_deliverability_check: true,
    server_error: "Monthly email sending limit exceeded for your plan. Please upgrade your plan or wait until next month.",
  });
  expect(await getEmailAllowance(ownerTeamId)).toBe(0);
  expect(await backendContext.value.mailbox.fetchMessages({ noBody: true })).toMatchInlineSnapshot(`[]`);
});

it("tracks and debits static reset emails without executing a broken stored template", async ({ expect }) => {
  const ownerTeamId = await createResetProject("Static Auth Email Delivery");
  await setEmailAllowance(ownerTeamId, 2);
  await Project.updateProjectConfig({
    [`emails.templates.${DEFAULT_TEMPLATE_IDS.password_reset}.tsxSource`]: 'export function EmailTemplate() { throw new Error("Stored template must not execute"); }',
  });

  const response = await requestPasswordReset();
  expect(response.status).toBe(200);
  const subject = "Reset your password at Static Auth Email Delivery";
  const emails = await waitForOutboxEmailWithStatus(subject, "sent");
  const email = emails[0];
  expect(email).toMatchObject({
    has_rendered: true,
    is_transactional: true,
    email_programmatic_call_template_id: DEFAULT_TEMPLATE_IDS.password_reset,
    skip_deliverability_check: true,
    send_retries: 0,
  });
  expect(email.started_rendering_at_millis).toBe(email.rendered_at_millis);
  await backendContext.value.mailbox.waitForMessagesWithSubject(subject);
  await waitForEmailAllowance(ownerTeamId, 1);
});
