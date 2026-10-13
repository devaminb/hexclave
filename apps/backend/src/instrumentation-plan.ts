type BackendInstrumentationPlanOptions = {
  ci: string,
  googleCloudTraceSampleRate: string,
  nodeEnvironment: string,
  otelResourceAttributes: string,
  otlpEndpoint: string,
  otlpTracesEndpoint: string,
  portPrefix: string,
  sentryDsn: string,
  sentryTracesSampleRate: number,
};

export type GoogleCloudTracePlan = {
  projectId: string,
  sampleRate: number,
};

export type BackendInstrumentationPlan = {
  googleCloudTrace: GoogleCloudTracePlan | undefined,
  otlpTracesEndpoint: string | undefined,
  sentryEnabled: boolean,
  tracesSampleRate: number,
};

export function createBackendInstrumentationPlan(options: BackendInstrumentationPlanOptions): BackendInstrumentationPlan {
  if (options.ci !== "") {
    return {
      googleCloudTrace: undefined,
      otlpTracesEndpoint: undefined,
      sentryEnabled: false,
      tracesSampleRate: 0,
    };
  }

  // Matches the pre-Elysia @sentry/nextjs gating: Sentry was enabled whenever the DSN
  // was set and we were neither in development nor in CI (CI is short-circuited above).
  // An exact-match on "production" would be too narrow — a self-hoster or staging deploy
  // with a custom NODE_ENV (e.g. "staging", "preview") would silently drop all error
  // reporting. We additionally exclude "test" so test runs never report to Sentry.
  const sentryEnabled = options.sentryDsn !== ""
    && options.nodeEnvironment !== "development"
    && options.nodeEnvironment !== "test";
  const configuredOtlpTracesEndpoint = options.otlpTracesEndpoint.trim();
  const configuredOtlpEndpoint = options.otlpEndpoint.trim();
  const otlpTracesEndpoint = configuredOtlpTracesEndpoint !== ""
    ? validateOtlpEndpoint("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", configuredOtlpTracesEndpoint)
    : configuredOtlpEndpoint !== ""
      ? appendTracesPath(validateOtlpEndpoint("OTEL_EXPORTER_OTLP_ENDPOINT", configuredOtlpEndpoint))
      : options.nodeEnvironment === "development"
        ? `http://localhost:${options.portPrefix}31/v1/traces`
        : undefined;

  const googleCloudTrace = createGoogleCloudTracePlan(options.googleCloudTraceSampleRate, options.otelResourceAttributes);

  return {
    googleCloudTrace,
    otlpTracesEndpoint,
    sentryEnabled,
    // Sentry owns the one global provider. A non-Sentry destination still needs
    // sampled spans so its additional processor receives real data. Cloud Trace
    // applies its own trace-ID ratio on top of this provider-level decision, so
    // its effective rate is sentryTracesSampleRate * its sample rate when Sentry
    // is enabled.
    tracesSampleRate: sentryEnabled
      ? options.sentryTracesSampleRate
      : otlpTracesEndpoint == null && googleCloudTrace == null ? 0 : 1,
  };
}

function createGoogleCloudTracePlan(sampleRateValue: string, otelResourceAttributes: string): GoogleCloudTracePlan | undefined {
  if (sampleRateValue.trim() === "") {
    return undefined;
  }
  const sampleRate = Number(sampleRateValue);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
    throw new Error(`HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE must be a number in (0, 1], got: ${JSON.stringify(sampleRateValue)}`);
  }
  // Google's Telemetry API rejects spans whose resource lacks gcp.project_id.
  // Sentry builds the global provider's resource from OTEL_RESOURCE_ATTRIBUTES,
  // so that env var is the only way to put the attribute on every span; reading
  // the project ID from it too keeps a single source of truth.
  const projectId = parseOtelResourceAttributes(otelResourceAttributes).get("gcp.project_id");
  if (projectId == null || projectId === "") {
    throw new Error("HEXCLAVE_GOOGLE_CLOUD_TRACE_SAMPLE_RATE is set, but OTEL_RESOURCE_ATTRIBUTES does not contain gcp.project_id (e.g. OTEL_RESOURCE_ATTRIBUTES=gcp.project_id=my-project,service.name=hexclave-backend)");
  }
  return { projectId, sampleRate };
}

function parseOtelResourceAttributes(value: string): Map<string, string> {
  // Format per the OpenTelemetry spec: comma-separated key=value pairs with
  // percent-encoded values.
  const attributes = new Map<string, string>();
  for (const pair of value.split(",")) {
    if (pair.trim() === "") {
      continue;
    }
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES contains an entry without "=": ${JSON.stringify(pair)}`);
    }
    attributes.set(pair.slice(0, separatorIndex).trim(), decodeURIComponent(pair.slice(separatorIndex + 1).trim()));
  }
  return attributes;
}

function validateOtlpEndpoint(environmentVariableName: string, value: string) {
  // A bare `new URL(value)` throws TypeError("Invalid URL") without naming the source,
  // which is useless during a boot crash-loop — the operator can't tell which env var is
  // malformed. This narrow try/catch is NOT error swallowing: it rethrows immediately
  // (fail early, fail loud), just with the env var name and offending value attached.
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${environmentVariableName} is not a valid URL: ${JSON.stringify(value)}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${environmentVariableName} must use HTTP or HTTPS, got: ${JSON.stringify(url.protocol)}`);
  }
  return url.toString();
}

function appendTracesPath(value: string) {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`;
  return url.toString();
}
