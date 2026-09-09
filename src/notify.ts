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
//     events: [failed, awaiting-approval, completed]
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
import { accountDir, workspaceDir, runCost, type RunRecord } from "./store.ts";
import { getSecret } from "./secrets.ts";
import { approveToken, publicUrl } from "./webhook.ts";
import { noteSecretUse, healthKey } from "./secret-health.ts";

/**
 * The platform's own mail: an invite, a low balance.
 *
 * These are from foldrun, about the platform, to the account's owner — so
 * they go through the platform's Resend key and sender (FOLDRUN_RESEND_API_KEY,
 * FOLDRUN_EMAIL_FROM), never through anything the customer configured.
 *
 * Without a platform key — the CLI on a laptop, a test — the account's own
 * key and EMAIL_FROM are the fallback.
 */
export function platformMail(tenant: string): { key: string; from: string } | null {
  const key = process.env.FOLDRUN_RESEND_API_KEY;
  if (key) return { key, from: process.env.FOLDRUN_EMAIL_FROM || "foldrun <hello@foldrun.io>" };
  return accountMail(tenant);
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

/**
 * The approve/reject links for a run waiting on a person, or null when the
 * install cannot say where it lives. A notification that only says "waiting
 * for you" sends the reader to find a laptop; one that carries the decision
 * lets them make it where they read it.
 *
 * The reject link goes to the same page with the choice pre-selected — a
 * GET must not decide anything, because inbox link-checkers follow links.
 */
export function approvalLinks(
  tenant: string,
  workspace: string,
  runId: string,
): { approveUrl: string; rejectUrl: string } | null {
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
  const approveUrl = `${base}/api/approve/${tenant}/${workspace}/${runId}?token=${approveToken(tenant, workspace, runId)}`;
  return { approveUrl, rejectUrl: `${approveUrl}&decision=reject` };
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
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${mail.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: mail.from,
          to: config.email,
          subject: `${msg.headline}`.slice(0, 160),
          text: `${msg.headline}\n\n${msg.detail}\n\nworkspace: ${workspace}\n${msg.flow ? `flow: ${msg.flow}\n` : ""}${msg.runId ? `run: ${msg.runId}\n` : ""}`,
        }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    }
    const url = (config.url ?? "").replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
      const hit = getSecret(tenant, name, workspace);
      return hit ? hit.value : whole;
    });
    if (!url || url.includes("${")) return false;
    const payload = JSON.stringify(body);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signatureHeaders(tenant, workspace, config, payload) },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
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
  const headline = "\u2713 foldrun test notification";
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
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${mail.key}`, "content-type": "application/json" },
        body: JSON.stringify({ from: mail.from, to: config.email, subject: headline, text: `${headline}\n\n${detail}\n` }),
        signal: AbortSignal.timeout(8000),
      });
      noteMailUse(tenant, res.status);
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
      return res.ok
        ? { ok: true, destination: `${config.email} (from ${mail.from})`, detail: "accepted by Resend for delivery" }
        : { ok: false, destination: config.email, detail: `HTTP ${res.status} from Resend — ${body}` };
    } catch (err) {
      return { ok: false, destination: config.email, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const raw = config.url ?? "";
  const url = raw.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
    const hit = getSecret(tenant, name, workspace);
    return hit ? hit.value : whole;
  });
  // The destination is echoed back with the secret still unresolved: a
  // Slack webhook URL is itself a credential, and a page that prints it is
  // a page that leaks it into a screenshot.
  const shown = raw.includes("${") ? raw : `${url.slice(0, 40)}…`;
  if (!url || url.includes("${")) {
    return { ok: false, destination: shown, detail: `the secret named in notify.url is not in this account's vault` };
  }
  try {
    const payload = JSON.stringify({ text: `${headline} — ${detail}`, workspace, status: "test", summary: detail });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signatureHeaders(tenant, workspace, config, payload) },
      body: payload,
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    return res.ok
      ? {
          ok: true,
          destination: shown,
          detail: config.signingSecret ? "accepted, signed with " + config.signingSecret : "accepted",
        }
      : { ok: false, destination: shown, detail: `HTTP ${res.status} — ${body}` };
  } catch (err) {
    return { ok: false, destination: shown, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendRunNotification(
  tenant: string,
  workspace: string,
  run: RunRecord,
): Promise<boolean> {
  const config = notifyConfig(tenant, workspace);
  if (!config || !config.events.includes(run.status)) return false;
  // A test is not news. An eval case or an adhoc single-agent run is started
  // by a person who is watching it, and a desk that emails "completed" for
  // every one of them buries the weekly verdict under two hundred of these —
  // on 2026-09-06 the reader's inbox rule had sent the lot to the bin, the
  // real reports with them. Failures and gates still send: a person asked.
  if (run.status === "completed" && isQuietFlow(run.flow)) return false;

  const failed = run.steps.filter((s) => s.status === "failed").map((s) => s.agent);
  const waitingSteps = run.steps.filter((s) => s.status === "awaiting-approval");
  const waiting = waitingSteps.map((s) => s.agent);
  // A park on `wait: event` is not a question for the reader: the message
  // says what the run is waiting for, so nobody hunts for a button that
  // the outside world is meant to press.
  const onEvent = waitingSteps.length > 0 && waitingSteps.every((s) => s.waitFor === "event");
  const headline =
    run.status === "completed"
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

  const links = run.status === "awaiting-approval" ? approvalLinks(tenant, workspace, run.id) : null;
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
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${mail.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: mail.from,
          to: config.email,
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
            (links ? `\nApprove: ${links.approveUrl}\nReject: ${links.rejectUrl}\n` : ""),
        }),
        signal: AbortSignal.timeout(8000),
      });
      noteMailUse(tenant, res.status);
      if (!res.ok) {
        // Resend's body says WHY — "domain not verified", "can only send to
        // your own address" — and a status alone sent someone to the wrong
        // dashboard for twenty minutes on 2026-09-06.
        const why = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
        console.error(`[foldrun] notify email: ${tenant}/${workspace} → HTTP ${res.status} ${why}`);
        return false;
      }
      return true;
    }

    // ${SECRET} so the Slack URL — itself a credential — can live in the
    // vault instead of in a file that gets committed.
    const url = (config.url ?? "").replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
      const hit = getSecret(tenant, name, workspace);
      return hit ? hit.value : whole;
    });
    if (!url || url.includes("${")) {
      console.error(`[foldrun] notify: secret in URL not set for ${tenant}/${workspace}`);
      return false;
    }
    const payload = JSON.stringify(body);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signatureHeaders(tenant, workspace, config, payload) },
      body: payload,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[foldrun] notify: ${tenant}/${workspace} → HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[foldrun] notify: ${tenant}/${workspace} →`, err instanceof Error ? err.message : err);
    return false;
  }
}
