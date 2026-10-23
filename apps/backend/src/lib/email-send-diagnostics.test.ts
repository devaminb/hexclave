import { requestContextALS, type RequestContext } from "@/lib/runtime/request-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmailSendDiagnosticLogger } from "./email-send-diagnostics";

function createRequestContext(requestId: string): RequestContext {
  return {
    requestId,
    abortSignal: new AbortController().signal,
    headers: new Headers({ authorization: "Bearer do-not-log-token" }),
    incomingCookies: new Map([["session", "do-not-log-cookie"]]),
    pendingSetCookies: [],
    deletedCookies: [],
    normalizedPath: "/api/latest/auth/password/send-reset-code",
  };
}

describe("email send diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps request correlation after the request context has ended without logging request secrets", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(performance, "now").mockReturnValueOnce(10).mockReturnValueOnce(35.5);
    const logEmail = requestContextALS.run(createRequestContext("request-one"), () => {
      return createEmailSendDiagnosticLogger("password_reset");
    });

    logEmail({ stage: "smtp-started", serverType: "shared", smtpPort: 587, secure: false });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(JSON.stringify({
      event: "email.send.diagnostic",
      service: "stack-backend",
      requestId: "request-one",
      templateType: "password_reset",
      elapsedMs: 25.5,
      stage: "smtp-started",
      serverType: "shared",
      smtpPort: 587,
      secure: false,
    }));
    expect(JSON.stringify(info.mock.calls)).not.toContain("do-not-log");
  });

  it("keeps concurrent send attempts associated with their originating requests", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const first = requestContextALS.run(createRequestContext("request-one"), () => createEmailSendDiagnosticLogger("password_reset"));
    const second = requestContextALS.run(createRequestContext("request-two"), () => createEmailSendDiagnosticLogger("password_reset"));

    await Promise.all([
      Promise.resolve().then(() => first({ stage: "smtp-accepted", serverType: "standard", smtpPort: 465, secure: true })),
      Promise.resolve().then(() => second({ stage: "skipped", reason: "no-auth-email-match" })),
    ]);

    expect(info).toHaveBeenNthCalledWith(1, expect.stringContaining('"requestId":"request-one"'));
    expect(info).toHaveBeenNthCalledWith(1, expect.stringContaining('"stage":"smtp-accepted"'));
    expect(info).toHaveBeenNthCalledWith(2, expect.stringContaining('"requestId":"request-two"'));
    expect(info).toHaveBeenNthCalledWith(2, expect.stringContaining('"reason":"no-auth-email-match"'));
  });

  it("reports configuration and SMTP failures on stderr with their failure phase", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logEmail = createEmailSendDiagnosticLogger("password_reset");

    logEmail({ stage: "failed", phase: "configuration", errorType: "EMAIL_CONFIGURATION_ERROR", canRetry: false });
    logEmail({ stage: "failed", phase: "smtp", errorType: "AUTH_FAILED", canRetry: false });

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenNthCalledWith(1, expect.stringContaining('"phase":"configuration"'));
    expect(error).toHaveBeenNthCalledWith(2, expect.stringContaining('"errorType":"AUTH_FAILED"'));
  });

  it("correlates later queue processing through the outbox delivery ID", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logEmail = createEmailSendDiagnosticLogger("email_verification", "delivery-one");

    logEmail({ stage: "skipped", reason: "LIKELY_NOT_DELIVERABLE" });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('"deliveryId":"delivery-one"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"requestId":null'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"reason":"LIKELY_NOT_DELIVERABLE"'));
  });
});
