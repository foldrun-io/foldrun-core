// A person in the loop while a step runs: the agent asks, a person answers,
// or a person says something the agent should hear.
//
// Until this, the only way a person reached a step was before it started —
// `ask:`, an approval gate, `wait: event` — and the answer arrived as
// prompt text. An agent that found, halfway through, that it needed a
// decision had to fail or guess.
//
// Two things, one line out of the sandbox. A run pod has no ingress; the
// only live door is the worker's egress proxy, reached at the per-step
// lease address the pod already holds (FOLDRUN_EGRESS = http://<w>/e/<lease>).
// The lease names the account and the run, so a step can only ever ask in,
// or read the inbox of, its own run.
//
//   tools: [ask]   the agent gets `ask_person` — POST the question, then
//                  long-poll for the answer; the step's sandbox is held
//                  (and charged) while it waits, up to `ask: {timeout}`
//   every step     after each tool call, its run's inbox is read and any
//                  message is handed to the model as context
//
// Both leave a trace event with an `operator` field, which the runner turns
// into step.questions / step.messages on the record.
//
// And a third line, between colleagues (20 Oct 2026):
//
//   tools: [peers]  the agent gets `peers_list` and `peers_message` — who
//                   else is running in its parallel group right now, and a
//                   message to one of them (or all). It lands in the
//                   sibling's own inbox, so it reaches that model after its
//                   next tool call, the same door a person's message uses,
//                   and the sender hears any reply the same way. A step that
//                   finds mid-way that it needs something a sibling has —
//                   a file name, a decision, a number — asks for it instead
//                   of guessing or failing. Nothing waits: the step goes on
//                   and the answer, if one comes, arrives as context.
//
// Peer messages travel the person's inbox with `by` set to `peer:<agent>`,
// so the reader can tell a colleague from a person without a second store
// or a second door on the proxy.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { EventExtra } from "./step-exec.ts";
import type { StepMessage, StepQuestion } from "./store.ts";

/** What a trace event carries when a person was involved. */
export type OperatorEvent =
  | { kind: "asked"; id: string; question: string; options?: string[] }
  | { kind: "answered"; id: string; answer: string; by?: string | null }
  | { kind: "unanswered"; id: string }
  | { kind: "message"; text: string; by?: string | null; at: string }
  /** A colleague running beside this step sent it a message (tools: [peers]). */
  | { kind: "peer"; from: string; text: string; at: string }
  /** This step sent a colleague a message. `to` is the agents it reached. */
  | { kind: "told"; to: string[]; text: string; at: string };

/** A step running in the same parallel group, as its siblings see it. */
export interface PeerInfo {
  /** The sibling's agent name — what `peers_message` is addressed to. */
  agent: string;
  /** Its index in run.steps: which inbox a message to it goes to. */
  step: number;
  /** The first line of its instruction, so a sibling knows what it is on. */
  instruction: string;
}

/** A sibling's address: `agent#step`, the step as the flow numbers it
 *  (1-based). A fan-out's instances share an agent name, so the bare name
 *  reaches every instance and the address reaches one. */
export const peerAddress = (p: { agent: string; step: number }): string => `${p.agent}#${p.step + 1}`;
/** Does `to` name this sibling? `all`, its agent name, or its address. */
export const peerMatches = (p: PeerInfo, to: string): boolean => to === "all" || to === p.agent || to === peerAddress(p);

/** `by` on an inbox message from a colleague, not a person: `peer:<address>`. */
export const PEER_BY_PREFIX = "peer:";
export const peerOf = (by: string | null | undefined): string | null =>
  typeof by === "string" && by.startsWith(PEER_BY_PREFIX) ? by.slice(PEER_BY_PREFIX.length) : null;

export interface OperatorMessage {
  text: string;
  by?: string | null;
  at: string;
}

/** The pod's side of the line. `null` when there is no proxy (the CLI, a
 *  compose install without one): then nobody can answer or write in. */
