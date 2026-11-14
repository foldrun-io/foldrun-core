// A seeded generator of hostile names for the path-safety property tests
// (tests/path-safety-*.test.ts in core, platform and web). No Math.random: the
// same seed gives the same cases on every machine, so a failure is a repro,
// not a flake.

/** mulberry32: 32 bits of state, plenty for picking pieces. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pieces that mean something to a path, a shell, a URL or a filesystem. */
export const EVIL: readonly string[] = [
  // traversal and separators
  "..", ".", "../", "..\\", "/", "\\", "//", "./", ".//", "/..", "..;/", "....//", "..%2f", "%2e%2e", "%2e%2e%2f", "%252e%252e%252f", "%2e%2e%5c", "..%c0%af", "..%ef%bc%8f",
  // unicode: fullwidth dot and slash, division slash, fraction slash, combining forms, bidi, zero width, homoglyphs
  "\uFF0E\uFF0E", "\uFF0F", "\uFF3C", "\u2215", "\u2044", "\u2024\u2024", "e\u0301", "\u00e9", "\u202E", "\u202D", "\u2066", "\u200B", "\u200D", "\uFEFF", "\u00A0", "\u2028",
  "\u0430dmin", "\u0131", "I", "i", "\u0130", "\u00DF", "SS", "ss", "\uD83D\uDE00", "\uD800", "\uDC00", "\u{10FFFF}",
  // control characters
  "\0", "\n", "\r", "\t", "\u001b", "\u007f", "\u0085",
  // windows
  "CON", "NUL", "AUX", "PRN", "COM1", "LPT1", "con.md", "nul.txt", "a.", "a ", ". ", "..  ", "A~1", "PROGRA~1", "a:b", "C:", "C:\\", "\\\\?\\C:\\", "\\\\host\\share", "a::$DATA", "a.md:stream",
  // object keys
  "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__defineGetter__",
  // argv, glob, regex, url, shell, sql
  "-rf", "--help", "-", "--", "*", "?", "[a-z]", "{a,b}", "~", "~root", "$HOME", "${x}", "`id`", "$(id)", "a;b", "a|b", "a&b", "a'b", "a\"b", "%", "%00", "%s", "^", "(.*)", "a.*", ".*", "\\d+", "x' OR '1'='1", "<script>", "?x=1", "#frag", "@", "a@b", "a b",
  // shapes agents and manifests use
  "agents", "flows", "evals", "state", "storage", "outputs", "runs", "calls", ".foldrun", ".foldrun/run-inputs", ".git", ".env", ".mirror-tmp", "AGENTS.md", "agents.md", "project.md", "secrets.json", "node_modules",
];

const SEGS = ["a", "b", "x", "notes", "agents", "writer", "state", "knowledge", "report.md", "agent.md", "tool.md", "run.sh", "x.json", "outputs", "a-b", "a_b", "A", "Report.MD"];
const SEPS = ["/", "/", "/", "\\", "//", "/./"];

/** `n` hostile strings built from `seed`: evil pieces on their own, glued to
 *  ordinary segments, nested, repeated, and very long. */
export function hostile(seed: number, n: number): string[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const out: string[] = [...EVIL];
  while (out.length < n) {
    const kind = Math.floor(r() * 9);
    const parts: string[] = [];
    const k = 1 + Math.floor(r() * 5);
    for (let i = 0; i < k; i++) parts.push(r() < 0.5 ? pick(EVIL) : pick(SEGS));
    let s = parts.join(pick(SEPS));
    if (kind === 0) s = "../".repeat(1 + Math.floor(r() * 12)) + s;
    else if (kind === 1) s = "/" + s;
    else if (kind === 2) s += "/";
    else if (kind === 3) s += pick([".md", ".json", ".sh", ".py", ".txt", ".md ", ".md.", ".MD"]);
    else if (kind === 4) s = "a/".repeat(1 + Math.floor(r() * 80)) + s;
    else if (kind === 5) s = s + "x".repeat(Math.floor(r() * 600));
    else if (kind === 6) s = pick(SEGS) + "/" + "../".repeat(1 + Math.floor(r() * 4) ) + s;
    // kinds 7-8: left as built
    out.push(s);
  }
  return out;
}

/** The names a legitimate caller uses: every sink must accept most of these. */
export const GOOD_SEGMENTS = ["a", "notes", "writer", "report-2026", "x1", "a-b-c"];

/** Run `f`, return what it returned or null when it threw (a refusal). */
export function tryIt<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** Where a path really lands: the real path of the deepest ancestor that exists, plus the rest. */
import fs from "node:fs";
import path from "node:path";
export function landing(p: string): string {
  const tail: string[] = [];
  let probe = path.resolve(p);
  for (;;) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      const up = path.dirname(probe);
      if (up === probe) return probe;
      tail.unshift(path.basename(probe));
      probe = up;
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(probe);
  } catch {
    real = probe;
  }
  return path.join(real, ...tail);
}

export function isInside(root: string, p: string): boolean {
  const r = landing(root);
  const l = landing(p);
  return l === r || l.startsWith(r + path.sep);
}
