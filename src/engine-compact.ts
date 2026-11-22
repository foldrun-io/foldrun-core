// Compaction for foldrun's own loop (FOL-213): a conversation nearing the
// model's context window has its older part summarised, so a long session
// goes on instead of failing with "the conversation filled the model's
// context window".
//
// The approach and the summary prompts are Pi's (earendil-works/pi,
// packages/coding-agent, core/compaction), ported to the loop's
// Anthropic-shaped messages:
//   - keep the newest ~20k tokens as they are;
//   - cut only at a user turn or a model turn — never between a tool call
//     and its result, which must follow it;
//   - the model writes a structured checkpoint (Goal, Constraints, Progress,
//     Decisions, Next steps, Critical context) of everything before the cut;
//     a later compaction updates the earlier summary rather than summarising
//     a summary;
//   - the files read and changed are listed after it, from the calls that
//     actually ran (the input as the hooks left it, and only calls that did
//     not fail) — not from what the model asked for.
//
// Pi is under the MIT licence:
//
//   MIT License
//
//   Copyright (c) 2025 Mario Zechner
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

type Json = Record<string, unknown>;
type Block = Json & { type: string };
export type Message = { role: string; content: Block[] };

/** What the loop uses unless a caller says otherwise: Pi's defaults, and
 *  the context window of the Claude models foldrun's tiers name. A model
 *  with a smaller window is still caught when the endpoint says the prompt
 *  is too long (the loop compacts then and asks again, once). */
export const COMPACTION_DEFAULTS = { contextWindow: 200_000, reserveTokens: 16_384, keepRecentTokens: 20_000 };
/** The smallest window compaction will work in. */
export const MIN_CONTEXT_WINDOW = 8_192;

/** Pi's numbers for a large window; a small one keeps a quarter for the
 *  reply and summarises down to about a third of it. */
export function compactionFor(contextWindow: number): { contextWindow: number; reserveTokens: number; keepRecentTokens: number } {
  return {
    contextWindow,
    reserveTokens: Math.min(COMPACTION_DEFAULTS.reserveTokens, Math.floor(contextWindow / 4)),
    keepRecentTokens: Math.min(COMPACTION_DEFAULTS.keepRecentTokens, Math.floor(contextWindow * 0.3)),
  };
}

export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

${FORMAT}`;

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

${FORMAT}`;

const IMAGE_CHARS = 4800;
const TOOL_RESULT_MAX_CHARS = 2000;
/** A message's own words in the summarising request, at most. */
const MESSAGE_MAX_CHARS = 20_000;

const isSummaryBlock = (b: Block | undefined): boolean => b?.type === "text" && String(b.text ?? "").startsWith(SUMMARY_PREFIX);

function blockChars(b: Block): number {
  if (b.type === "text") return String(b.text ?? "").length;
  if (b.type === "thinking") return String(b.thinking ?? "").length;
  if (b.type === "image") return IMAGE_CHARS;
  if (b.type === "tool_use") return String(b.name ?? "").length + JSON.stringify(b.input ?? {}).length;
  if (b.type === "tool_result") {
    const c = b.content;
    return typeof c === "string" ? c.length : Array.isArray(c) ? (c as Block[]).reduce((n, x) => n + blockChars(x), 0) : 0;
  }
  return JSON.stringify(b).length;
}

/** Tokens a message comes to, by four characters a token: an overestimate,
 *  which is the safe side here. */
export function estimateTokens(m: Message): number {
  return Math.ceil(m.content.reduce((n, b) => n + blockChars(b), 0) / 4);
}

/** Every place a cut may go, after the first message. */
export function cutPoints(messages: Message[]): number[] {
  const cuts: number[] = [];
  for (let j = 1; j < messages.length; j++) if (isCutPoint(messages[j])) cuts.push(j);
  return cuts;
}

/** A message may begin the kept part when it is a model turn or a user turn
 *  that answers no tool call: a tool result must stay after its call. */
function isCutPoint(m: Message): boolean {
  if (m.role === "assistant") return true;
  return m.role === "user" && !m.content.some((b) => b.type === "tool_result");
}

/** Where the kept part starts: walking back from the newest message until
 *  `keep` tokens are behind, then forward to the first place a cut may go.
 *  When even the newest messages come to less than `keep`, everything from
 *  the first place a cut may go is kept (a large first message is what
 *  gets summarised). A kept part larger than `maxKeep` moves to a later
 *  cut, so a summary actually makes room. -1 when there is nowhere to cut. */
