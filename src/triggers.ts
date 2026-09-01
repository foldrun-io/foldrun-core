// The ways a flow starts that are not a person, a clock or a bare POST.
//
// Four triggers live here, and they share one shape: something happened,
// the flow file said it cares, the happening becomes the first step's task.
//
//   trigger: flow      another flow of this workspace finished (`after:`, `on:`)
//   trigger: storage   a file landed under a storage/ prefix (`path:`)
//   trigger: email     a message arrived at the flow's inbox URL
//   signature:         a webhook delivery must carry a provider's HMAC
//
// None of them evaluates anything. A flow that chains on another does not
// read that run's fields; it receives what the run concluded, as text, and
// an agent reads it — the same rule as every other handoff in the format.

import crypto from "node:crypto";
import { listFlows, readRun, type FlowInfo, type FlowStep, type RunRecord } from "./store.ts";
import { getSecret } from "./secrets.ts";

/** The last step's result — the same reading runner.ts makes, kept local so
 *  this module never imports the runner (the queue imports both). */
function runResult(run: RunRecord): string | null {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const r = run.steps[i].result;
    if (r && r.trim()) return r;
  }
  return null;
}

/** Staple a payload to the first step, the way the run route staples a task. */
export function withTask(steps: FlowStep[], tag: string, body: string): FlowStep[] {
  const text = body.trim();
  if (!text) return steps;
  return steps.map((s, i) => (i === 0 ? { ...s, instruction: `${s.instruction}\n\n<${tag}>\n${text}\n</${tag}>` } : s));
}

// ------------------------------------------------------------ trigger: flow

/** The flows a finished run should start, by this workspace's own files. */
export function chainedFlows(tenant: string, workspace: string, finished: RunRecord): FlowInfo[] {
  if (finished.status !== "completed" && finished.status !== "failed") return [];
  if (finished.flow.startsWith("adhoc:") || finished.flow.startsWith("eval:")) return [];
  return listFlows(tenant, workspace).filter(
    (f) =>
      f.trigger === "flow" &&
      f.after === finished.flow &&
      f.steps.length > 0 &&
      // A flow chained on itself is a loop with no bound — refused here and
      // by foldrun check, never started.
      f.name !== finished.flow &&
      (f.on === "any" || f.on === finished.status),
  );
}

/**
 * Start every flow chained on a run that just settled. The finished run's
 * one-line summary and its final result are the task; the run id rides
 * along so the chained flow can name what it is reacting to. Returns the
 * run ids started. Never throws: a chained flow that cannot start is a
 * logged failure of that flow, not of the run that finished.
 */