export interface OperatorChannel {
  ask(question: string, options?: string[]): Promise<{ id: string }>;
  /** Waits up to `maxMs` for this question's answer; null when none came. */
  poll(id: string, maxMs: number): Promise<{ answer: string; by?: string | null } | null>;
  inbox(): Promise<OperatorMessage[]>;
  /** Nobody will read this question's answer now (the wait timed out):
   *  stop offering it to people. Best effort; optional for fakes. */
  close?(id: string): Promise<void>;
  /** tools: [peers] — the siblings this step may message, as the lease
   *  carries them; empty when the step runs alone. Optional: an older
   *  proxy, or a fake, has no colleagues to offer. */
  peers?(): Promise<PeerInfo[]>;
  /** Leave `text` in the inbox of the sibling named `to` (or of every
   *  sibling, `"all"`). Resolves with the agents it reached. */
  tell?(to: string, text: string): Promise<{ to: string[] }>;
  /** `sandbox: own` sub-agents (delegate-tools.ts): hand `agent` a job. The
   *  worker runs it in its own sandbox; only the reply comes back. Optional:
   *  an older proxy has no delegate door. */
  delegate?(agent: string, job: string): Promise<{ id: string }>;
  /** Waits up to `maxMs` for that job to finish; null while it still runs. */
  delegation?(id: string, maxMs: number): Promise<DelegationResult | null>;
  /** The parent stopped waiting (its step ended): stop the job. Best effort. */
  cancelDelegation?(id: string): Promise<void>;
}

/** How an isolated sub-agent's job ended, as the delegating step hears it. */
export interface DelegationResult {
  status: "completed" | "failed" | "skipped";
  /** Its reply — all the parent sees of its work. */
  result: string;
  /** Workspace paths it changed. They reach the workspace when it ends, so
   *  the next step sees them; the delegating step's own sandbox does not. */
  wrote?: string[];
  /** What it wrote, copied back into the delegating step's sandbox, so the
   *  parent's model and its `verify:` see it there (copyBackFiles), base64. */
  files?: { path: string; base64: string }[];
  /** Written paths too large to copy back: they reach the workspace when the
   *  job ends, so the next step sees them. */
  filesOmitted?: string[];
}

export const QUESTION_MAX = 2_000;
export const OPTION_MAX = 200;
export const OPTIONS_MAX = 10;
export const ANSWER_MAX = 4_000;
export const MESSAGE_MAX = 4_000;
/** One long-poll round trip — under any proxy's idle cut-off. */
export const POLL_MS = 25_000;
export const ASK_DEFAULT_SEC = 30 * 60;
export const ASK_MAX_SEC = 24 * 60 * 60;

/** `http://w:8090/e/<lease>` → the proxy's origin and the lease token. */
export function operatorEndpoint(egress: string | undefined | null): { base: string; token: string } | null {
  if (!egress) return null;
  const m = egress.match(/^(https?:\/\/[^/]+)\/e\/([A-Za-z0-9_-]{16,})\/?$/);
  return m ? { base: m[1], token: m[2] } : null;
}