export function findCut(messages: Message[], keep: number, maxKeep = Infinity): number {
  const cuts = cutPoints(messages);
  if (!cuts.length) return -1;
  // Each message's estimate once; what is kept from j on is suffix[j].
  const suffix = new Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + estimateTokens(messages[i]);
  const tail = (j: number) => suffix[j];
  let chosen = cuts[0];
  let acc = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    acc += estimateTokens(messages[i]);
    if (acc >= keep) {
      // The nearest cut at or after it; past the last one (one large tool
      // result alone over the budget), the call with its result, as Pi does.
      chosen = cuts.find((j) => j >= i) ?? cuts[cuts.length - 1];
      break;
    }
  }
  for (const j of cuts) if (j > chosen && tail(chosen) > maxKeep) chosen = j;
  return chosen;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return `${text.slice(0, end)}\n\n[... ${text.length - end} more characters truncated]`;
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as Block[]).map((b) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

/** The conversation as text, so the summarising model reads it rather than
 *  continuing it. Thinking is left out; tool results are cut to 2,000
 *  characters each; the earlier summary's own block is left to the update
 *  prompt. */
export function serializeConversation(messages: Message[], maxChars = Infinity): string {
  const parts: string[] = [];
  messages.forEach((m, at) => {
    if (m.role === "user") {
      const said: string[] = [];
      m.content.forEach((b, k) => {
        if (b.type === "tool_result") {
          const t = textOf(b.content);
          if (t) parts.push(`[Tool result${b.is_error ? " (error)" : ""}]: ${truncate(t, TOOL_RESULT_MAX_CHARS)}`);
        } else if (b.type === "text") {
          // The earlier summary is the update prompt's, not conversation —
          // only where compaction puts it: the first block of the first turn.
          if (!(at === 0 && k === 0 && isSummaryBlock(b))) said.push(String(b.text ?? ""));
        } else if (b.type === "image") said.push("[image]");
      });
      // The cap is the message's, across its blocks.
      if (said.join("").trim()) parts.push(`[User]: ${truncate(said.join("\n"), MESSAGE_MAX_CHARS)}`);
    } else if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n").trim();
      if (text) parts.push(`[Assistant]: ${truncate(text, MESSAGE_MAX_CHARS)}`);
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => {
        const args = Object.entries((b.input ?? {}) as Json).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
        return `${String(b.name)}(${args})`;
      });
      if (calls.length) parts.push(`[Assistant tool calls]: ${truncate(calls.join("; "), MESSAGE_MAX_CHARS)}`);
    }
  });
  // Still too long for the summarising request: the newest part is kept,
  // what is cut is said.
  let text = parts.join("\n\n");
  if (text.length > maxChars) {
    let start = text.length - maxChars;
    if (/[\uDC00-\uDFFF]/.test(text[start] ?? "")) start++;
    text = `[... the first ${start} characters of the conversation are left out]\n\n${text.slice(start)}`;
  }
  return text;
}

/** The earlier summary, when the conversation starts with one. */
export function previousSummary(messages: Message[]): string | null {
  const first = messages[0]?.content[0];
  if (!first || !isSummaryBlock(first)) return null;
  const t = String(first.text);
  return t.slice(SUMMARY_PREFIX.length, t.endsWith(SUMMARY_SUFFIX) ? t.length - SUMMARY_SUFFIX.length : undefined);
}

/** The text the summarising model is sent. */
export function summaryRequest(toSummarize: Message[], earlier: string | null, maxChars = Infinity): string {
  // The earlier summary counts against the same budget: at most half of
  // it, the conversation the rest.
  const prior = earlier && Number.isFinite(maxChars) ? truncate(earlier, Math.floor(maxChars / 2)) : earlier;
  const left = Number.isFinite(maxChars) ? Math.max(1_000, maxChars - (prior?.length ?? 0)) : Infinity;
  let text = `<conversation>\n${serializeConversation(toSummarize, left)}\n</conversation>\n\n`;
  if (prior) text += `<previous-summary>\n${prior}\n</previous-summary>\n\n`;
  return text + (earlier ? UPDATE_PROMPT : SUMMARIZATION_PROMPT);
}

/** The files the summary lists after it: read only, and changed. */
export function fileLists(read: Set<string>, changed: Set<string>): string {
  const readOnly = [...read].filter((f) => !changed.has(f)).sort();
  const sections: string[] = [];
  if (readOnly.length) sections.push(`<read-files>\n${readOnly.join("\n")}\n</read-files>`);
  if (changed.size) sections.push(`<modified-files>\n${[...changed].sort().join("\n")}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

/** The conversation after compaction: the summary, then the kept part. The
 *  summary leads the first user turn (the turns must alternate, starting
 *  with the user's): it joins the kept part's first message when that is
 *  the user's, or comes before it as its own when the kept part opens on a
 *  model turn. */
export function compacted(summary: string, kept: Message[]): Message[] {
  const block: Block = { type: "text", text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` };
  if (kept[0]?.role === "user") return [{ role: "user", content: [block, ...kept[0].content] }, ...kept.slice(1)];
  return [{ role: "user", content: [block] }, ...kept];
}

/** An endpoint's refusal that means the prompt did not fit: a 400 or 413
 *  that says so. Any other status is not, whatever its words. */
export function isContextOverflow(status: number | undefined, message: string): boolean {
  if (status !== 400 && status !== 413) return false;
  return /prompt is too long|input is too long|maximum context length|context length exceeded|(exceeds?|exceeded) (the )?(model's )?(maximum )?context( window| length)?|too many (input )?tokens/i.test(message);
}
