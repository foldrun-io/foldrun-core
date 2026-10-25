// The last word on every frontmatter edit made as text (agents-md.ts
// patchFrontmatter, network.ts setNetworkSetting, the canvas's list and
// scalar edits): the result is read back the way a run reads it, and the
// edit is refused — the file left as it was — unless it parses, set what it
// said it set, left everything else as it was, and made no key both flat and
// in its block. The text writers handle the shapes people write; this makes
// a shape they do not handle a refusal, never a broken or doubled file
// (Codex debate, 21 Oct 2026).

import { isDeepStrictEqual } from "node:util";
import { configMatter, jobFold } from "./matter.ts";

/** A write the guard refused. 409: the file is fine, this edit is not. */
export class UnsafeEditError extends Error {
  status = 409;
  constructor(why: string) {
    super(`not saved — ${why}. Edit the file itself, or write its blocks one key per line`);
  }
}

const front = (text: string) => configMatter(text).data as Record<string, unknown>;

/** What a changed key must read back as: a value (null: absent), or a test
 *  of what it reads as, for a writer whose output form is its own (a canvas
 *  list, a scalar YAML may type). */
export type Expect = unknown | ((value: unknown) => boolean);

/**
 * `after` if it is `before` with only `changed` keys different and each
 * `expect`ed key reading back as expected; throws UnsafeEditError otherwise.
 * Checked on every call — an edit that changed nothing must still have done
 * what it said — and refused when `before` cannot be read, since nothing
 * then could be compared.
 */
export function guardEdit(before: string, after: string, changed: readonly string[], expect: Record<string, Expect> = {}): string {
  let was: Record<string, unknown>;
  try {
    was = front(before);
  } catch {
    throw new UnsafeEditError("the frontmatter does not parse as it is, so this edit could not be checked — fix the file first");
  }
  let now: Record<string, unknown>;
  try {
    now = front(after);
  } catch (err) {
    throw new UnsafeEditError(`the result would not parse (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  const conflictsBefore = jobFold(was)?.conflicts ?? new Map();
  for (const [k, block] of jobFold(now)?.conflicts ?? new Map()) {
    if (!conflictsBefore.has(k)) throw new UnsafeEditError(`\`${k}\` would be written both at the top and inside \`${block}:\``);
  }
  for (const [k, want] of Object.entries(expect)) {
    const ok = typeof want === "function" ? (want as (v: unknown) => boolean)(now[k]) : isDeepStrictEqual(now[k], want === null ? undefined : want);
    if (!ok) throw new UnsafeEditError(`\`${k}\` would not read back as written`);
  }
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (changed.includes(k)) continue;
    if (!isDeepStrictEqual(was[k], now[k])) throw new UnsafeEditError(`\`${k}\` would change too`);
  }
  return after;
}

/** The front of `text` as a run reads it, or null when it does not parse. */
export function readFront(text: string): Record<string, unknown> | null {
  try {
    return front(text);
  } catch {
    return null;
  }
}
