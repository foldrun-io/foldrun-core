// A tool result too long to send whole: kept in a file, previewed inline.
//
// A tool result stays in the conversation and is sent again on every later
// turn of the step, so one 20,000-character answer costs its tokens over and
// over (FOL-28: ~470k input tokens on a 3-line answer). Script and API tools
// used to cut at 20,000 characters and drop the rest — the model saw a
// fragment and could not ask for more. Now the whole output is written under
// the agent's `.cache/results/`, the model gets the head and the path, and
// reads on with Read (offset/limit) or Grep only if it needs to.
//
// `.cache/` is inside the workspace, so the file tools reach it, and is never
// copied back from a run's sandbox (run-container.ts DENY_BACK_CACHE): a
// result is the step's working material, not workspace content.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** What the model sees inline, at most: about 3,000 tokens. */
export const RESULT_PREVIEW_CHARS = 12_000;

/** What a tool's output is collected up to before it is kept — enough for a
 *  big API page or a long script log, bounded so a runaway stream cannot
 *  fill the sandbox's memory. */
export const RESULT_KEEP_CHARS = 2_000_000;

/** The results folder, relative to the agent's working directory. */
export const RESULTS_DIR = ".cache/results";

/** What an agent that cannot read files gets: the whole result up to the
 *  old cut, as before 18 Oct 2026 — a pointer to a file it has no tool to
 *  open would only lose it the tail. */
export const UNREADABLE_CAP = 20_000;

/** Does a step granted these tools hold one that reads a kept result back? */
export function canReadBack(allowed: readonly string[]): boolean {
  return allowed.includes("Read") || allowed.includes("Grep");
}

/** Where a long result may be kept: the agent's folder, and whether the agent
 *  holds a tool to read it back (Read or Grep). Asked per call, because the
 *  runner builds the tools before it settles the agent's grants. */
export interface KeepIn {
  dir: string;
  readable: () => boolean;
}

/**
 * `text` as the model should see it: unchanged when short; otherwise its
 * head — cut at a line break when one falls in the last fifth — and where
 * the whole of it is. `label` names the file (the tool's name). An agent
 * that cannot read files back, or no folder to keep it in: the whole result
 * up to UNREADABLE_CAP, as it always was.
 */
export function previewOrKeep(
  text: string,
  keep: KeepIn | null | undefined,
  label: string,
  cap: number = RESULT_PREVIEW_CHARS,
): string {
  const whole = () => (text.length > UNREADABLE_CAP ? `${text.slice(0, UNREADABLE_CAP)}\n…[truncated]` : text);
  if (!keep || !keep.readable()) return whole();
  const agentDir = keep.dir;
  if (text.length <= cap) return text;
  let cut = text.lastIndexOf("\n", cap);
  if (cut < cap * 0.8) cut = cap;
  const head = text.slice(0, cut);
  const more = text.length - cut;
  const name = `${label.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.txt`;
  const rel = path.posix.join(RESULTS_DIR, name);
  try {
    fs.mkdirSync(path.join(agentDir, RESULTS_DIR), { recursive: true });
    fs.writeFileSync(path.join(agentDir, rel), text);
  } catch {
    // Nowhere to keep it: what it would have had before, rather than a tail lost.
    return whole();
  }
  return (
    `${head}\n…(${more} more characters not shown — the whole result, ${text.length} characters, is in \`${rel}\`. ` +
    `Read it with offset/limit, or Grep it, if you need what is past this point.)`
  );
}
