// Issues: what went wrong, kept open until a person closes it (FOL-54 step 3).
//
// The overview used to list "needs attention" from each flow's newest run in
// the last day, so a later success hid a failure and anything older than a
// day vanished on its own. An issue is the same thing going wrong again —
// one desk's flow failing at one agent, or ending BLOCKED or BAD, or one
// platform cause across every desk — with when it was first and last seen,
// how many times, which runs, and what to do. It stays open until someone
// resolves it; a later good run is shown ("fine since …") but closes nothing.
// (Closing on its own is opt-in, per flow — step 4.)
//
// Issues are derived from the runs; only what people did to them is stored
// (IssueState: acknowledged, snoozed, resolved, reopened, with a history).
// A run after the issue was resolved opens it again. Pure: the browser, the
// API and the CLI read the same function.

import type { Outcome } from "./outcome.ts";

export type IssueKind = "platform" | "failed" | "blocked" | "bad" | "missed";
export type IssueStatus = "open" | "acknowledged" | "snoozed" | "resolved";
export type IssueAction = "acknowledge" | "snooze" | "resolve" | "reopen";

/** As much of a run as an issue needs (the overview's RunLite carries it). */
export interface IssueRun {
  workspace: string;
  id: string;
  /** The flow's name, or "agent: x" / "eval: y". */
  what: string;
  outcome: Outcome;
  startedAt: string;
  finishedAt?: string | null;
  failure?: { agent: string; reason: string } | null;
  headline?: string | null;
  /** The revision the run ran (RunRecord.revision), for "regressed since". */
  revision?: string | null;
  /** Not a run: a scheduled fire that started none (FOL-72 step 7). Its
   *  `startedAt` is when it was due; its id is `missed-<when>`. */
  missed?: boolean;
}

export interface IssueEvent {
  at: string;
  /** Who: a person's email, or a key's label. */
  by: string;
  action: IssueAction;
  /** Snoozed until, ISO. */
  until?: string;
  /** Or snoozed until it happens this many more times. */
  untilCount?: number;
  note?: string;
}

/** What people did to one issue. Stored; the rest is derived. */
export interface IssueState {
  history: IssueEvent[];
}

export interface Issue {
  id: string;
  kind: IssueKind;
  status: IssueStatus;
  /** The desk; for a platform issue, the newest desk it hit. */
  workspace: string;
  /** For a platform issue, every desk it hit. */
  workspaces: string[];
  /** The flow (or agent run); for a platform issue, what broke. */
  what: string;
  /** The agent the failure was at, for a failed issue. */
  agent: string | null;
  /** Why, from the newest run: its failure, or its summary line. */
  reason: string;
  /** What to do about it, in plain words. */
  action: string;
  /** Since it was last resolved (or ever): when the first and the latest of
   *  its runs went wrong (their end, else their start), how many. */
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** The newest runs it covers, newest first, at most 20; a missed
   *  schedule's are the fires that started nothing (`missed`). */
  runs: { workspace: string; id: string; at: string; missed?: boolean }[];
  /** The newest run of the same flow went fine after the last occurrence. */
  recoveredAt: string | null;
  acknowledged: { at: string; by: string } | null;
  snoozedUntil: string | null;
  /** Snoozed until it happens this many more times: how many are left. */
  snoozedFor: number | null;
  /** It was resolved before and came back: this episode follows a resolve. */
  regressed: boolean;
  /** The revision the first run of this episode ran — "since abc1234". */
  sinceRevision: string | null;
  resolved: { at: string; by: string } | null;
  history: IssueEvent[];
}

/** The model refusing the credential, as the runner sees it (runner.ts
 *  isAuthRefusal reads this one pattern, so a refusal the runner retries on
 *  is the same refusal an issue groups by — Codex review). */
export const AUTH_REFUSAL = /API Error: 401|access token has (been revoked|expired)|OAuth token (has )?(been )?(revoked|expired)|Failed to authenticate/i;

