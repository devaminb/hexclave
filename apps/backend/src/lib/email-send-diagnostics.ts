import { requestContextALS } from "@/lib/runtime/request-context";
import type { EmailOutboxSkippedReason } from "@/generated/prisma/client";
import type { DEFAULT_TEMPLATE_IDS } from "@hexclave/shared/dist/helpers/emails";
import type { LowLevelEmailConfig } from "./emails-low-level";

type EmailSendDiagnostic =
  | { stage: "requested" | "user-matched" | "preparing" | "config-loading" | "scheduled" | "deliverability-check" | "quota-check" }
  | { stage: "queued", deliveryId: string }
  | { stage: "skipped", reason: "password-auth-disabled" | "no-auth-email-match" | EmailOutboxSkippedReason }
  | { stage: "smtp-started" | "smtp-accepted", serverType: LowLevelEmailConfig["type"], smtpPort: number, secure: boolean }
  | { stage: "failed", phase: "configuration" | "quota" | "smtp" | "delivery", errorType: string, canRetry: boolean };

export function createEmailSendDiagnosticLogger(templateType: keyof typeof DEFAULT_TEMPLATE_IDS | null, deliveryId?: string) {
  // Capture correlation before detaching SMTP work from the request. Log only
  // delivery stages, never recipients, account IDs, credentials, codes, or links.
  const requestId = requestContextALS.getStore()?.requestId ?? null;
  const startedAt = performance.now();
  return (diagnostic: EmailSendDiagnostic) => {
    const log = {
      event: "email.send.diagnostic",
      service: "stack-backend",
      requestId,
      templateType,
      ...(deliveryId == null ? {} : { deliveryId }),
      elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
      ...diagnostic,
    };
    if (diagnostic.stage === "failed") {
      console.error(JSON.stringify(log));
    } else {
      console.info(JSON.stringify(log));
    }
  };
}