export async function fireChainedFlows(tenant: string, workspace: string, finished: RunRecord): Promise<string[]> {
  const flows = chainedFlows(tenant, workspace, finished);
  if (flows.length === 0) return [];
  const { enqueueFlowRun } = await import("./queue.ts");
  const started: string[] = [];
  const result = (runResult(finished) ?? "").slice(0, 20_000);
  const body =
    `run: ${finished.id}\nflow: ${finished.flow}\nstatus: ${finished.status}\n` +
    (finished.summary ? `summary: ${finished.summary}\n` : "") +
    (result ? `\n${result}` : "");
  for (const flow of flows) {
    try {
      const run = await enqueueFlowRun(tenant, workspace, withTask(flow.steps, "previous_run", body), flow.name, flow.model, [
        `after:${finished.flow}`,
      ]);
      started.push(run.id);
      console.log(`[foldrun] trigger: flow — ${tenant}/${workspace}/${flow.name} started after ${finished.flow} ${finished.status}`);
    } catch (err) {
      console.error(`[foldrun] trigger: flow — ${tenant}/${workspace}/${flow.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return started;
}

// --------------------------------------------------------- trigger: storage

/** Does a stored path fall under a flow's `path:` prefix? A prefix names a
 *  folder ("leads/") or a file ("leads/latest.csv"); an empty prefix is all
 *  of storage/. */
export function underPrefix(rel: string, prefix: string | null): boolean {
  const p = (prefix ?? "").replace(/^\/+/, "");
  if (!p) return true;
  return rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`) || (p.endsWith("/") && rel.startsWith(p));
}

/**
 * Start the flows watching a storage prefix that just gained files. `by`
 * says who wrote them: a run's own copy-back (`run:<id>`) must not restart
 * the flow that produced it, or a flow writing to its own trigger folder is
 * a loop — every other writer counts.
 */
export async function fireStorageTriggers(
  tenant: string,
  workspace: string,
  paths: string[],
  by: string,
): Promise<string[]> {
  if (paths.length === 0) return [];
  let flows: FlowInfo[];
  try {
    flows = listFlows(tenant, workspace).filter((f) => f.trigger === "storage" && f.steps.length > 0);
  } catch {
    return [];
  }
  if (flows.length === 0) return [];
  const writerFlow = by.startsWith("run:") ? readRun(tenant, workspace, by.slice(4))?.flow ?? null : null;
  const { enqueueFlowRun } = await import("./queue.ts");
  const started: string[] = [];
  for (const flow of flows) {
    if (writerFlow === flow.name) continue;
    const hits = paths.filter((p) => underPrefix(p, flow.path));
    if (hits.length === 0) continue;
    try {
      const body = `by: ${by}\n${hits.map((h) => `- storage/${h}`).join("\n")}`;
      const run = await enqueueFlowRun(tenant, workspace, withTask(flow.steps, "storage_event", body), flow.name, flow.model, [
        "storage",
      ]);
      started.push(run.id);
    } catch (err) {
      console.error(`[foldrun] trigger: storage — ${tenant}/${workspace}/${flow.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return started;
}

// ------------------------------------------------------ signed webhooks

export interface SignatureVerdict {
  ok: boolean;
  reason: string;
  /** Slack's url_verification handshake: answer with this and start nothing. */
  challenge?: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Check a webhook delivery against the flow's declared `signature:`. The
 * secret's VALUE is read here, host-side, from the vault; the flow file only
 * ever names it. Each provider signs differently, and the four supported
 * are exactly the four whose scheme is documented and stable:
 *
 *   github  X-Hub-Signature-256: sha256=HMAC(body)
 *   stripe  Stripe-Signature: t=<ts>,v1=HMAC(`${ts}.${body}`), ±5 min
 *   slack   X-Slack-Signature: v0=HMAC(`v0:${ts}:${body}`), ±5 min,
 *           plus the url_verification challenge Slack sends when the URL
 *           is first saved — answered, not run
 *   hmac    X-Signature: hex HMAC(body) — for anything you sign yourself
 */
export function verifyWebhookSignature(
  tenant: string,
  workspace: string,
  flow: FlowInfo,
  rawBody: string,
  header: (name: string) => string | null,
  now = Date.now(),
): SignatureVerdict {
  if (!flow.signature) return { ok: true, reason: "no signature required" };
  if (!flow.signingSecret) return { ok: false, reason: `signature: ${flow.signature} needs signing_secret: \${NAME}` };
  const secret = getSecret(tenant, flow.signingSecret, workspace);
  if (!secret) return { ok: false, reason: `signing secret ${flow.signingSecret} is not set` };
  const hmac = (data: string) => crypto.createHmac("sha256", secret.value).update(data).digest("hex");
  const fresh = (ts: number) => Math.abs(now / 1000 - ts) <= 300;

  switch (flow.signature) {
    case "github": {
      const sig = header("x-hub-signature-256") ?? "";
      const ok = sig.startsWith("sha256=") && safeEqual(sig.slice(7), hmac(rawBody));
      return { ok, reason: ok ? "github signature verified" : "X-Hub-Signature-256 did not match" };
    }
    case "stripe": {
      const sig = header("stripe-signature") ?? "";
      const parts = Object.fromEntries(sig.split(",").map((p) => p.trim().split("=") as [string, string]));
      const ts = Number(parts.t);
      if (!Number.isFinite(ts) || !parts.v1) return { ok: false, reason: "Stripe-Signature is missing t= or v1=" };
      if (!fresh(ts)) return { ok: false, reason: "Stripe-Signature timestamp is outside the 5-minute window" };
      const ok = safeEqual(parts.v1, hmac(`${ts}.${rawBody}`));
      return { ok, reason: ok ? "stripe signature verified" : "Stripe-Signature v1 did not match" };
    }
    case "slack": {
      // The handshake is unsigned in effect — Slack signs it, but a URL that
      // cannot answer it is never saved, so answer before anything else.
      try {
        const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string };
        if (parsed?.type === "url_verification" && typeof parsed.challenge === "string") {
          return { ok: true, reason: "slack url_verification", challenge: parsed.challenge };
        }
      } catch {
        // not JSON — an ordinary signed delivery (form-encoded slash command)
      }
      const ts = Number(header("x-slack-request-timestamp"));
      const sig = header("x-slack-signature") ?? "";
      if (!Number.isFinite(ts)) return { ok: false, reason: "X-Slack-Request-Timestamp is missing" };
      if (!fresh(ts)) return { ok: false, reason: "X-Slack-Request-Timestamp is outside the 5-minute window" };
      const ok = sig.startsWith("v0=") && safeEqual(sig.slice(3), hmac(`v0:${ts}:${rawBody}`));
      return { ok, reason: ok ? "slack signature verified" : "X-Slack-Signature did not match" };
    }
    case "hmac": {
      const sig = (header("x-signature") ?? "").replace(/^sha256=/, "");
      const ok = safeEqual(sig, hmac(rawBody));
      return { ok, reason: ok ? "signature verified" : "X-Signature did not match" };
    }
  }
  return { ok: false, reason: `unknown signature scheme ${String(flow.signature)}` };
}

// --------------------------------------------------------- trigger: email

export interface InboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * One shape out of the several inbound-email services post. JSON bodies
 * (Resend, Postmark, Cloudflare Email Workers, anything hand-rolled) and
 * form-encoded ones (Mailgun, SendGrid's inbound parse) both reduce to
 * from / to / subject / text; HTML is stripped to text when that is all
 * there is. Null when nothing in the body looks like a message.
 */
export function normaliseInboundEmail(contentType: string | null, raw: string): InboundEmail | null {
  let fields: Record<string, unknown> = {};
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/json") || raw.trim().startsWith("{")) {
    try {
      fields = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    // Resend wraps the message in `data`; Postmark and others do not.
    if (fields.data && typeof fields.data === "object") fields = { ...fields, ...(fields.data as object) };
  } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    if (ct.includes("multipart/form-data")) {
      // SendGrid's inbound parse is multipart; the parts we need are plain
      // text fields, so a minimal reader is enough and avoids a dependency.
      const boundary = ct.match(/boundary=("?)([^";]+)\1/)?.[2];
      if (!boundary) return null;
      for (const part of raw.split(`--${boundary}`)) {
        const m = part.match(/name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n$/);
        if (m) fields[m[1]] = m[2];
      }
    } else {
      for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;
    }
  } else {
    return null;
  }
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = fields[n];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length && typeof v[0] === "string") return v.join(", ");
      if (v && typeof v === "object" && typeof (v as { email?: unknown }).email === "string") {
        return String((v as { email: string }).email);
      }
    }
    return "";
  };
  const from = pick("from", "From", "sender", "FromFull", "envelope_from");
  const subject = pick("subject", "Subject");
  const html = pick("html", "HtmlBody", "body-html");
  const text =
    pick("text", "TextBody", "body-plain", "stripped-text", "plain") ||
    html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!from && !subject && !text) return null;
  return { from, to: pick("to", "To", "recipient", "ToFull"), subject, text };
}

/** The task an inbound email becomes. */
export function emailTask(mail: InboundEmail): string {
  return `from: ${mail.from}\nto: ${mail.to}\nsubject: ${mail.subject}\n\n${mail.text}`.slice(0, 20_000);
}
