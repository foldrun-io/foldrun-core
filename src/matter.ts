// gray-matter, without its cache.
//
// gray-matter keeps every input it is handed in a module-level cache keyed by
// the text, and it stores the entry BEFORE it parses. When the YAML does not
// parse, the first call throws — and the entry stays, unparsed. The next call
// with the same text returns it: no error, `data` empty. So in any process
// that read a file twice, a broken frontmatter was an error once and valid
// forever after.
//
// That is how one agent file took the worker down on 20 Oct 2026. The source
// API's save check parsed it first (and threw, caught), the write's own
// "reject files whose frontmatter doesn't parse" then hit the cache and let it
// through, and the worker, parsing it fresh at boot, threw on it out of
// listWorkspaces and never came up — for every account on the box.
//
// Passing an options object skips the cache entirely (gray-matter only reads
// and writes it when there are none), so every call here parses the text it
// was given. The cost is a parse per call, which is what every caller already
// believed it was paying. Import this, never "gray-matter" itself: a test in
// tests/matter.test.ts and foldrun-web's consistency test hold every repo to
// it.

import grayMatter from "gray-matter";
import { JOBS, FOLDABLE, type Job } from "./frontmatter-fields.ts";

type Options = NonNullable<Parameters<typeof grayMatter>[1]>;

/** Where the four job blocks put things, on the parsed data — out of sight
 *  of every reader that spreads it or writes it out as JSON. */
const FOLD = Symbol.for("foldrun.jobBlocks");

export interface JobFold {
  /** A key lifted out of a block, and the block it was in. */
  folded: Map<string, Job>;
  /** A key set both at the top and inside a block: the top one is kept, and
   *  check refuses the file (config/conflict). */
  conflicts: Map<string, Job>;
}

/** What the fold did to this data, or null when it had no blocks. */
export function jobFold(data: unknown): JobFold | null {
  return data && typeof data === "object" ? ((data as Record<symbol, JobFold | undefined>)[FOLD] ?? null) : null;
}

/**
 * The four job blocks (`governance:`, `guardrail:`, `observability:`,
 * `evaluation:`) read as the flat keys they hold (frontmatter-fields.ts
 * JOB_FIELDS). Only a key some config kind lets that block hold is lifted;
 * anything else stays in the block for check to report. A key set both ways
 * keeps its top-level value and is recorded. Nothing parsed is changed: new
 * objects are built (YAML aliases share nodes — deleting from one would
 * delete from the other).
 */
function foldJobs(data: Record<string, unknown>): Record<string, unknown> {
  let fold: JobFold | null = null;
  let out: Record<string, unknown> | null = null;
  for (const { name } of JOBS) {
    const block = data[name];
    if (!block || typeof block !== "object" || Array.isArray(block) || block instanceof Date) continue;
    const inner = block as Record<string, unknown>;
    const lift = Object.keys(inner).filter((k) => FOLDABLE[name].has(k));
    if (!lift.length) continue;
    out ??= { ...data };
    fold ??= { folded: new Map(), conflicts: new Map() };
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inner)) if (!lift.includes(k)) rest[k] = v;
    for (const k of lift) {
      if (Object.prototype.hasOwnProperty.call(data, k)) fold.conflicts.set(k, name);
      else {
        out[k] = inner[k];
        fold.folded.set(k, name);
      }
    }
    if (Object.keys(rest).length) out[name] = rest;
    else delete out[name];
  }
  if (!out || !fold) return data;
  Object.defineProperty(out, FOLD, { value: fold, enumerable: false });
  return out;
}

function matter(input: string, options?: Options) {
  return grayMatter(input, options ?? {});
}
matter.stringify = grayMatter.stringify;
matter.test = grayMatter.test;

/**
 * matter(), for the three files that hold configuration — an agent, a flow,
 * AGENTS.md — with the four job blocks read as flat keys. Every reader of
 * those files goes through this (tests/jobs.test.ts holds them to it);
 * knowledge, memory, skills and every other document keep matter(), so a
 * note's own `governance:` is its own (Codex debate, 21 Oct 2026).
 */
export function configMatter(input: string, options?: Options) {
  const file = grayMatter(input, options ?? {});
  if (file.data && typeof file.data === "object" && !Array.isArray(file.data)) {
    (file as { data: Record<string, unknown> }).data = foldJobs(file.data as Record<string, unknown>);
  }
  return file;
}

export default matter;

/** The first line of a YAML parse error, with where it is: what a person
 *  needs to fix the file, without the parser's excerpt. */
export function frontmatterErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `frontmatter does not parse — ${msg.split("\n")[0].trim().replace(/:$/, "")}. Quote a value that contains a colon followed by a space.`;
}

/** The 1-based file line a YAML parse error points at, when it says. The
 *  text gray-matter hands the parser starts with the newline after the
 *  opening `---`, so the parser's 0-based line is the file's 1-based one. */
export function frontmatterErrorLine(err: unknown): number | undefined {
  const line = (err as { mark?: { line?: unknown } } | null)?.mark?.line;
  return typeof line === "number" ? line + 1 : undefined;
}

/** Frontmatter as the runtime reads a skill: strictly first, then once more
 *  with every unquoted value that holds a colon quoted (the commonest way a
 *  hand-written SKILL.md breaks, and one other skills clients forgive), and
 *  empty when even that fails. `lenient` says the second read was needed. */
export function parseLenient(raw: string): { data: Record<string, unknown>; lenient: boolean; failed: boolean } {
  try {
    return { data: matter(raw).data as Record<string, unknown>, lenient: false, failed: false };
  } catch {
    const fm = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const fixed = fm[1].replace(
        /^([A-Za-z0-9_-]+):[ \t]+(?!["'>|])(.*:.*)$/gm,
        (_m, k: string, v: string) => `${k}: ${JSON.stringify(v)}`,
      );
      try {
        // A function replacer, not a string: a fixed block containing `$&` or
        // `$$` (a value with those in it) would otherwise be treated as a
        // replacement pattern and splice the whole frontmatter into itself.
        return { data: matter(raw.replace(fm[1], () => fixed)).data as Record<string, unknown>, lenient: true, failed: false };
      } catch {
        /* fall through */
      }
    }
    return { data: {}, lenient: false, failed: true };
  }
}
