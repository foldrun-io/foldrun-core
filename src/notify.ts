// Telling a person what their agents did while they were not looking.
//
// An agent that runs when the laptop is closed needs a way to say "I
// finished", "I failed", and above all "I am waiting for you" — a parked
// approval nobody hears about is a run that never happens. The channel is a
// webhook out: one URL, declared in AGENTS.md frontmatter, POSTed a small
// JSON body. Slack, Discord, ntfy, a phone-push relay and a plain inbox
// service all speak that; building any one of them natively would just be
// this plus vendor formatting.
//
//   notify:
//     url: ${SLACK_WEBHOOK_URL}       # a secret name, or a literal URL
//     events: [failed, awaiting-approval, completed, blocked]
//
// Or, for people who live in an inbox rather than a channel:
//
//   notify:
//     email: ops@example.com          # sent via the RESEND_API_KEY connection
//     events: [failed, completed]
//
// Email is the one vendor worth speaking natively: the platform already
// holds a Resend connection for its email tool, and "just email me" is the
// notification default for most of the world. Everything else stays a
// webhook — one URL covers Slack, Discord, ntfy and every relay.
//
// Workspace config replaces account config whole, like provider: — a URL is
// a destination, and merging two destinations sends half your alerts to a
// channel you stopped reading.
//
// Defaults: failed and awaiting-approval. Completed is opt-in — a schedule
// that works is the quiet kind of good news, and a channel that pings on
// every success gets muted, which un-pings the failures too.

import crypto from "node:crypto";
import { readAgentsMd } from "./runner.ts";
import { accountDir, workspaceDir, runCost, readFlow, runVerdict, type RunRecord } from "./store.ts";
import { getSecret } from "./secrets.ts";
import { publicUrl } from "./webhook.ts";
import { approveLinkPath, approveLinkTtlMs } from "./approvals.ts";
import { noteSecretUse, healthKey } from "./secret-health.ts";
import { fetchUntrusted } from "./untrusted-fetch.ts";
import { platform } from "./platform.ts";
import { sendMail, type MailCategory } from "./mail.ts";

/**
 * The platform's own mail: an invite, a password reset, a low balance.
 *
 * An account that configured its own mail — RESEND_API_KEY and EMAIL_FROM
 * on the account — gets ALL of its mail from that sender, these included:
 * a business that sends from its own domain does not want a second, foreign
 * address turning up in its people's inboxes (2026-09-17, an owner found
 * foldrun.io mail beside their own and asked for none of it). Only an
 * account with no sender of its own falls to the platform's key and sender
 * (FOLDRUN_RESEND_API_KEY, FOLDRUN_EMAIL_FROM), so invites still work
 * before anyone has set mail up.
 */
export function platformMail(tenant: string): { key: string; from: string } | null {
  const own = accountMail(tenant);
  if (own && getSecret(tenant, "EMAIL_FROM")?.value?.trim()) return own;
  const key = process.env.FOLDRUN_RESEND_API_KEY;
  if (key) return { key, from: process.env.FOLDRUN_EMAIL_FROM || "foldrun <hello@foldrun.io>" };
  return own;
}

/** The account's own Resend key and sender, or null when it has none. */
export function accountMail(tenant: string): { key: string; from: string } | null {
  const own = getSecret(tenant, "RESEND_API_KEY");
  if (!own) return null;
  const from = getSecret(tenant, "EMAIL_FROM")?.value?.trim() || "foldrun <onboarding@resend.dev>";
  return { key: own.value, from };
}

/**
 * A run notification is the account's mail, not the platform's: it is a
 * desk telling its owner what it found, and the owner chose the sender —
 * their RESEND_API_KEY and EMAIL_FROM on the account, the same connection
 * their agents' `email` tool uses. So it comes from the address they
 * expect, under their own domain's reputation and their own inbox rules;
 * 2026-09-06, every notification from the platform's address was in the
 * owner's bin. The platform's key is the fallback for an account that set
 * none, so `notify:` works before anyone has configured mail at all.
 */
