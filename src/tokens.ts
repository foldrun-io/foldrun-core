// Token counts and the prompt-cache share, as pure functions over values.
//
// No node imports: the dashboard's client components read these (the run
// page's step chips), and store.ts — fs, path, the tree reader — must never
// reach a browser bundle (web ae042d6 broke `next build` doing exactly that).
// store.ts re-exports everything here, so server code imports as before.

/**
 * The token counts behind a step's cost. `input` is every input token the
 * model saw; `cacheRead` and `cacheWrite` are the part of it the prompt
 * cache served or stored — a read costs a tenth of fresh input, and a usage
 * page wants to say how much of a step's context was re-read rather than
 * re-sent. Steps recorded before 18 Oct 2026 have no cache fields: their
 * `input` is the same total, but how much of it was cached is unknown.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The record's shape from what a step reports (ExecOutcome.usage). */
export function tokensOf(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
}

/** Field-by-field sum; the cache fields are present in the result whenever
 *  any input had them, so a run of old and new steps still reads whole. */
export function sumTokens(list: readonly TokenUsage[]): TokenUsage {
  const out: TokenUsage = { input: 0, output: 0 };
  for (const t of list) {
    out.input += t.input;
    out.output += t.output;
    if (t.cacheRead !== undefined || t.cacheWrite !== undefined) {
      out.cacheRead = (out.cacheRead ?? 0) + (t.cacheRead ?? 0);
      out.cacheWrite = (out.cacheWrite ?? 0) + (t.cacheWrite ?? 0);
    }
  }
  return out;
}

/** The share of all input that the prompt cache served, 0–1; null when
 *  there was no input, or the record predates the split and cannot say. */
export function cacheHitRate(t: TokenUsage | null | undefined): number | null {
  if (!t || t.cacheRead === undefined) return null;
  return t.input > 0 ? Math.min(1, t.cacheRead / t.input) : null;
}

/** The cache share over several counts, taking only those that report the
 *  split: a step recorded before it holds its cache traffic inside `input`,
 *  and counting that as uncached would understate the rate. The rule the
 *  Usage page and the CLI's totals follow too. */
export function measuredHitRate(list: readonly (TokenUsage | null | undefined)[]): number | null {
  let read = 0;
  let all = 0;
  for (const t of list) {
    if (!t || t.cacheRead === undefined) continue;
    read += t.cacheRead;
    all += t.input;
  }
  return all > 0 ? read / all : null;
}

/** A run's token counts, summed over its steps; null when no step reported any. */
export function runTokens(run: { steps: readonly { tokens?: TokenUsage | null }[] }): TokenUsage | null {
  const toks = run.steps.map((s) => s.tokens).filter((t): t is TokenUsage => !!t);
  return toks.length ? sumTokens(toks) : null;
}

/**
 * One layer of a step's system prompt as the record keeps it — no text,
 * only what tells two steps' prompts apart. The layers are assembled in
 * prompt-layers.ts; this is the shape the run page and the CLI read.
 */
export interface PromptLayerRecord {
  name: string;
  chars: number;
  /** First 12 hex characters of the layer's SHA-256. */
  hash: string;
  /** False for a layer that changes between runs (memory, state, clock),
   *  placed after the cache boundary. Omitted when true. */
  stable?: false;
}

/**
 * Which layers differ between two steps' prompts, by name: changed, added
 * or removed. Empty when the prompts are the same, or either step has no
 * layers on record.
 */
export function promptLayersChanged(prev: readonly PromptLayerRecord[] | null | undefined, next: readonly PromptLayerRecord[] | null | undefined): string[] {
  if (!prev || !next) return [];
  const before = new Map(prev.map((l) => [l.name, l.hash]));
  const after = new Map(next.map((l) => [l.name, l.hash]));
  const out: string[] = [];
  for (const [name, hash] of after) if (before.get(name) !== hash) out.push(name);
  for (const name of before.keys()) if (!after.has(name)) out.push(name);
  return out;
}

/** A step that wrote this share of its input to the cache, or more, gets a
 *  note saying why. Below it the cache did its job: a step's turns each
 *  write their new tail, which is a few percent of a long step's input. */
export const CACHE_WRITE_NOTE_SHARE = 0.2;

/**
 * Why a step's prompt cache missed, in one line, or null when it did not:
 * the share of input written to the cache, and what differed from the same
 * agent's previous step in the run — "memory, clock changed since step 2".
 * The agent's first step in a run writes its prefix whatever happens, and
 * says so; the same prompt written again means the entry had expired
 * (five minutes on an API key) or siblings started before it was readable.
 * Steps without layers on record (before 20 Oct 2026) get no note.
 */
export function promptCacheNote(
  steps: readonly { agent: string; tokens?: TokenUsage | null; promptLayers?: readonly PromptLayerRecord[] | null }[],
  index: number,
): string | null {
  const step = steps[index];
  if (!step?.promptLayers) return null;
  const t = step.tokens;
  if (!t || t.cacheWrite === undefined || !(t.input > 0)) return null;
  const share = t.cacheWrite / t.input;
  if (share < CACHE_WRITE_NOTE_SHARE) return null;
  const head = `${Math.round(share * 100)}% of input written to the cache`;
  let prev = -1;
  for (let j = index - 1; j >= 0; j--) {
    if (steps[j]!.agent === step.agent && steps[j]!.promptLayers) {
      prev = j;
      break;
    }
  }
  if (prev < 0) return `${head} — the agent's first step in this run`;
  const changed = promptLayersChanged(steps[prev]!.promptLayers, step.promptLayers);
  if (!changed.length) return `${head} — the same prompt as step ${prev + 1}; the entry had expired or was still being written`;
  return `${head} — ${changed.join(", ")} changed since step ${prev + 1}`;
}
