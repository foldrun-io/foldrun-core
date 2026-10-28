// Matching on the shared worker and web pod against tenant-written patterns.
//
// A regular expression or a glob a tenant writes runs here, not in their
// sandbox (an eval's `matches:`, a gate's `preview:`). A pattern that
// backtracks — `(a+)+$`, or `**a**a**a**b` turned into `.*a.*a.*a.*b` —
// holds the one event loop every account shares. So: globs match in linear
// time with no regex at all, and a regex runs under a time limit
// (29 Oct 2026, OWASP review).

import vm from "node:vm";

/**
 * Does `text` match `pattern`? `*` matches within one path segment, `**`
 * across segments; every other character is itself. O(pattern × text).
 */
export function globMatch(pattern: string, text: string): boolean {
  const toks: string[] = [];
  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        while (pattern[i] === "*") i++;
        // "**" swallows a neighbouring "**" or "*": the same set either way.
        if (toks[toks.length - 1] !== "**") toks.push("**");
      } else {
        i++;
        if (toks[toks.length - 1] !== "**" && toks[toks.length - 1] !== "*") toks.push("*");
      }
    } else {
      toks.push(pattern[i]);
      i++;
    }
  }
  const n = text.length;
  let cur: boolean[] = new Array(n + 1).fill(false);
  cur[0] = true;
  for (const t of toks) {
    const next: boolean[] = new Array(n + 1).fill(false);
    if (t === "**") {
      let on = false;
      for (let j = 0; j <= n; j++) {
        on = on || cur[j];
        next[j] = on;
      }
    } else if (t === "*") {
      let on = false;
      for (let j = 0; j <= n; j++) {
        if (cur[j]) on = true;
        next[j] = on;
        if (j < n && text[j] === "/") on = false;
      }
    } else {
      for (let j = 0; j < n; j++) if (cur[j] && text[j] === t) next[j + 1] = true;
    }
    cur = next;
  }
  return cur[n];
}

/** A regex test that gives up after `ms`: true, false, or "timeout". Throws
 *  on a pattern that does not compile, as `new RegExp` would. */
export function boundedRegexTest(source: string, flags: string, text: string, ms = 250): boolean | "timeout" {
  new RegExp(source, flags); // compile here: a syntax error is the caller's to report
  try {
    return vm.runInNewContext("new RegExp(p, f).test(t)", { p: source, f: flags, t: text }, { timeout: ms }) === true;
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "timeout";
    throw err;
  }
}