export function notifyMail(tenant: string): { key: string; from: string } | null {
  return accountMail(tenant) ?? platformMail(tenant);
}

/** Was the mail sent on the account's own key? Only then is a refusal from
 *  Resend a fact about a secret the account holds. Recording a platform-key
 *  failure against a RESEND_API_KEY the account does not have would send
 *  them to rotate a key that does not exist. */
function noteMailUse(tenant: string, status: number): void {
  if (accountMail(tenant)) noteSecretUse(tenant, healthKey("RESEND_API_KEY", "account"), { host: "api.resend.com", status });
}

export interface NotifyConfig {
  url?: string;
  email?: string;
  events: string[];
  /** `signing_secret:` — the NAME of a vault secret, never its value. With
   *  one, every webhook carries an HMAC of the body it delivers, so the
   *  receiver can tell a real notification from anyone who learned the URL.
   *  Inbound hooks have verified a signature since they existed; a delivery
   *  going the other way is the same problem in the same shape. */
  signingSecret?: string;
}

const DEFAULT_EVENTS = ["failed", "awaiting-approval"];

export function notifyConfig(tenant: string, workspace: string): NotifyConfig | null {
  const raw =
    (readAgentsMd(workspaceDir(tenant, workspace))?.data.notify as unknown) ??
    (readAgentsMd(accountDir(tenant))?.data.notify as unknown);
  if (!raw) return null;
  if (typeof raw === "string") {
    // A bare string is whichever destination it looks like.
    return raw.includes("@") && !raw.includes("/")
      ? { email: raw, events: DEFAULT_EVENTS }
      : { url: raw, events: DEFAULT_EVENTS };
  }
  if (typeof raw === "object" && raw !== null) {
    const o = raw as { url?: unknown; email?: unknown; events?: unknown; signing_secret?: unknown };
    const url = typeof o.url === "string" ? o.url : undefined;
    const email = typeof o.email === "string" ? o.email : undefined;
    if (!url && !email) return null;
    return {
      url,
      email,
      events: Array.isArray(o.events) && o.events.length ? o.events.map(String) : DEFAULT_EVENTS,
      signingSecret:
        typeof o.signing_secret === "string" ? o.signing_secret.trim().replace(/^\$\{|\}$/g, "") || undefined : undefined,
    };
  }
  return null;
}

// Said once per process, not once per run: the fix is one env edit, and a
// line per parked run would bury the failures around it.
let warnedNoPublicUrl = false;

/**
 * The headers that prove a delivery came from this install.
 *
 * `x-foldrun-signature` is a hex SHA-256 HMAC over "<timestamp>.<body>",
 * keyed by the named vault secret — the timestamp is inside the signed
 * string so a captured delivery cannot be replayed later with a fresh one.
 * `x-signature` is the plain HMAC of the body beside it, the scheme the
 * inbound `signature: hmac` verifies.
 *
 * No secret named, no headers: signing is opt-in, and a receiver that does
 * not check one is no worse off than before.
 */
export function signatureHeaders(
  tenant: string,
  workspace: string,
  config: NotifyConfig,
  body: string,
): Record<string, string> {
  if (!config.signingSecret) return {};
  const secret = getSecret(tenant, config.signingSecret, workspace);
  if (!secret) {
    console.error(
      `[foldrun] notify: signing_secret names ${config.signingSecret}, which is not in the vault for ${tenant}/${workspace} — sending unsigned`,
    );
    return {};
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const mac = crypto.createHmac("sha256", secret.value).update(`${timestamp}.${body}`).digest("hex");
  // Two headers. `x-foldrun-signature` is the timestamped one, and what a
  // receiver should check. `x-signature` is the plain HMAC of the body,
  // which is what the inbound `signature: hmac` verifies — so a foldrun
  // notification pointed at another foldrun webhook flow is accepted, and
  // any receiver written against the plain scheme keeps working.
  const plain = crypto.createHmac("sha256", secret.value).update(body).digest("hex");
  return { "x-foldrun-timestamp": timestamp, "x-foldrun-signature": `sha256=${mac}`, "x-signature": plain };
}

// ------------------------------------------------------------ deliveries
//
// A webhook used to be one POST with a timeout: a receiver that was down
// for the minute a run failed never heard about it, and nothing anywhere
// said so. Now every send is a DELIVERY with an id, attempted here and —
// on a platform — retried from the worker on the backoff below, each
// attempt recorded (webhook-deliveries.ts in the platform).

/** When each attempt is made, counted from the one before: at once, then
 *  1m, 5m, 30m, 2h and 6h. Six attempts over about eight and a half hours,
 *  then the delivery is given up and stays in the log to be redelivered. */
export const WEBHOOK_BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000] as const;

