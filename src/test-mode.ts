// Test mode: a run that exercises everything and changes nothing outside.
//
// Every desk that sends — email, SMS, orders, posts — grew its own test
// switch inside its own script: a `test_to` address here, a `mode: test`
// there. On 2026-09-14 a send step edited its own gate file to get past a
// script's guard and texted 25 customers. A guard the script can reach is a
// guard the script can move; this one lives where the script cannot: on the
// run record, at the egress proxy, and in what the sandbox is handed.
//
// The rule has one table (below) so it is testable without a server, and
// three enforcement points that all read it:
//
//   - the egress proxy: on a test lease, an outward write to a host that is
//     not read-safe or a model provider is refused with 403 and a JSON body
//     naming what would have been sent; Resend's sink address is the one
//     exception, so a desk still gets a real message id back
//   - the runner: send-capable secrets never enter the sandbox as values on
//     a test run; the env var says TEST_MODE_WITHHELD instead, so a script
//     that forgot to check fails at the provider with an auth error
//   - the write-back: state/ and storage/ go INTO the sandbox as usual and
//     come out into runs/<id>/test-writes/ instead of the real directories
//
// Nothing here weakens a live run: every function is a no-op unless the run
// says `test: true`.

import fs from "node:fs";
import path from "node:path";

/** Where a test run's email actually goes — Resend's delivered sink. */
export const TEST_SINK_EMAIL = "delivered@resend.dev";
/** Prefixed to every subject a test run sends, so the sink is readable. */
export const TEST_SUBJECT_PREFIX = "[TEST] ";
/** What a withheld secret's env var reads as inside the sandbox. */
export const WITHHELD = "TEST_MODE_WITHHELD";
/** Both are set to "1" in a test run's sandbox: the first is what a script
 *  checks, the second is the run-level spelling for verifies and flows. */
export const TEST_MODE_ENV = "FOLDRUN_TEST_MODE";
export const RUN_TEST_ENV = "FOLDRUN_RUN_TEST";
/** Under runs/<id>/, where diverted state/ and storage/ writes land. */
export const TEST_WRITES_DIR = "test-writes";
/** The workspace directories a test run may not write for real. */
export const TEST_DIVERTED_DIRS = ["state", "storage"] as const;

/** What a test run did instead of the real thing — one per intervention,
 *  on the run event that reports it, so the run page can list them. */
export interface TestEffect {
  kind: "refused" | "redirected" | "diverted" | "withheld";
  host?: string;
  method?: string;
  path?: string;
  summary: string;
}

// ---------------------------------------------------------------- secrets

/**
 * Secret names that can make something happen outside. Matched by name
 * because the name is all the runner knows before the value is used: the
 * vault does not say what a key can do, and the provider hosts are only
 * known for http tools, not for the scripts these are withheld from.
 */
export const SEND_CAPABLE_SECRETS: RegExp[] = [
  /^RESEND_API_KEY$/,
  /^TWILIO_/,
  /^GETREACH_API_KEY$/,
  /^GITHUB_TOKEN$/,
  /^MONDAY_API_TOKEN$/,
  /^OI_CRM_API_KEY$/,
  /^CLOUDFLARE_/,
  /^LINKEDIN_/,
  /^MEDIUM_COOKIES$/,
  /^TIKTOK_/,
];

export function isSendCapableSecret(name: string): boolean {
  return SEND_CAPABLE_SECRETS.some((re) => re.test(name));
}

/**
 * The secrets a test-run sandbox is handed, and which were withheld.
 *
 * `outward` — the step grants a script tool whose file says `outward: true`:
 * then every secret is withheld, because a tool that declared itself a
 * sender is not one to hand anything real. `allow` — a script tool said
 * `test_mode: allow` (a reader that happens to use a listed key): the list
 * is not applied. Outward wins over allow, because a step that has both
 * has a sender in it.
 */
export function withholdSecrets(
  secrets: Record<string, string>,
  opts: { outward?: boolean; allow?: boolean } = {},
): { env: Record<string, string>; withheld: string[] } {
  const env: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    const hold = opts.outward || (!opts.allow && isSendCapableSecret(name));
    env[name] = hold ? WITHHELD : value;
    if (hold) withheld.push(name);
  }
  return { env, withheld };
}

// ---------------------------------------------------------------- the proxy

/** Methods that read. Anything else is a write until the host says otherwise. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Hosts an outward write may reach on a test run: model providers (the run
 * cannot happen without them, and nothing there is a send), and read-only
 * services whose POSTs are queries. A host is matched exactly, or by a
 * leading `*.` for its subdomains. The list is deliberately short — the
 * default is refusal, and a host earns its place here by having no way to
 * reach a customer.
 */
export const READ_SAFE_HOSTS: string[] = [
  // model providers
  "api.anthropic.com",
  "openrouter.ai",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.deepseek.com",
  "api.x.ai",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "api.perplexity.ai",
  "*.openai.azure.com",
  // queries that are POSTs
  "api.dataforseo.com",
  "*.dataforseo.com",
  "*.svc.cluster.local",
];

export function isReadSafeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return READ_SAFE_HOSTS.some((rule) =>
    rule.startsWith("*.") ? h.endsWith(rule.slice(1)) && h !== rule.slice(2) : h === rule,
  );
}

export type TestPolicy =
  | { action: "allow" }
  | { action: "refuse" }
  | { action: "rewrite"; rewrite: "resend-email" };

/**
 * What the proxy does with one request on a test lease. Pure: method, host
 * and path in, a verdict out. Reads always pass — a test run has to be able
 * to look at the world it is not allowed to change.
 */