/** The channel over the egress proxy. `fetchImpl` is for tests. */
export function httpChannel(egress: string | undefined | null, fetchImpl: typeof fetch = fetch): OperatorChannel | null {
  const ep = operatorEndpoint(egress);
  if (!ep) return null;
  const json = async (res: Response) => {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String((body.error as { message?: string } | undefined)?.message ?? `proxy answered ${res.status}`));
    return body;
  };
  return {
    async ask(question, options) {
      const body = await json(
        await fetchImpl(`${ep.base}/ask/${ep.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question, options }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
      return { id: String(body.id) };
    },
    async poll(id, maxMs) {
      const wait = Math.max(0, Math.min(maxMs, POLL_MS));
      const body = await json(
        await fetchImpl(`${ep.base}/ask/${ep.token}/${encodeURIComponent(id)}?wait=${wait}`, {
          signal: AbortSignal.timeout(wait + 15_000),
        }),
      );
      return typeof body.answer === "string" ? { answer: body.answer, by: (body.by as string | null) ?? null } : null;
    },
    async inbox() {
      const body = await json(await fetchImpl(`${ep.base}/inbox/${ep.token}`, { signal: AbortSignal.timeout(3_000) }));
      return Array.isArray(body.messages) ? (body.messages as OperatorMessage[]) : [];
    },
    async close(id) {
      await json(
        await fetchImpl(`${ep.base}/ask/${ep.token}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(5_000),
        }),
      );
    },
    async peers() {
      const body = await json(await fetchImpl(`${ep.base}/peers/${ep.token}`, { signal: AbortSignal.timeout(5_000) }));
      return Array.isArray(body.peers) ? (body.peers as PeerInfo[]) : [];
    },
    async tell(to, text) {
      const body = await json(
        await fetchImpl(`${ep.base}/peers/${ep.token}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to, text }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
      return { to: Array.isArray(body.to) ? (body.to as string[]) : [] };
    },
    async delegate(agent, job) {
      const body = await json(
        await fetchImpl(`${ep.base}/delegate/${ep.token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agent, job }),
          signal: AbortSignal.timeout(15_000),
        }),
      );
      return { id: String(body.id) };
    },
    async delegation(id, maxMs) {
      const wait = Math.max(0, Math.min(maxMs, POLL_MS));
      const body = await json(
        await fetchImpl(`${ep.base}/delegate/${ep.token}/${encodeURIComponent(id)}?wait=${wait}`, {
          signal: AbortSignal.timeout(wait + 15_000),
        }),
      );
      const status = body.status;
      if (status !== "completed" && status !== "failed" && status !== "skipped") return null;
      return {
        status,
        result: typeof body.result === "string" ? body.result : "",
        wrote: Array.isArray(body.wrote) ? (body.wrote as unknown[]).filter((w): w is string => typeof w === "string") : [],
        files: Array.isArray(body.files)
          ? (body.files as unknown[]).filter(
              (f): f is { path: string; base64: string } =>
                !!f && typeof (f as { path?: unknown }).path === "string" && typeof (f as { base64?: unknown }).base64 === "string",
            )
          : [],
        filesOmitted: Array.isArray(body.filesOmitted) ? (body.filesOmitted as unknown[]).filter((w): w is string => typeof w === "string") : [],
      };
    },
    async cancelDelegation(id) {
      await json(
        await fetchImpl(`${ep.base}/delegate/${ep.token}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(5_000),
        }),
      );
    },
  };
}

/**
 * The colleagues' line for steps that run in this process (`foldrun run`
 * on a laptop, a host without a proxy): one bus per run, an inbox per step,
 * the same shape the proxy serves. A person has no door here — nobody can
 * write in from outside — but siblings can still reach each other.
 */
export function localPeerBus() {
  const inboxes = new Map<number, OperatorMessage[]>();
  /** Steps that have ended: off every roster, and a message to one reaches
   *  nobody — it would never be read. */
  const gone = new Set<number>();
  const live = (siblings: PeerInfo[]) => siblings.filter((p) => !gone.has(p.step));
  return {
    /** The step is over (however it ended): nobody can reach it now. */
    leave(step: number) {
      gone.add(step);
      inboxes.delete(step);
    },
    /** The channel for one step: who its siblings are, and its own inbox. */
    channelFor(self: { agent: string; step: number }, siblings: PeerInfo[]): OperatorChannel {
      return {
        async ask() {
          throw new Error("nobody can answer here");
        },
        async poll() {
          return null;
        },
        async inbox() {
          const mine = inboxes.get(self.step) ?? [];
          inboxes.delete(self.step);
          return mine;
        },
        async peers() {
          return live(siblings);
        },
        async tell(to, text) {
          const targets = live(siblings).filter((p) => peerMatches(p, to));
          const at = new Date().toISOString();
          for (const p of targets) {
            const list = inboxes.get(p.step) ?? [];
            list.push({ text: text.slice(0, MESSAGE_MAX), by: PEER_BY_PREFIX + peerAddress(self), at });
            inboxes.set(p.step, list.slice(-50));
          }
          return { to: targets.map(peerAddress) };
        },
      };
    },
  };
}

/** `ask: {timeout: 2h}` in an agent's frontmatter → seconds, clamped. */
export function askTimeoutSec(front: Record<string, unknown>): number {
  const raw = (front.ask as { timeout?: unknown } | undefined)?.timeout;
  const sec = parseDuration(raw);
  return sec === null ? ASK_DEFAULT_SEC : Math.min(Math.max(sec, 30), ASK_MAX_SEC);
}

/** "90s", "30m", "2h", "1d" or a number of seconds; null when unreadable. */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return null;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s").toLowerCase() as "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * mult);
}

export const NO_ANSWER =
  "No one answered in time. Decide for yourself if the choice is safe and say what you chose and why; if it is not, stop and reply BLOCKED with the question.";

type Emit = (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;

/** The in-sandbox `ask_person` tool. With no channel (no proxy), `local`
 *  answers instead — the CLI prompts on a terminal — or nobody does. */
export function buildAskTool(opts: {
  channel: OperatorChannel | null;
  timeoutSec: number;
  emit: Emit;
  local?: (question: string, options?: string[]) => Promise<string | null>;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const ask = tool(
    "ask_person",
    "Ask the person running this desk a question and wait for their answer. Use it for a decision you cannot make safely yourself — not for information you can look up. Give a short list of options when the answer is one of a few choices. Returns the answer, or says nobody answered in time.",
    {
      question: z.string().describe("The complete, self-contained question — the person has not read your work"),
      options: z.array(z.string()).optional().describe("Up to 10 short choices, when the answer is one of them"),
    },
    async ({ question, options }) => {
      const q = String(question).trim().slice(0, QUESTION_MAX);
      const opts2 = (options ?? []).map((o) => String(o).trim().slice(0, OPTION_MAX)).filter(Boolean).slice(0, OPTIONS_MAX);
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
      if (!q) return { ...text("ask_person needs a question."), isError: true };
      if (!opts.channel) {
        const local = opts.local ? await opts.local(q, opts2.length ? opts2 : undefined) : null;
        const id = "local";
        opts.emit("info", `asked a person: ${q}`, { operator: { kind: "asked", id, question: q, ...(opts2.length ? { options: opts2 } : {}) } });
        if (local === null || local.trim() === "") {
          opts.emit("info", "no answer — nobody can answer here", { operator: { kind: "unanswered", id } });
          return text(NO_ANSWER);
        }
        opts.emit("info", `answered: ${local}`, { operator: { kind: "answered", id, answer: local, by: "terminal" } });
        return text(`The person answered: ${local}`);
      }
      let id: string;
      try {
        ({ id } = await opts.channel.ask(q, opts2.length ? opts2 : undefined));
      } catch (err) {
        return { ...text(`Could not ask: ${err instanceof Error ? err.message : String(err)}. ${NO_ANSWER}`), isError: true };
      }
      opts.emit("info", `asked a person: ${q}`, { operator: { kind: "asked", id, question: q, ...(opts2.length ? { options: opts2 } : {}) } });
      const deadline = now() + opts.timeoutSec * 1000;
      while (now() < deadline) {
        let got: { answer: string; by?: string | null } | null = null;
        try {
          got = await opts.channel.poll(id, deadline - now());
        } catch {
          // A dropped long-poll is retried; the deadline is what ends it.
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }
        if (got) {
          const answer = got.answer.slice(0, ANSWER_MAX);
          opts.emit("info", `answered${got.by ? ` by ${got.by}` : ""}: ${answer}`, { operator: { kind: "answered", id, answer, by: got.by ?? null } });
          return text(`The person answered: ${answer}`);
        }
      }
      // Close it on the proxy, so the dashboard stops offering a box whose
      // answer nobody would read. Best effort: a failure changes nothing here.
      try {
        await opts.channel.close?.(id);
      } catch {
        /* the proxy's TTL clears it eventually */
      }
      opts.emit("info", `no answer after ${Math.round(opts.timeoutSec / 60)} min`, { operator: { kind: "unanswered", id } });
      return text(NO_ANSWER);
    },
  );
  return {
    server: createSdkMcpServer({ name: "foldrun_ask", version: "1.0.0", tools: [ask] }),
    /** The tool's own function, for tests. */
    call: (args: { question: string; options?: string[] }) => ask.handler({ question: args.question, options: args.options }, {}),
    toolNames: [ASK_TOOL],
    promptLines: [askPromptLine(opts.timeoutSec)],
  };
}

/** The granted name of the tool — the same on every path. */
export const ASK_TOOL = "mcp__foldrun_ask__ask_person";

/** The granted names of the colleagues' tools — the same on every path. */
export const PEER_TOOLS = ["mcp__foldrun_peers__peers_list", "mcp__foldrun_peers__peers_message"];
export const PEER_TEXT_MAX = MESSAGE_MAX;

/** The in-sandbox `peers_list` and `peers_message` tools (tools: [peers]).
 *  `siblings` is what the runner knew at launch: the other steps of this
 *  step's parallel group. The channel delivers; with none (no proxy and no
 *  local bus) the tools say so rather than pretend. */
export function buildPeerTools(opts: { channel: OperatorChannel | null; self: string; siblings: PeerInfo[]; emit: Emit; now?: () => number }) {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const roster = () =>
    opts.siblings.length
      ? opts.siblings.map((p) => `- ${peerAddress(p)}: ${p.instruction}`).join("\n")
      : "Nobody: this step runs alone in its group.";
  const list = tool(
    "peers_list",
    "Who else is running beside you right now — the other steps of your parallel group, each as agent#step with what it is doing. Message one with peers_message, addressed as agent#step (or the bare agent name, which reaches every instance of that agent).",
    {},
    async () => {
      let peers = opts.siblings;
      try {
        peers = (await opts.channel?.peers?.()) ?? opts.siblings;
      } catch {
        /* the launch-time roster stands */
      }
      opts.siblings = peers;
      return text(`Running beside you in this group:\n${roster()}`);
    },
  );
  const message = tool(
    "peers_message",
    "Send a short message to a colleague running beside you in this parallel group — to ask for something it has (a file name, a figure, a decision) or to tell it something it needs. It reaches that agent after its next tool call; any reply reaches you the same way, after your next tool call, so carry on working and check what arrives. Not a way to hand over your work.",
    {
      to: z.string().describe("The colleague's address from peers_list (agent#step), its bare agent name (every instance of it), or \"all\" for every sibling"),
      text: z.string().describe("The complete message — the colleague has not read your context; say who you are, what you need and where to put it"),
    },
    async ({ to, text: body }) => {
      const target = String(to).trim();
      const msg = String(body).trim().slice(0, PEER_TEXT_MAX);
      if (!target || !msg) return { ...text("peers_message needs `to` and `text`."), isError: true };
      if (!opts.siblings.some((p) => peerMatches(p, target))) {
        return { ...text(`No colleague named "${target}" runs beside you. ${roster()}`), isError: true };
      }
      if (!opts.channel?.tell) return { ...text("No line to colleagues here (no proxy): the message was not delivered."), isError: true };
      let reached: string[];
      try {
        ({ to: reached } = await opts.channel.tell(target, msg));
      } catch (err) {
        return { ...text(`Could not deliver: ${err instanceof Error ? err.message : String(err)}`), isError: true };
      }
      const at = new Date(opts.now?.() ?? Date.now()).toISOString();
      opts.emit("info", `told ${reached.join(", ") || "nobody"}: ${msg}`, { operator: { kind: "told", to: reached, text: msg, at } });
      if (!reached.length) return text(`Nobody received it: "${target}" is not running beside you now.`);
      return text(`Delivered to ${reached.join(", ")}. It reaches them after their next tool call; a reply reaches you after yours.`);
    },
  );
  return {
    server: createSdkMcpServer({ name: "foldrun_peers", version: "1.0.0", tools: [list, message] }),
    /** The tools' own functions, for tests. */
    list: () => list.handler({}, {}),
    message: (args: { to: string; text: string }) => message.handler(args, {}),
    toolNames: PEER_TOOLS,
    promptLines: [peersPromptLine(opts.siblings)],
  };
}

/** The line the system prompt gets for tools: [peers]. */
export function peersPromptLine(siblings: PeerInfo[]): string {
  const who = siblings.length ? siblings.map((p) => `${peerAddress(p)} (${p.instruction})`).join("; ") : "nobody this run — this step runs alone";
  return (
    `\`peers_list\` names the colleagues running beside you in this step's parallel group: ${who}. ` +
    `\`peers_message\` sends one of them (or all) a short message; it reaches them after their next tool call, and their reply reaches you after yours, as context. ` +
    `Ask a colleague for what it has before you guess or stop; keep working while you wait, and read what arrives.`
  );
}

/** The line the system prompt gets for it. */
export function askPromptLine(timeoutSec: number): string {
  return `\`ask_person\` asks the person running this desk and waits for the answer (up to ${fmtWait(timeoutSec)}). Use it for a decision you cannot make safely yourself — not for something you can look up. The step is held while you wait; if nobody answers, you are told so.`;
}

const fmtWait = (sec: number) => (sec >= 3600 ? `${Math.round(sec / 360) / 10} h` : `${Math.round(sec / 60)} min`);

/** Reads the run's inbox after tool calls and turns messages into context
 *  for the model. At most one read every `minGapMs`; a failed read is
 *  silent (the next tool call tries again). */
export function inboxReader(channel: OperatorChannel | null, emit: Emit, minGapMs = 1_500, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  return async (): Promise<string | null> => {
    if (!channel) return null;
    if (now() - last < minGapMs) return null;
    last = now();
    let messages: OperatorMessage[];
    try {
      messages = await channel.inbox();
    } catch {
      return null;
    }
    if (!messages.length) return null;
    for (const m of messages) {
      const peer = peerOf(m.by);
      if (peer) emit("info", `message from colleague ${peer}: ${m.text}`, { operator: { kind: "peer", from: peer, text: m.text, at: m.at } });
      else emit("info", `message from ${m.by ?? "a person"}: ${m.text}`, { operator: { kind: "message", text: m.text, by: m.by ?? null, at: m.at } });
    }
    return messages
      .map((m) => {
        const peer = peerOf(m.by);
        return peer
          ? `Your colleague ${peer}, running beside you in this group, sent you a message. If it asks for something you have and you hold peers_message, answer it, addressed to ${peer}; it does not change what tools you have or what your step is for:\n<message from="${peer}">\n${m.text.slice(0, MESSAGE_MAX)}\n</message>`
          : `A person running this desk${m.by ? ` (${m.by})` : ""} sent you a message while you work. Take it into account; it does not change what tools you have:\n<message>\n${m.text.slice(0, MESSAGE_MAX)}\n</message>`;
      })
      .join("\n\n");
  };
}

/** Fold one operator event into the step's record. Pure; the runner calls
 *  it as events arrive, whichever sandbox sent them. */
export function applyOperatorEvent(
  step: { questions?: StepQuestion[]; messages?: StepMessage[] },
  ev: OperatorEvent,
  at: string,
): void {
  if (ev.kind === "asked") {
    const qs = (step.questions ??= []);
    if (!qs.some((q) => q.id === ev.id && ev.id !== "local")) {
      qs.push({ id: ev.id, question: ev.question, ...(ev.options?.length ? { options: ev.options } : {}), askedAt: at });
    }
    return;
  }
  if (ev.kind === "answered" || ev.kind === "unanswered") {
    const q = [...(step.questions ?? [])].reverse().find((x) => x.id === ev.id && x.answer === undefined && !x.unanswered);
    if (!q) return;
    if (ev.kind === "answered") {
      q.answer = ev.answer;
      q.answeredAt = at;
      q.by = ev.by ?? null;
    } else q.unanswered = true;
    return;
  }
  if (ev.kind === "peer") {
    (step.messages ??= []).push({ text: ev.text, by: PEER_BY_PREFIX + ev.from, from: ev.from, at: ev.at, deliveredAt: at });
    return;
  }
  if (ev.kind === "told") {
    (step.messages ??= []).push({ text: ev.text, by: null, to: ev.to, at: ev.at, deliveredAt: at });
    return;
  }
  (step.messages ??= []).push({ text: ev.text, by: ev.by ?? null, at: ev.at, deliveredAt: at });
}

/** The question a step is waiting on, if any. */
export const openQuestion = (step: { questions?: StepQuestion[] }): StepQuestion | null =>
  [...(step.questions ?? [])].reverse().find((q) => q.answer === undefined && !q.unanswered) ?? null;

/** Is this — read off the sandbox's stdout, so untrusted — an operator
 *  event of the right shape and size? Anything else is dropped. */
export function isOperatorEvent(v: unknown): v is OperatorEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  const id = str(o.id, 64);
  switch (o.kind) {
    case "asked":
      return id && str(o.question, QUESTION_MAX) &&
        (o.options === undefined || (Array.isArray(o.options) && o.options.length <= OPTIONS_MAX && o.options.every((x) => str(x, OPTION_MAX))));
    case "answered":
      return id && str(o.answer, ANSWER_MAX) && (o.by === undefined || o.by === null || str(o.by, 200));
    case "unanswered":
      return id;
    case "message":
      return str(o.text, MESSAGE_MAX) && str(o.at, 40) && (o.by === undefined || o.by === null || str(o.by, 200));
    case "peer":
      return str(o.text, MESSAGE_MAX) && str(o.at, 40) && str(o.from, 200);
    case "told":
      return str(o.text, MESSAGE_MAX) && str(o.at, 40) && Array.isArray(o.to) && o.to.length <= 50 && o.to.every((x) => str(x, 200));
    default:
      return false;
  }
}
