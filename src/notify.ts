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

import { readAgentsMd } from "./runner.ts";
import { accountDir, workspaceDir, runCost, type RunRecord } from "./store.ts";
import { getSecret } from "./secrets.ts";

export interface NotifyConfig {
  url?: string;
  email?: string;
  events: string[];
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
    const o = raw as { url?: unknown; email?: unknown; events?: unknown };
    const url = typeof o.url === "string" ? o.url : undefined;
    const email = typeof o.email === "string" ? o.email : undefined;
    if (!url && !email) return null;
    return {
      url,
      email,
      events: Array.isArray(o.events) && o.events.length ? o.events.map(String) : DEFAULT_EVENTS,
    };
  }
  return null;
}

/**
 * Fire the webhook for a run's state, if the workspace asked to hear about
 * it. Failures are logged and swallowed — a broken Slack hook must never
 * fail the run it is reporting on.
 */
export async function sendRunNotification(
  tenant: string,
  workspace: string,
  run: RunRecord,
): Promise<boolean> {
  const config = notifyConfig(tenant, workspace);
  if (!config || !config.events.includes(run.status)) return false;

  const failed = run.steps.filter((s) => s.status === "failed").map((s) => s.agent);
  const waiting = run.steps.filter((s) => s.status === "awaiting-approval").map((s) => s.agent);
  const headline =
    run.status === "completed"
      ? `✓ ${run.flow} completed`
      : run.status === "failed"
        ? `✗ ${run.flow} failed${failed.length ? ` at ${failed.join(", ")}` : ""}`
        : `⏸ ${run.flow} is waiting for your approval${waiting.length ? ` (${waiting.join(", ")})` : ""}`;

  const body = {
    // `text` is what Slack-shaped receivers render; the rest is for anything
    // that wants the data instead of the sentence.
    text: `${headline} — ${workspace}/${run.id} · $${runCost(run).toFixed(4)}`,
    workspace,
    runId: run.id,
    flow: run.flow,
    status: run.status,
    costUsd: runCost(run),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };

  try {
    if (config.email) {
      // The same connection the email tool uses; a run's own credential
      // vocabulary. Until the sending domain is verified at Resend, delivery
      // is limited to the account owner's address — Resend's rule, reported
      // as its own 403 rather than hidden here.
      const key = getSecret(tenant, "RESEND_API_KEY", workspace);
      if (!key) {
        console.error(`[foldrun] notify: email configured but RESEND_API_KEY is not set for ${tenant}`);
        return false;
      }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key.value}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: "foldrun <onboarding@resend.dev>",
          to: config.email,
          subject: body.text,
          text:
            `${headline}\n\nworkspace: ${workspace}\nrun: ${run.id}\nflow: ${run.flow}\n` +
            `cost: $${runCost(run).toFixed(4)}\nstarted: ${run.startedAt}\nfinished: ${run.finishedAt ?? "-"}\n`,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        console.error(`[foldrun] notify email: ${tenant}/${workspace} → HTTP ${res.status}`);
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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