/** When attempt `n + 1` is due after attempt `n` (1-based) failed at
 *  `at`, or null when `n` was the last. */
export function nextAttemptAt(n: number, at: number): number | null {
  return n < WEBHOOK_BACKOFF_MS.length ? at + WEBHOOK_BACKOFF_MS[n] : null;
}

/** The delivery id: sent as X-Foldrun-Delivery on every attempt of one
 *  delivery, redeliveries included, so a receiver dedupes on it. */
export function newDeliveryId(): string {
  return `dlv_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The URL with ${SECRET}s resolved, and how it may be shown: a Slack hook
 *  URL is itself a credential, so it is never echoed resolved. */
export function webhookTarget(tenant: string, workspace: string, config: NotifyConfig | null = notifyConfig(tenant, workspace)): { url: string | null; shown: string } {
  const raw = config?.url ?? "";
  const url = raw.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
    const hit = getSecret(tenant, name, workspace);
    return hit ? hit.value : whole;
  });
  const shown = raw.includes("${") ? raw : raw ? `${raw.slice(0, 40)}${raw.length > 40 ? "…" : ""}` : "none";
  return { url: !url || url.includes("${") ? null : url, shown };
}

export interface WebhookAttempt {
  /** 1-based. */
  n: number;
  at: string;
  /** The receiver's status, or null when none came back (a timeout, DNS). */
  statusCode: number | null;
  durationMs: number;
  /** The first 500 characters of what the receiver answered. */
  response: string | null;
  error: string | null;
  /** A person pressed redeliver or test; not part of the backoff. */
  manual?: boolean;
}

/**
 * One attempt at one delivery, against the workspace's notify: as it reads
 * NOW — a URL fixed between attempts is the one the retry goes to. Signed
 * afresh each time (the timestamp is inside the signature, so a stale
 * signature is one a receiver should refuse). Never throws.
 */
export async function attemptWebhook(
  tenant: string,
  workspace: string,
  d: { id: string; event: string; body: string; attempt: number; manual?: boolean },
): Promise<WebhookAttempt & { ok: boolean }> {
  const at = new Date().toISOString();
  const started = Date.now();
  const config = notifyConfig(tenant, workspace);
  const base = { n: d.attempt, at, ...(d.manual ? { manual: true } : {}) };
  if (!config?.url) {
    return { ...base, ok: false, statusCode: null, durationMs: 0, response: null, error: "this workspace's notify: has no url any more" };
  }
  const { url } = webhookTarget(tenant, workspace, config);
  if (!url) {
    return { ...base, ok: false, statusCode: null, durationMs: 0, response: null, error: "the secret named in notify.url is not in this account's vault" };
  }
  try {
    const res = await fetchUntrusted(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "foldrun-webhooks/1",
        "x-foldrun-delivery": d.id,
        "x-foldrun-event": d.event,
        "x-foldrun-attempt": String(d.attempt),
        ...signatureHeaders(tenant, workspace, config, d.body),
      },
      body: d.body,
      signal: AbortSignal.timeout(Number(process.env.FOLDRUN_WEBHOOK_TIMEOUT_MS) || 8000),
    });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    return {
      ...base,
      ok: res.ok,
      statusCode: res.status,
      durationMs: Date.now() - started,
      response: text || null,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const why = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
    return { ...base, ok: false, statusCode: null, durationMs: Date.now() - started, response: null, error: why.slice(0, 500) };
  }
}

/** One waiting step's pair of links. */
export interface StepLinks {
  /** Index into run.steps. */
  step: number;
  agent: string;
  approveUrl: string;
  rejectUrl: string;
}

/**
 * The approve/reject links for a run waiting on a person, or null when the
 * install cannot say where it lives. A notification that only says "waiting
 * for you" sends the reader to find a laptop; one that carries the decision
 * lets them make it where they read it.
 *
 * One pair per waiting step, each bound to that step and to a moment (the
 * flow's `approve_within:`, else a week) — see approvals.ts. A link bound
 * to the run alone approved every later gate of the run for as long as it
 * ran. When the notification goes to a named approver — an address in the
 * flow's `approvers:` — the links are bound to that person too, so a
 * forwarded mail decides as nobody. `approveUrl`/`rejectUrl` on the result
 * are the first waiting step's pair, for receivers written against that.
 *
 * The reject link goes to the same page with the choice pre-selected — a
 * GET must not decide anything, because inbox link-checkers follow links.
 */
export function approvalLinks(
  tenant: string,
  workspace: string,
  run: RunRecord,
  /** Who the notification is going to, when it is going to one address. */
  recipient: string | null = null,
): { approveUrl: string; rejectUrl: string; links: StepLinks[] } | null {
  const base = publicUrl();
  if (!base) {
    if (!warnedNoPublicUrl) {
      warnedNoPublicUrl = true;
      console.error(
        "[foldrun] notify: approval links need FOLDRUN_PUBLIC_URL (the install's public origin); sending without them",
      );
    }
    return null;
  }
  const flow = readFlow(tenant, workspace, run.flow);
  const to = (recipient ?? "").trim().toLowerCase();
  const approver = to && flow?.approvers?.includes(to) ? to : null;
  const expiresAt = Date.now() + approveLinkTtlMs(flow);
  const links: StepLinks[] = [];
  run.steps.forEach((s, i) => {
    if (s.status !== "awaiting-approval" || s.waitFor === "event") return;
    const approveUrl = `${base}${approveLinkPath(tenant, workspace, run.id, { step: i, expiresAt, approver })}`;
    links.push({ step: i, agent: s.agent, approveUrl, rejectUrl: `${approveUrl}&decision=reject` });
  });
  if (links.length === 0) return null;
  return { approveUrl: links[0].approveUrl, rejectUrl: links[0].rejectUrl, links };
}

/**
 * Fire the webhook for a run's state, if the workspace asked to hear about
 * it. Failures are logged and swallowed — a broken Slack hook must never
 * fail the run it is reporting on.
 */
/** Flows whose completion is nobody's news: eval cases and adhoc runs. */
export function isQuietFlow(flow: string): boolean {
  return /^(eval|adhoc):/.test(flow);
}

/**
 * A notification that is not about one run finishing.
 *
 * Three things need to say something to the same destination a run
 * notification goes to, and none of them has a RunRecord to hand: a flow
 * that has been quarantined, a run that has outlived its `sla:`, and a
 * budget that is nearly spent. They are the messages a person most needs
 * and least expects, because each one is about something NOT happening —
 * the failure mode that never sends mail is the one that costs a week.
 *
 * The event name is matched against `events:` exactly like a run status,
 * so a workspace that wants none of this writes its own list and gets none
 * of it. They are on by default: an alert nobody opted into is the point.
 */
export async function sendPlainNotification(
  tenant: string,
  workspace: string,
  msg: { event: string; headline: string; detail: string; flow?: string; runId?: string },
): Promise<boolean> {
  const config = notifyConfig(tenant, workspace);
  if (!config) return false;
  // These follow `failed`. Each one IS a failure — a flow that stopped
  // running, a run that has stalled, a budget about to refuse work — that
  // happens to produce no failed run for the normal path to report. A
  // destination hearing about failures hears about these; naming one
  // explicitly also turns it on; leaving `failed` out silences them.
  if (!config.events.includes(msg.event) && !config.events.includes("failed")) return false;

  const body = {
    text: `${msg.headline} — ${msg.detail} · ${workspace}`,
    workspace,
    status: msg.event,
    summary: msg.detail,
    ...(msg.flow ? { flow: msg.flow } : {}),
    ...(msg.runId ? { runId: msg.runId } : {}),
  };
  try {
    if (config.email) {
      const mail = notifyMail(tenant);
      if (!mail) return false;
      const r = await sendMail({
        tenant,
        mail,
        to: config.email,
        category: "run-alerts",
        workspace,
        subject: `${msg.headline}`.slice(0, 160),
        text: `${msg.headline}\n\n${msg.detail}\n\nworkspace: ${workspace}\n${msg.flow ? `flow: ${msg.flow}\n` : ""}${msg.runId ? `run: ${msg.runId}\n` : ""}`,
      });
      return r.ok;
    }
    if (!webhookTarget(tenant, workspace, config).url) return false;
    const r = await platform.deliverWebhook(tenant, workspace, { event: msg.event, body: JSON.stringify(body), retry: true });
    return r.ok;
  } catch (err) {
    console.error(`[foldrun] notify (${msg.event}): ${tenant}/${workspace} →`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Prove the notification path works, now, while someone is looking.
 *
 * Every run notification is sent when nobody is watching, to a destination
 * nobody has tested, through a mail domain nobody has verified. On
 * 2026-09-06 every one of them had been going to a bin for weeks and the
 * only symptom was silence — which is indistinguishable from nothing having
 * gone wrong. An alert that has never been proven to arrive is not an alert.
 *
 * Unlike every other send here, this one reports its failure in full: the
 * provider's own words, which are what actually name the problem ("domain
 * not verified", "you can only send to your own address"). Swallowing them
 * is right for a run notification and useless for a test.
 */
export async function sendTestNotification(
  tenant: string,
  workspace: string,
): Promise<{ ok: boolean; destination: string; detail: string }> {
  const config = notifyConfig(tenant, workspace);
  if (!config) {
    return {
      ok: false,
      destination: "none",
      detail:
        "no notify: in this workspace's AGENTS.md or the account's — nothing would be sent for a failure or a gate either",
    };
  }
  const sent = new Date().toISOString();
  const headline = "\u2713 test notification";
  const detail = `Sent from ${workspace} at ${sent}. If you are reading this, failures and approval gates will reach you here too.`;

  if (config.email) {
    const mail = notifyMail(tenant);
    if (!mail) {
      return {
        ok: false,
        destination: config.email,
        detail:
          "email is configured but there is no mail credential — set RESEND_API_KEY (and EMAIL_FROM) on the account, or FOLDRUN_RESEND_API_KEY on the platform",
      };
    }
    const r = await sendMail({ tenant, mail, to: config.email, category: "run-alerts", workspace, subject: headline, text: `${headline}\n\n${detail}\n` });
    if (r.status !== undefined) noteMailUse(tenant, r.status);
    if (r.suppressed.length && !r.sent.length && !r.error) {
      return {
        ok: false,
        destination: config.email,
        detail: `not sent: ${r.suppressed.join(", ")} turned run alerts off — turn them back on in Profile → Notifications (or by \`foldrun notifications set run-alerts on\`)`,
      };
    }
    return r.ok
      ? { ok: true, destination: `${config.email} (from ${mail.from})`, detail: `accepted by Resend for delivery${r.suppressed.length ? ` — not to ${r.suppressed.join(", ")}, who turned run alerts off` : ""}` }
      : { ok: false, destination: config.email, detail: `${r.status ? `HTTP ${r.status} from Resend — ` : ""}${r.error ?? "not sent"}` };
  }

  // The destination is echoed back with the secret still unresolved: a
  // Slack webhook URL is itself a credential, and a page that prints it is
  // a page that leaks it into a screenshot.
  const { url, shown } = webhookTarget(tenant, workspace, config);
  if (!url) {
    return { ok: false, destination: shown, detail: `the secret named in notify.url is not in this account's vault` };
  }
  const payload = JSON.stringify({ text: `${headline} — ${detail}`, workspace, status: "test", summary: detail });
  // One attempt, recorded in the delivery log like any other — and the way
  // back for an endpoint that was switched off after days of failures: a
  // test that is accepted turns it on again.
  const r = await platform.deliverWebhook(tenant, workspace, { event: "test", body: payload, retry: false });
  return r.ok
    ? {
        ok: true,
        destination: shown,
        detail: `${config.signingSecret ? "accepted, signed with " + config.signingSecret : "accepted"} (delivery ${r.deliveryId})`,
      }
    : { ok: false, destination: shown, detail: `${r.statusCode ? `HTTP ${r.statusCode} — ` : ""}${r.detail.replace(/\s+/g, " ").slice(0, 400)}` };
}

