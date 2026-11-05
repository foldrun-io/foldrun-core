// Why a step failed, said to the customer (FOL-124).
//
// A failed step's record keeps every error it wrote; the runs list, the run
// page, the API and `foldrun report` used to print the last one as it was —
// "sandbox ended: OOMKilled (exit 137)" — which is true and says nothing
// about what to do. This is the one place that turns a failed step into
// three things every surface shows alike:
//
//   · its class, in the ops log's vocabulary (ops-log.ts ERROR_CLASSES), so
//     the operator's dashboards and the customer's view count the same
//     failure the same way;
//   · a sentence for the customer: exact where the cause is a limit ("used
//     3.9 GiB of the 4 GiB its size allows"), naming the site where it is a
//     network refusal (the list is the customer's own), and generic — never
//     how it was found — where it is a security control;
//   · what to do: a lighter setting, a larger one, or a plan that allows
//     more.
//
// Pure: the web tier, the platform and the CLI read the same answer.

import type { ErrorClass } from "./ops-log.ts";
import { platformCause } from "./issues.ts";

/** What went wrong, one level finer than the class: what the message and
 *  the fix are about. */
export const FAILURE_KINDS = [
  "memory", //   out of memory, or a step that asks for more than it may hold
  "cpu", //      a step that asks for more cores than it may hold
  "disk", //     out of disk, or more than it may hold
  "timeout", //  ran past its timeout:
  "network", //  a site its network: list does not allow
  "security", // stopped by a platform security control
  "budget", //   a budget: ran out
  "check", //    its verify:, output: json or schema did not hold
  "model", //    the model refused, is at its cap, or is overloaded
  "credential", // the model credential was refused
  "stopped", //  a person or a key stopped it
  "code", //     the account's own code failed: a script, a tool, a hook
  "platform", // ours: a sandbox that could not start, a lost worker
  "other", //    none of the above; the step's own words
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface FailureExplained {
  /** The ops log's class (ops-log.ts) — the same word the operator sees. */
  class: ErrorClass;
  kind: FailureKind;
  /** What happened, for the customer, in one sentence. */
  message: string;
  /** What to do about it, or null when there is nothing they can do. */
  fix: string | null;
  /** A limit's figures, when the cause is one: what the step used or asked
   *  for (null when the sandbox ended before it could be read) and what it
   *  may hold, in `unit`. */
  used?: number | null;
  allowed?: number;
  unit?: "GiB" | "vCPU" | "s";
  /** Whose limit it was, for a limit: the step's own maximum, its run's,
   *  workspace's or account's pool, the install's, or the largest node. */
  scope?: LimitScope;
  /** The site a network refusal named. */
  host?: string;
}

export type LimitScope = "step" | "run" | "workspace" | "account" | "install" | "node";

/** The one text a security control writes as a step's error. What it found
 *  and how goes to the platform's security record, never to the step's
 *  trail: the trail is the customer's. */
export const SECURITY_STOP = "stopped by a platform security control";

/** The only way to write a security stop onto a step: the fixed sentence and
 *  the `security` flag, set host-side. It takes no argument on purpose —
 *  there is nowhere to put evidence. Text alone never counts as one: a
 *  step's own output can say anything (run-container.ts parseDriverLine
 *  never copies the flag from a sandbox). */
export function securityStopEvent(at = new Date()): { t: string; type: "error"; text: string; security: true } {
  return { t: at.toISOString(), type: "error", text: SECURITY_STOP, security: true };
}

/** What a step's row in the runs index keeps so a list can say a limit's
 *  figures and a refused site without reading the whole record
 *  (store.ts summarizeRun). Absent on rows written before 5 Nov 2026. */
export interface FailureFacts {
  size?: string;
  memGiB?: number;
  diskGiB?: number;
  peakMemBytes?: number | null;
  /** Sites the egress proxy refused this step — off its network: list, or
   *  a site none of its secrets is bound to — newest last, at most five. */
  refusedHosts?: string[];
  secretHosts?: string[];
  /** Its error was a security stop (securityStopEvent). */
  security?: true;
}

/** As much of a step as this reads. */
export interface FailedStepLike {
  events: { type: string; text: string; check?: boolean; security?: boolean }[];
  size?: string;
  reserved?: { cpus: number; memGiB: number; diskGiB?: number } | null;
  actual?: { peakMemBytes: number | null } | null;
  failureFacts?: FailureFacts;
}

const GIB = 1024 ** 3;
/** A figure as the platform's messages write one: 4, 0.5, 3.9. */
const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** The refusal line the egress proxy writes (network.ts refusalText). */
const REFUSED_SITE = /network: (\S+?) is not a site this step may reach/;
/** And the bound-secret refusal: a host the step's secrets were not granted to. */
const REFUSED_SECRET_HOST = /^egress: [A-Z]+ (\S+?) refused — not a host this step's secrets were granted to/;

/** The sites the egress proxy refused this step, newest last: from its
 *  trail, else what its index row kept. `secret`: refused because no secret
 *  is bound to it, not for the network: list. */
export function refusedSites(step: Pick<FailedStepLike, "events" | "failureFacts">): { host: string; secret: boolean }[] {
  const out: { host: string; secret: boolean }[] = [];
  for (const e of step.events) {
    if (e.type === "error") continue;
    const site = REFUSED_SITE.exec(e.text);
    if (site && /Refused\.\s*$/.test(e.text)) out.push({ host: site[1].toLowerCase(), secret: false });
    const sec = REFUSED_SECRET_HOST.exec(e.text);
    if (sec) out.push({ host: sec[1].toLowerCase(), secret: true });
  }
  if (out.length || !step.failureFacts) return out;
  const secret = new Set(step.failureFacts.secretHosts ?? []);
  return (step.failureFacts.refusedHosts ?? []).map((host) => ({ host, secret: secret.has(host) }));
}

function refusedHost(line: string): { host: string; secret: boolean } | null {
  const site = REFUSED_SITE.exec(line);
  if (site) return { host: site[1].toLowerCase(), secret: false };
  const sec = REFUSED_SECRET_HOST.exec(line);
  return sec ? { host: sec[1].toLowerCase(), secret: true } : null;
}

/** A host as the index may keep one: a DNS name or an address, nothing else. */
const HOST = /^[a-z0-9._:\[\]-]{1,253}$/;

/** What the index row of a failed step keeps for explainFailure: figures and
 *  host names, never prose. */
export function failureFactsOf(step: FailedStepLike): FailureFacts | undefined {
  const sites = refusedSites({ events: step.events }).filter((r) => HOST.test(r.host));
  const hosts = [...new Set(sites.map((r) => r.host))].slice(-5);
  const secretHosts = [...new Set(sites.filter((r) => r.secret).map((r) => r.host))].filter((h) => hosts.includes(h));
  const facts: FailureFacts = {
    ...(step.size ? { size: step.size } : {}),
    ...(step.reserved?.memGiB ? { memGiB: step.reserved.memGiB } : {}),
    ...(step.reserved?.diskGiB ? { diskGiB: step.reserved.diskGiB } : {}),
    ...(typeof step.actual?.peakMemBytes === "number" ? { peakMemBytes: step.actual.peakMemBytes } : {}),
    ...(hosts.length ? { refusedHosts: hosts } : {}),
    ...(secretHosts.length ? { secretHosts } : {}),
    ...(step.events.some((e) => e.type === "error" && e.security === true) ? { security: true as const } : {}),
  };
  return Object.keys(facts).length ? facts : undefined;
}

const UPGRADE = "or a plan that allows more (Settings → Billing)";

const SCOPES: Record<string, LimitScope> = {
  "this run's": "run",
  "this workspace's": "workspace",
  "this account's": "account",
  "the install's": "install",
  "the largest node's": "node",
};

/** The room gate's "never fits" sentences (platform pod-room.ts tooBig —
 *  its tests feed every one of them through here). */
function tooBig(reason: string): FailureExplained | null {
  const kindOf = (unit: string): FailureKind => (unit === "vCPU" ? "cpu" : unit === "GiB" ? "memory" : "disk");
  const one = /this step holds ([\d.]+) (GiB of disk|GiB|vCPU) and one step on this account may hold ([\d.]+)/.exec(reason);
  if (one) {
    const need = Number(one[1]);
    const cap = Number(one[3]);
    const kind = kindOf(one[2]);
    const what = kind === "memory" ? "GiB of memory" : one[2];
    return {
      class: "policy_denied",
      kind,
      message: `This step asks for ${fmt(need)} ${what}; one step on this account may hold ${fmt(cap)} ${kind === "cpu" ? "vCPU" : "GiB"}.`,
      fix: `Ask for less with size: or resources: on the agent, ${UPGRADE}.`,
      used: need,
      allowed: cap,
      unit: kind === "cpu" ? "vCPU" : "GiB",
      scope: "step",
    };
  }
  const pool = /this step holds ([\d.]+) (GiB of disk|GiB|vCPU), more than (this run's|this workspace's|this account's|the install's|the largest node's) ([\d.]+)/.exec(reason);
  if (pool) {
    const need = Number(pool[1]);
    const cap = Number(pool[4]);
    const kind = kindOf(pool[2]);
    const scope = SCOPES[pool[3]];
    const what = kind === "memory" ? "GiB of memory" : pool[2];
    const fix =
      scope === "run" ? "Ask for less with size: or resources: on the agent, or raise the flow's compute:."
      : scope === "workspace" ? "Ask for less with size: or resources: on the agent, or raise the workspace's compute: (its AGENTS.md)."
      : scope === "account" ? `Ask for less with size: or resources: on the agent, raise the account's compute: (Settings → Governance), ${UPGRADE}.`
      : "Ask for less with size: or resources: on the agent: no machine here can hold a step this big.";
    return {
      class: "policy_denied",
      kind,
      message:
        scope === "node"
          ? `This step asks for ${fmt(need)} ${what}; the largest machine here holds ${fmt(cap)}.`
          : `This step alone asks for ${fmt(need)} ${what}, more than ${pool[3]} ${fmt(cap)} for all its steps together.`,
      fix,
      used: need,
      allowed: cap,
      unit: kind === "cpu" ? "vCPU" : "GiB",
      scope,
    };
  }
  return null;
}

const MEMORY = /\bOOMKilled\b|JavaScript heap out of memory|out of memory|Cannot allocate memory|\bENOMEM\b/i;
const DISK = /no space left on device|\bENOSPC\b|\bEDQUOT\b|disk quota exceeded|ephemeral local storage usage exceeds/i;
/** The cluster evicting a step because the MACHINE ran short — not the
 *  step over its own limit. */
const NODE_PRESSURE = /\bEvicted\b[^\n]*\bThe node (was|had) (low on|condition)|\bnode (was )?low on resource\b/i;

/**
 * Why this failed step failed, for the customer. `reason` is its last error
 * (store.ts runFailure); the step gives the figures a limit's message says.
 */
export function explainFailure(reason: string, step?: FailedStepLike | null): FailureExplained {
  const facts = step?.failureFacts;
  const text = String(reason ?? "");

  // A security control — only the flag a host-side writer sets
  // (securityStopEvent), never words that could come from the step itself.
  if (facts?.security || step?.events.some((e) => e.type === "error" && e.security === true)) {
    return {
      class: "policy_denied",
      kind: "security",
      message: "This step was stopped by a platform security control.",
      fix: "If you think this is a mistake, write to hello@foldrun.io with the run's id.",
    };
  }

  const big = tooBig(text);
  if (big) return big;

  const memGiB = step?.reserved?.memGiB ?? facts?.memGiB;
  const diskGiB = step?.reserved?.diskGiB ?? facts?.diskGiB;
  const peak = typeof step?.actual?.peakMemBytes === "number" ? step.actual.peakMemBytes : facts?.peakMemBytes ?? null;

  if (NODE_PRESSURE.test(text)) {
    return {
      class: /ephemeral|disk/i.test(text) ? "disk_full" : "oom",
      kind: "platform",
      message: `The machine the step ran on ran short of ${/ephemeral|disk/i.test(text) ? "disk" : "memory"} and the cluster evicted the step.`,
      fix: "Rerun it; if it happens again, a smaller size: or resources: makes the step easier to place.",
    };
  }
  if (DISK.test(text)) {
    const limit = /total limit of containers ([\d.]+)Gi\b/.exec(text);
    const allowed = diskGiB ?? (limit ? Number(limit[1]) : undefined);
    return {
      class: "disk_full",
      kind: "disk",
      message: allowed ? `The step ran out of disk. Disk limit: ${fmt(allowed)} GiB.` : "The step ran out of disk.",
      fix: "Give it more with resources: { disk: … } or a larger size: (up to what your plan allows one step), or have it write less at once — large files in parts.",
      ...(allowed ? { used: null, allowed, unit: "GiB" as const, scope: "step" as const } : {}),
    };
  }
  if (MEMORY.test(text)) {
    const used = peak !== null && peak / GIB > 0.05 ? Math.round((peak / GIB) * 10) / 10 : null;
    return {
      class: "oom",
      kind: "memory",
      message: memGiB
        ? `The step ran out of memory. Memory limit: ${fmt(memGiB)} GiB${used !== null ? `; last recorded peak: ${fmt(used)} GiB` : ""}.`
        : "The step ran out of memory.",
      fix: `Give it more with a larger size: (large, heavy) or resources: { memory: … } — up to what your plan allows one step, ${UPGRADE} — or have it hold less at once.`,
      ...(memGiB ? { used, allowed: memGiB, unit: "GiB" as const, scope: "step" as const } : {}),
    };
  }

  const timedOut = /timed out after (\d+)s \(timeout: in the flow file\)/.exec(text);
  if (timedOut) {
    const secs = Number(timedOut[1]);
    return {
      class: "timeout",
      kind: "timeout",
      message: `The step ran past its timeout: ${secs} seconds.`,
      fix: "Raise timeout: on the step (in seconds), or give it less to do in one step.",
      used: null,
      allowed: secs,
      unit: "s",
      scope: "step",
    };
  }
  if (/\bDeadlineExceeded\b/.test(text)) {
    return { class: "timeout", kind: "timeout", message: "The step's sandbox ran past its time limit and was ended.", fix: "Rerun it; if it happens again, give the step less to do or a longer timeout:." };
  }

  // The error itself is the egress proxy's refusal.
  const direct = refusedHost(text);
  if (direct) return networkRefusal(direct, false);

  if (/^over budget|is at its budget/.test(text)) {
    return { class: "policy_denied", kind: "budget", message: firstSentence(text), fix: "Raise the budget: it names, or wait for its period to reset." };
  }
  if (/^(run )?stopped by |stopped while waiting for room/.test(text)) {
    return { class: "cancelled", kind: "stopped", message: firstSentence(text), fix: null };
  }

  const cause = platformCause(text);
  if (cause) {
    const kind: FailureKind = cause.key === "model-auth" ? "credential" : cause.key === "sandbox" || cause.key === "worker" ? "platform" : "model";
    return {
      class: kind === "platform" ? "platform_error" : kind === "credential" ? "policy_denied" : "model_error",
      kind,
      message: `${cause.label}.`,
      fix: cause.fix.charAt(0).toUpperCase() + cause.fix.slice(1),
    };
  }

  const lastError = step?.events.filter((e) => e.type === "error").at(-1);
  if (lastError?.check || /^verify\b|^output: json/.test(text)) {
    return { class: "user_code_error", kind: "check", message: `The step's check did not hold: ${firstSentence(text)}`, fix: "Read the step's reply against what the check asks; change the check or the agent's instructions." };
  }
  if (/\b(Claude Code process|model process|the model stream ended|api\.anthropic\.com)\b/.test(text)) {
    return { class: "model_error", kind: "model", message: `The model's process failed: ${firstSentence(text)}`, fix: "Rerun it; if it fails the same way, the step's trail has the model's last words." };
  }

  // The step's own program gave up, and the proxy had also refused it a
  // site: both said, the failure first — the trail does not prove which
  // came first, let alone that one caused the other.
  const refused = step ? refusedSites(step).at(-1) : undefined;
  if (refused) return networkRefusal(refused, true, firstSentence(text));

  if (/exited \(code \d+\)|exit code \d+|\(exit \d+\)|Traceback \(most recent call last\)|^hook\b|^script\b|^tool\b|SyntaxError|TypeError|ReferenceError/.test(text)) {
    return { class: "user_code_error", kind: "code", message: firstSentence(text), fix: "The step's trail has the program's output; fix the script, tool or hook it names and rerun." };
  }
  // A bucket, not a diagnosis: the ops log counts the unknown as ours.
  return { class: "platform_error", kind: "other", message: firstSentence(text), fix: null };
}

/** A site the egress proxy refused, said with the site — the list is the
 *  customer's own. `onTrail`: the refusal is only on the trail and the
 *  step's error, `after`, is something else. */
function networkRefusal(r: { host: string; secret: boolean }, onTrail: boolean, after = ""): FailureExplained {
  const why = r.secret ? "none of its secrets is bound to that site" : "it is not on this agent's network: list";
  return {
    class: "policy_denied",
    kind: "network",
    message: onTrail ? `${after.replace(/[.\s]+$/, "")}. A request to ${r.host} was also refused: ${why}.` : `The step was refused ${r.host}: ${why}.`,
    fix: r.secret
      ? `If a secret is meant for ${r.host}, bind it there: \`foldrun secrets sites NAME ${r.host}\`.`
      : `If this agent should reach ${r.host}, add just this site: network: [${r.host}] on the agent — the rest of its network: stays as it is.`,
    host: r.host,
  };
}

/** The reason's first line, trimmed to a sentence a table cell can hold. */
function firstSentence(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > 300 ? `${line.slice(0, 297)}…` : line || "The step failed without saying why.";
}
