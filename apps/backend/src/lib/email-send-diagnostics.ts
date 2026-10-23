import { requestContextALS } from "@/lib/runtime/request-context";
import type { DEFAULT_TEMPLATE_IDS } from "@hexclave/shared/dist/helpers/emails";
import type { LowLevelEmailConfig } from "./emails-low-level";

type EmailSendDiagnostic =
  | { stage: "requested" | "user-matched" | "preparing" | "config-loading" | "scheduled" }
  | { stage: "skipped", reason: "password-auth-disabled" | "no-auth-email-match" }
  | { stage: "smtp-started" | "smtp-accepted", serverType: LowLevelEmailConfig["type"], smtpPort: number, secure: boolean }
  | { stage: "failed", phase: "configuration" | "smtp", errorType: string, canRetry: boolean };

export function createEmailSendDiagnosticLogger(templateType: keyof typeof DEFAULT_TEMPLATE_IDS) {
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
