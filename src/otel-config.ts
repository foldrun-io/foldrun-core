// `telemetry:` as written in AGENTS.md — read, checked and its header
// secrets filled. No node imports: the dashboard's settings form reads it
// in the browser. The trace itself is otel.ts.

export interface TelemetryConfig {
  /** Where the trace is POSTed: the collector's OTLP/HTTP traces URL. */
  endpoint: string;
  /** Header name → value; a value written `${NAME}` is a vault secret's name. */
  headers: Record<string, string>;
}

const SECRET_REF = /^\$\{([A-Z][A-Z0-9_]{1,63})\}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** The block as written, and what is wrong with it in words. */
export function parseTelemetry(raw: unknown): { config: TelemetryConfig | null; problems: string[] } {
  if (raw === undefined || raw === null) return { config: null, problems: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config: null, problems: ["telemetry: is a block — otlp: <https URL of the collector's /v1/traces>, and headers:"] };
  }
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (k !== "otlp" && k !== "headers") problems.push(`telemetry: ${k} — not a key; the keys are otlp and headers`);
  const endpoint = typeof o.otlp === "string" ? o.otlp.trim() : "";
  let url: URL | null = null;
  try {
    url = endpoint ? new URL(endpoint) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") problems.push(`telemetry: otlp ${endpoint || "(missing)"} — an https:// URL, the collector's OTLP/HTTP traces endpoint (…/v1/traces)`);
  const headers: Record<string, string> = {};
  if (o.headers !== undefined) {
    if (!o.headers || typeof o.headers !== "object" || Array.isArray(o.headers)) problems.push("telemetry: headers is a block of name: value");
    else {
      for (const [name, value] of Object.entries(o.headers as Record<string, unknown>)) {
        if (!HEADER_NAME.test(name)) problems.push(`telemetry: header "${name}" — letters, digits and dashes`);
        else if (typeof value !== "string" || !value.trim()) problems.push(`telemetry: header ${name} — a value, or \${SECRET_NAME} for one in the vault`);
        else if (!SECRET_REF.test(value.trim()) && /token|key|secret|auth/i.test(name)) {
          problems.push(`telemetry: header ${name} is written into the file — put it in the vault (foldrun secrets set NAME) and write \${NAME}`);
        } else headers[name.toLowerCase()] = value.trim();
      }
    }
  }
  return { config: problems.length ? null : { endpoint, headers }, problems };
}

/** The vault secrets a config's headers name. */
export function telemetrySecretNames(cfg: TelemetryConfig): string[] {
  return Object.values(cfg.headers).map((v) => SECRET_REF.exec(v)?.[1]).filter((n): n is string => !!n);
}

/** Header values with each `${NAME}` filled by `lookup`; the names it could not fill. */
export function telemetryHeaders(cfg: TelemetryConfig, lookup: (name: string) => string | null): { headers: Record<string, string>; missing: string[] } {
  const headers: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(cfg.headers)) {
    const ref = SECRET_REF.exec(v)?.[1];
    if (!ref) headers[k] = v;
    else {
      const value = lookup(ref);
      if (value === null) missing.push(ref);
      else headers[k] = value;
    }
  }
  return { headers, missing };
}