export async function sendRunNotification(
  tenant: string,
  workspace: string,
  run: RunRecord,
): Promise<boolean> {
  const config = notifyConfig(tenant, workspace);
  if (!config) return false;
  // A completed run whose work refused itself — the verdict is BLOCKED — is
  // its own event, `blocked`. It follows `failed` the way the plain alerts
  // do: whoever hears about failures hears about it, because "nothing was
  // published" is the news a person needs whether a step crashed or an
  // agent stopped itself. Naming `blocked` turns it on alone; a list
  // without either stays silent.
  const blocked = run.status === "completed" && runVerdict(run) === "BLOCKED";
  if (blocked) {
    if (!config.events.includes("blocked") && !config.events.includes("failed")) return false;
  } else if (!config.events.includes(run.status)) return false;
  // A test is not news. An eval case or an adhoc single-agent run is started
  // by a person who is watching it, and a desk that emails "completed" for
  // every one of them buries the weekly verdict under two hundred of these —
  // on 2026-09-06 the reader's inbox rule had sent the lot to the bin, the
  // real reports with them. Failures and gates still send: a person asked.
  if (run.status === "completed" && isQuietFlow(run.flow)) return false;
  // A test run sent nothing outward and this must not be the exception: it
  // reports only a failure, which is the one thing the person testing it
  // needs told about without watching. Its gate mail would ask a real
  // decision about a pretend send.
  if (run.test && run.status !== "failed") return false;

  const failed = run.steps.filter((s) => s.status === "failed").map((s) => s.agent);
  const waitingSteps = run.steps.filter((s) => s.status === "awaiting-approval");
  const waiting = waitingSteps.map((s) => s.agent);
  // A park on `wait: event` is not a question for the reader: the message
  // says what the run is waiting for, so nobody hunts for a button that
  // the outside world is meant to press.
  const onEvent = waitingSteps.length > 0 && waitingSteps.every((s) => s.waitFor === "event");
  const headline = blocked
    ? `⛔ ${run.flow} blocked`
    : run.status === "completed"
      ? `✓ ${run.flow} completed`
      : run.status === "failed"
        ? `✗ ${run.flow} failed${failed.length ? ` at ${failed.join(", ")}` : ""}`
        : onEvent
          ? `⏳ ${run.flow} is waiting for an external event${waiting.length ? ` (${waiting.join(", ")})` : ""}`
          : `⏸ ${run.flow} is waiting for your approval${waiting.length ? ` (${waiting.join(", ")})` : ""}`;

  // What the run concluded, if it concluded anything. This is the whole point
  // of the message: "✓ health completed · $0.42" tells you a thing ran and
  // what it cost, and nothing at all about what it found. A scheduled desk
  // reporting only its own existence is a desk nobody reads by week three.
  const summary = run.summary?.trim() || null;

  // An emailed link is minted for its reader: a named approver's mail
  // carries links that decide as them. A webhook has no reader.
  const links = run.status === "awaiting-approval" ? approvalLinks(tenant, workspace, run, config.email ?? null) : null;
  // At a gate the reader is being asked something; the question goes in the
  // mail, and so does what the run has concluded so far — the last finished
  // step's first line, which is the proposal's own summary ("… ·
  // TARGETS-PROPOSAL: 1 change"). Without these a gate email said only
  // that a step was waiting, and the decision meant opening the dashboard.
  const asks = waitingSteps.map((s) => s.ask?.trim()).filter((a): a is string => Boolean(a));
  const soFar =
    run.status === "awaiting-approval" && !summary
      ? [...run.steps].reverse().find((s) => s.status === "completed" && s.result?.trim())?.result?.trim().split("\n")[0] ?? null
      : null;

  const body = {
    // `text` is what Slack-shaped receivers render; the rest is for anything
    // that wants the data instead of the sentence.
    text: summary
      ? `${headline} — ${summary} · ${workspace}/${run.id} · $${runCost(run).toFixed(4)}`
      : `${headline} — ${workspace}/${run.id} · $${runCost(run).toFixed(4)}`,
    workspace,
    runId: run.id,
    flow: run.flow,
    status: run.status,
    verdict: runVerdict(run),
    summary,
    costUsd: runCost(run),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(links ?? {}),
  };

  try {
    if (config.email) {
      const mail = notifyMail(tenant);
      if (!mail) {
        console.error(`[foldrun] notify: email configured but no mail credential — set RESEND_API_KEY (and EMAIL_FROM) on the account ${tenant}, or FOLDRUN_RESEND_API_KEY on the platform`);
        return false;
      }
      // A gate is its own category: a person may want failures and not
      // the approval requests (they decide from the dashboard), or the
      // other way round.
      const category: MailCategory = run.status === "awaiting-approval" && !onEvent ? "approvals" : "run-alerts";
      const r = await sendMail({
          tenant,
          mail,
          to: config.email,
          category,
          workspace,
          // The subject is the headline and what the run concluded, and
          // nothing else. Ids and costs belong in the body: a subject line is
          // read in a list, where the only useful question it can answer is
          // whether this one needs opening.
          subject: summary ? `${headline} — ${summary}`.slice(0, 160) : headline,
          text:
            `${headline}\n` +
            (summary ? `\n${summary}\n` : soFar ? `\n${soFar}\n` : "") +
            (asks.length ? `\n${asks.map((a) => `Question: ${a}`).join("\n")}\n` : "") +
            `\nworkspace: ${workspace}\nrun: ${run.id}\nflow: ${run.flow}\n` +
            `cost: $${runCost(run).toFixed(4)}\nstarted: ${run.startedAt}\nfinished: ${run.finishedAt ?? "-"}\n` +
            (links
              ? links.links.length === 1
                ? `\nApprove: ${links.approveUrl}\nReject: ${links.rejectUrl}\n`
                : links.links.map((l) => `\nStep ${l.step + 1} (${l.agent})\nApprove: ${l.approveUrl}\nReject: ${l.rejectUrl}\n`).join("")
              : ""),
      });
      if (r.status !== undefined) noteMailUse(tenant, r.status);
      if (!r.ok) {
        // Resend's body says WHY — "domain not verified", "can only send to
        // your own address" — and a status alone sent someone to the wrong
        // dashboard for twenty minutes on 2026-09-06.
        console.error(`[foldrun] notify email: ${tenant}/${workspace} → ${r.status ? `HTTP ${r.status} ` : ""}${r.error ?? ""}`);
        return false;
      }
      return true;
    }

    // ${SECRET} so the Slack URL — itself a credential — can live in the
    // vault instead of in a file that gets committed.
    if (!webhookTarget(tenant, workspace, config).url) {
      console.error(`[foldrun] notify: secret in URL not set for ${tenant}/${workspace}`);
      return false;
    }
    const event = blocked ? "blocked" : run.status;
    const r = await platform.deliverWebhook(tenant, workspace, { event, body: JSON.stringify(body), retry: true });
    if (!r.ok) {
      console.error(`[foldrun] notify: ${tenant}/${workspace} → ${r.statusCode ? `HTTP ${r.statusCode}` : r.detail}${r.retrying ? " (will retry)" : ""}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[foldrun] notify: ${tenant}/${workspace} →`, err instanceof Error ? err.message : err);
    return false;
  }
}