/** A failure that is the platform's, not the desk's. */
export interface PlatformCause {
  key: string;
  /** What broke, in the words a person would use. */
  label: string;
  /** What to do about it. None of it is editing the desk. */
  fix: string;
}

// On 2026-09-30 every browser step on every desk failed "login-checker: pod
// never became ready" — the nightly prune had deleted the runner image — and
// the overview listed it as a dozen separate desk failures, each looking like
// that desk's login-checker was broken; on 2026-09-29 the worker could not
// reach the Kubernetes API for eight minutes ("pod create failed … dial tcp
// 10.43.0.1:443: i/o timeout"). These are the failures no edit to a
// flow can cause or fix; they are grouped into one item that says so.
const PLATFORM_CAUSES: (PlatformCause & { test: RegExp })[] = [
  {
    key: "sandbox",
    label: "Run sandboxes cannot start",
    fix: "the runner image or the node — not the desks. Rerun once it is fixed.",
    test: /pod never became ready|pod create failed|ImagePullBackOff|ErrImagePull|failed to pull image|sandbox (never started|failed to start)/i,
  },
  {
    key: "model-auth",
    label: "The model credential is refused",
    fix: "the Claude sign-in expired or was revoked; sign in again, then rerun.",
    test: new RegExp(
      `${AUTH_REFUSAL.source}|refresh token expired|authentication_error|invalid x-api-key|(claude|anthropic|model)[^\\n]{0,40}\\b401\\b|\\b401\\b[^\\n]{0,40}(claude|anthropic|model)`,
      "i",
    ),
  },
  {
    key: "model-cap",
    label: "The model usage cap is reached",
    fix: "runs resume when the cap resets; nothing to change in the desks.",
    // Also the runner's own sentence for a spent subscription window
    // (refusal.ts explainRefusal): on 23 Oct 2026 "the 7-day window is 100%
    // used" filed five desks as their own failures.
    test: /weekly (usage )?limit|usage limit (reached|exceeded)|reached your (weekly|usage) limit|window is (100% used|spent)/i,
  },
  {
    // The provider out of capacity is not the account's cap: it passes in
    // minutes, not at a reset (Codex review).
    key: "model-busy",
    label: "The model provider is overloaded",
    fix: "the provider's capacity, not the desks; rerun in a few minutes.",
    test: /overloaded_error|\b529\b[^\n]{0,40}overloaded|overloaded[^\n]{0,40}\b529\b/i,
  },
  {
    key: "worker",
    label: "The platform lost the run",
    fix: "a worker restarted mid-run; rerun it.",
    test: /worker (restarted|was restarted|died|lost)|run was orphaned|lost its worker/i,
  },
];

/** Whether a failure reason is the platform's, and which kind. */
export function platformCause(reason: string | null | undefined): PlatformCause | null {
  if (!reason) return null;
  const hit = PLATFORM_CAUSES.find((c) => c.test.test(reason));
  return hit ? { key: hit.key, label: hit.label, fix: hit.fix } : null;
}

/** A short stable id from the issue's key (FNV-1a, 64 bits as two halves). */
function idOf(key: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ key.length;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `iss_${a.toString(36)}${b.toString(36)}`;
}

/** Which issue a run belongs to, or null when it is not a problem. */
export function issueKeyOf(r: IssueRun): { id: string; kind: IssueKind; agent: string | null; cause: PlatformCause | null } | null {
  if (r.missed) return { id: idOf(`missed\u0000${r.workspace}\u0000${r.what}`), kind: "missed", agent: null, cause: null };
  if (r.outcome === "failed") {
    const cause = platformCause(r.failure?.reason);
    if (cause) return { id: idOf(`platform\u0000${cause.key}`), kind: "platform", agent: null, cause };
    const agent = r.failure?.agent ?? null;
    return { id: idOf(`failed\u0000${r.workspace}\u0000${r.what}\u0000${agent ?? ""}`), kind: "failed", agent, cause: null };
  }
  if (r.outcome === "blocked" || r.outcome === "bad") {
    return { id: idOf(`${r.outcome}\u0000${r.workspace}\u0000${r.what}`), kind: r.outcome, agent: null, cause: null };
  }
  return null;
}