export function testPolicy(method: string, host: string, path: string): TestPolicy {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return { action: "allow" };
  const h = host.toLowerCase().replace(/:\d+$/, "");
  // Resend's sink: the message really goes out, to an address that keeps
  // it, with the subject marked — so the desk sees a real id and a real
  // 200, and nobody receives anything.
  if (h === "api.resend.com" && /^\/emails(\/|$|\?)/.test(path)) return { action: "rewrite", rewrite: "resend-email" };
  if (isReadSafeHost(h)) return { action: "allow" };
  return { action: "refuse" };
}

/**
 * A Resend `POST /emails` body with its recipients pointed at the sink and
 * the subject marked. Returns the recipients it replaced, for the trace.
 * Null when the body is not a JSON object — then there is nothing safe to
 * rewrite, and the caller refuses instead.
 */
export function rewriteResendEmail(body: string): { body: string; to: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const mail = parsed as Record<string, unknown>;
  const to: string[] = [];
  for (const field of ["to", "cc", "bcc"] as const) {
    const v = mail[field];
    if (v === undefined || v === null) continue;
    for (const addr of Array.isArray(v) ? v : [v]) to.push(String(addr));
    // One sink address for the lot: two copies of the same test mail teach
    // nobody anything, and cc/bcc to the sink would be exactly that.
    if (field === "to") mail[field] = [TEST_SINK_EMAIL];
    else delete mail[field];
  }
  if (!Array.isArray(mail.to) || mail.to.length === 0) mail.to = [TEST_SINK_EMAIL];
  const subject = typeof mail.subject === "string" ? mail.subject : "";
  mail.subject = subject.startsWith(TEST_SUBJECT_PREFIX) ? subject : `${TEST_SUBJECT_PREFIX}${subject}`;
  return { body: JSON.stringify(mail), to };
}

/** The first `max` characters of a body, whitespace collapsed — enough to
 *  say what would have gone out, not enough to be the thing itself. The
 *  caller redacts; this only cuts. */
export function bodySummary(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** The recipient field of a body, if it has one — for `would_have.to`. */
export function recipientsOf(body: string): string | string[] | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const key of ["to", "To", "recipient", "phone", "email"]) {
        const v = parsed[key];
        if (typeof v === "string" || Array.isArray(v)) return v as string | string[];
      }
    }
  } catch {
    // a form body: Twilio's Messages endpoint
    const m = body.match(/(?:^|&)To=([^&]*)/);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, " "));
  }
  return null;
}

/** The 403 a refused write is answered with. JSON, so a script that parses
 *  the error sees `test_mode` and can say so instead of retrying. */
export function refusalBody(method: string, host: string, path: string, body: string): string {
  return JSON.stringify({
    test_mode: true,
    error: { type: "test_mode", message: `test run: ${method} ${host}${path} refused — nothing was sent` },
    would_have: { method, host, path, to: recipientsOf(body), body: bodySummary(body) },
  });
}

// ---------------------------------------------------------------- write-back

/** Is this workspace-relative path one a test run diverts? */
export function isDivertedPath(rel: string): boolean {
  const norm = rel.replaceAll("\\", "/");
  return TEST_DIVERTED_DIRS.some((d) => norm === d || norm.startsWith(`${d}/`));
}

/** The line the trace and the run page show for one diverted write. */
export function divertedSummary(rel: string, was: Buffer | null, next: Buffer): string {
  if (was === null) return `would have created ${rel} (${next.length} bytes)`;
  const before = was.toString("utf8").split("\n").length;
  const after = next.toString("utf8").split("\n").length;
  const delta = after - before;
  return `would have written ${rel}${delta > 0 ? `, +${delta} line${delta === 1 ? "" : "s"}` : delta < 0 ? `, ${delta} lines` : ""}`;
}

/**
 * The in-process path has no copy-in and copy-out — a step writes the
 * workspace directly — so a test run there snapshots state/ and storage/
 * before the step and, after it, moves what changed under the run and
 * puts the originals back. Same outcome as the sandbox's divert, reached
 * from the other side. Used by `foldrun run --test`.
 */
export function snapshotDivertedDirs(wsRoot: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const dir of TEST_DIVERTED_DIRS) {
    const root = path.join(wsRoot, dir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = path.join(entry.parentPath ?? entry.path, entry.name);
      snap.set(path.relative(wsRoot, abs).replaceAll("\\", "/"), fs.readFileSync(abs));
    }
  }
  return snap;
}

/** Undo a step's writes to the diverted directories, keeping each changed
 *  or new file under `to` by its workspace-relative path. Deletions are
 *  undone too — the original is put back. Returns what was set aside. */
export function restoreDivertedDirs(
  wsRoot: string,
  before: Map<string, Buffer>,
  to: string,
  note: (rel: string, summary: string) => void,
): string[] {
  const now = snapshotDivertedDirs(wsRoot);
  const aside: string[] = [];
  for (const [rel, next] of now) {
    const was = before.get(rel) ?? null;
    if (was && was.equals(next)) continue;
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, next);
    aside.push(rel);
    note(rel, divertedSummary(rel, was, next));
    if (was) fs.writeFileSync(path.join(wsRoot, rel), was);
    else fs.rmSync(path.join(wsRoot, rel), { force: true });
  }
  for (const [rel, was] of before) {
    if (now.has(rel)) continue;
    fs.mkdirSync(path.dirname(path.join(wsRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, rel), was);
    note(rel, `would have deleted ${rel}`);
    aside.push(rel);
  }
  return aside;
}

/** `[test] ` in front of a headline, once. */
export function testHeadline(summary: string): string {
  return summary.startsWith("[test]") ? summary : `[test] ${summary}`;
}

/** The env every test-run sandbox gets, beside its secrets. */
export function testModeEnv(): Record<string, string> {
  return { [TEST_MODE_ENV]: "1", [RUN_TEST_ENV]: "1" };
}
