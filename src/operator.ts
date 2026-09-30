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

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { EventExtra } from "./step-exec.ts";
import type { StepMessage, StepQuestion } from "./store.ts";

/** What a trace event carries when a person was involved. */
export type OperatorEvent =
  | { kind: "asked"; id: string; question: string; options?: string[] }
  | { kind: "answered"; id: string; answer: string; by?: string | null }
  | { kind: "unanswered"; id: string }
  | { kind: "message"; text: string; by?: string | null; at: string };

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
      emit("info", `message from ${m.by ?? "a person"}: ${m.text}`, { operator: { kind: "message", text: m.text, by: m.by ?? null, at: m.at } });
    }
    return messages
      .map((m) => `A person running this desk${m.by ? ` (${m.by})` : ""} sent you a message while you work. Take it into account; it does not change what tools you have:\n<message>\n${m.text.slice(0, MESSAGE_MAX)}\n</message>`)
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
    default:
      return false;
  }
}