const ACTION: Record<Exclude<IssueKind, "platform">, string> = {
  failed: "Read why it failed, fix the flow or agent, then rerun",
  blocked: "Clear what it is waiting on (a login, a key, an input), then rerun",
  bad: "Read what it found and decide what to do",
  missed: "Check why it did not start: the flow or the account paused, out of credit, or the scheduler down — then run it by hand",
};

const lastOf = (h: IssueEvent[], actions: IssueAction[]) => [...h].reverse().find((e) => actions.includes(e.action)) ?? null;

/**
 * Every issue the runs show, with what people did to them folded in.
 * `states` is keyed by issue id. Resolved issues are kept (with their last
 * occurrences) while their runs are still in the window, so their history
 * can be read; a status filter is the caller's.
 */
export function foldIssues(
  runs: Iterable<IssueRun>,
  states: Record<string, IssueState>,
  now: number,
  /** `autoClose(workspace, flow)`: the flow says `issues: auto-close`, so a
   *  run that goes fine after a failure closes it (FOL-72 step 7). Never a
   *  platform cause or a missed schedule — those stay until a person says. */
  opts: { autoClose?: (workspace: string, what: string) => boolean } = {},
): Issue[] {
  // When it went wrong (or right): its end, else its start. A run that
  // started before a resolve and failed after it is news, and of two
  // overlapping failures the one that ended last is the newest (Codex review).
  const occurred = (r: IssueRun) => r.finishedAt ?? r.startedAt;
  const all = [...runs].sort((a, b) => occurred(a).localeCompare(occurred(b)));
  // The last run of each desk's flow to finish, to say "fine since" — only
  // when it is itself fine, and finished after the issue's last occurrence
  // (a success between two failures, or one that overlapped a later
  // failure, is not a recovery — Codex review).
  const newestDone = new Map<string, IssueRun>();
  for (const r of all) {
    if (r.outcome === "running" || r.outcome === "queued" || r.outcome === "waiting") continue;
    const k = `${r.workspace}\u0000${r.what}`;
    const cur = newestDone.get(k);
    if (!cur || occurred(r) >= occurred(cur)) newestDone.set(k, r);
  }
  const fine = (o: Outcome) => o === "good" || o === "done" || o === "quiet";

  const groups = new Map<string, { key: NonNullable<ReturnType<typeof issueKeyOf>>; runs: IssueRun[] }>();
  for (const r of all) {
    const key = issueKeyOf(r);
    if (!key) continue;
    const g = groups.get(key.id) ?? { key, runs: [] };
    g.runs.push(r);
    groups.set(key.id, g);
  }

  const out: Issue[] = [];
  for (const [id, { key, runs: hit }] of groups) {
    const history = states[id]?.history ?? [];
    const res = lastOf(history, ["resolve", "reopen"]);
    // Replay the runs and the resolves/reopens in time order: a run going
    // wrong after a resolve starts a new episode, a resolve closes the
    // current one, a reopen carries it on. The issue shows its current (or
    // last closed) episode — never every one ever closed. A run that ended
    // at the moment of a resolve was closed by it. (Codex review, in rounds.)
    // In a flow that says `issues: auto-close`, every run of it that went
    // fine closes the episode as a resolve would, marked as the platform's.
    const auto = key.kind !== "platform" && key.kind !== "missed" && hit[0] && opts.autoClose?.(hit[0].workspace, hit[0].what) === true;
    const fineRuns = auto ? all.filter((r) => r.workspace === hit[0]!.workspace && r.what === hit[0]!.what && fine(r.outcome)) : [];
    const timeline = [
      ...hit.map((r) => ({ t: occurred(r), order: 0, run: r as IssueRun | null, act: null as IssueAction | "auto" | null })),
      ...history.filter((e) => e.action === "resolve" || e.action === "reopen").map((e) => ({ t: e.at, order: 1, run: null, act: e.action as IssueAction | "auto" })),
      ...fineRuns.map((r) => ({ t: occurred(r), order: 1, run: null, act: "auto" as const })),
    ].sort((a, b) => a.t.localeCompare(b.t) || a.order - b.order);
    let shown: IssueRun[] = [];
    let closed = false;
    let closedBy: "person" | "auto" | null = null;
    let autoAt: string | null = null;
    // The last time the platform closed it: an acknowledge or a snooze from
    // before then belongs to the episode it closed (Codex review).
    let lastAutoClose: string | null = null;
    let episodes = 0;
    for (const ev of timeline) {
      if (ev.run) {
        if (closed || !shown.length) {
          shown = [];
          episodes++;
        }
        closed = false;
        shown.push(ev.run);
      } else if (ev.act === "resolve" || (ev.act === "auto" && shown.length)) {
        closed = true;
        closedBy = ev.act === "auto" ? "auto" : "person";
        if (ev.act === "auto") {
          autoAt = ev.t;
          lastAutoClose = ev.t;
        }
      } else if (ev.act === "reopen") closed = false;
    }
    if (!shown.length) continue;
    const resolvedAt = closed ? (closedBy === "auto" ? autoAt : res?.action === "resolve" ? res.at : null) : null;
    const newest = shown[shown.length - 1]!;
    // A snooze holds while its time has not come and, for "until N more",
    // while fewer than N have happened since it.
    const current = (e: IssueEvent | null) => (e && (!lastAutoClose || e.at > lastAutoClose) ? e : null);
    const snoozeEv = current(lastOf(history, ["snooze", "resolve", "reopen"]));
    const since = snoozeEv?.action === "snooze" ? shown.filter((r) => occurred(r) > snoozeEv.at).length : 0;
    const snoozeLeft = snoozeEv?.action === "snooze" && snoozeEv.untilCount ? Math.max(0, snoozeEv.untilCount - since) : null;
    const snoozeHolds =
      snoozeEv?.action === "snooze" &&
      (!snoozeEv.until || Date.parse(snoozeEv.until) > now) &&
      (snoozeLeft === null || snoozeLeft > 0) &&
      Boolean(snoozeEv.until || snoozeEv.untilCount);
    const status: IssueStatus = (() => {
      if (resolvedAt) return "resolved";
      if (snoozeHolds) return "snoozed";
      const ack = current(lastOf(history, ["acknowledge", "resolve", "reopen"]));
      if (ack?.action === "acknowledge") return "acknowledged";
      return "open";
    })();
    const ack = current(lastOf(history, ["acknowledge", "resolve", "reopen"]));
    const flowKey = `${newest.workspace}\u0000${newest.what}`;
    const last = key.kind === "platform" ? null : newestDone.get(flowKey) ?? null;
    const ok = last && fine(last.outcome) && occurred(last) > occurred(newest) ? occurred(last) : null;
    const workspaces = [...new Set(shown.map((r) => r.workspace))].sort();
    out.push({
      id,
      kind: key.kind,
      status,
      workspace: newest.workspace,
      workspaces,
      what: key.cause ? key.cause.label : newest.what,
      agent: key.agent,
      reason: key.kind === "missed"
        ? newest.headline ?? `due ${newest.startedAt}, no run started`
        : key.cause
        ? newest.failure ? `${newest.failure.agent}: ${newest.failure.reason}` : key.cause.label
        : newest.failure ? `${newest.failure.agent}: ${newest.failure.reason}` : newest.headline?.trim() || newest.outcome,
      action: key.cause ? `Fix ${key.cause.fix}` : ACTION[key.kind as Exclude<IssueKind, "platform">],
      firstSeen: occurred(shown[0]!),
      lastSeen: occurred(newest),
      count: shown.length,
      runs: shown.slice(-20).reverse().map((r) => ({ workspace: r.workspace, id: r.id, at: occurred(r), ...(r.missed ? { missed: true } : {}) })),
      recoveredAt: ok,
      acknowledged: ack?.action === "acknowledge" ? { at: ack.at, by: ack.by } : null,
      snoozedUntil: status === "snoozed" && snoozeEv?.until ? snoozeEv.until : null,
      snoozedFor: status === "snoozed" ? snoozeLeft : null,
      regressed: episodes > 1,
      sinceRevision: shown[0]!.revision ?? null,
      // Only while it is resolved; once it happens again, the history says it was.
      resolved:
        status === "resolved"
          ? closedBy === "auto"
            ? { at: resolvedAt!, by: "auto: a later run went fine" }
            : res
              ? { at: res.at, by: res.by }
              : null
          : null,
      history,
    });
  }
  const rank: Record<IssueStatus, number> = { open: 0, acknowledged: 1, snoozed: 2, resolved: 3 };
  const kindRank: Record<IssueKind, number> = { platform: 0, missed: 1, failed: 2, blocked: 3, bad: 4 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || kindRank[a.kind] - kindRank[b.kind] || b.lastSeen.localeCompare(a.lastSeen));
}

/** An issue still asking for someone: open or acknowledged, not snoozed or resolved. */
export const isActiveIssue = (i: Issue) => i.status === "open" || i.status === "acknowledged";

/**
 * What the run doctor needs to look at an issue: its newest run, the
 * workspace that run is in (the assistant works inside one), and the
 * question the run page's Doctor button asks — so the issue's button, the
 * CLI's `issues doctor` and the run page put it the same way. Null for a
 * missed schedule, which has no run to read.
 */
export function issueDoctor(issue: Pick<Issue, "kind" | "runs">): { workspace: string; runId: string; prompt: string } | null {
  const run = issue.runs.find((r) => !r.missed);
  if (!run || issue.kind === "missed") return null;
  const ended = issue.kind === "blocked" ? "end BLOCKED" : issue.kind === "bad" ? "end BAD" : "fail";
  return { workspace: run.workspace, runId: run.id, prompt: `Doctor: why did run ${run.id} ${ended}, and how do I fix it?` };
}

/** Parse "30m", "4h", "1d", "1w" into milliseconds; null if not one. */
export function snoozeMs(s: string): number | null {
  const m = /^(\d+)\s*(m|h|d|w)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as "m" | "h" | "d" | "w"];
  return n > 0 ? n * unit : null;
}

/** One person's act on an issue, appended to its history. Refuses a snooze
 *  with no future `until`. Pure: the caller stores the result. */
export function applyIssueAction(state: IssueState | null, ev: IssueEvent, now: number): IssueState {
  if (ev.action === "snooze" && !(ev.until && Date.parse(ev.until) > now) && !(typeof ev.untilCount === "number" && ev.untilCount > 0)) {
    throw new Error("a snooze needs a time in the future, or a number of times it may happen again");
  }
  const history = [...(state?.history ?? []), ev];
  // Bounded: an issue snoozed every morning for a year is still one row. The
  // newest of each kind of act is always kept, whatever its age, because the
  // issue's state is read from them — dropping the last resolve would bring
  // back what it closed (Codex review).
  if (history.length <= 100) return { history };
  const keep = new Set(history.map((_, i) => i).slice(-100));
  for (const a of ["acknowledge", "snooze", "resolve", "reopen"] as IssueAction[]) {
    const i = history.map((e) => e.action).lastIndexOf(a);
    if (i >= 0) keep.add(i);
  }
  // Every resolve and reopen: the episodes an issue shows are replayed from
  // them, and each one is a person's act, so there are few (Codex review).
  history.forEach((e, i) => (e.action === "resolve" || e.action === "reopen") && keep.add(i));
  return { history: history.filter((_, i) => keep.has(i)) };
}
