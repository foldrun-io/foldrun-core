#!/usr/bin/env node
// The log guard (FOL-121): no account content in a platform log line —
// the source half of the rule; the run-time half is core src/ops-log.ts.
//
// Platform pods' stdout and stderr leave the cluster for our operations
// stack. In a hosted process every raw console call is already reduced to
// {"event":"console","at":…} by the boundary (installOpsBoundary) — so a raw
// call is at best useless there, and at worst, outside the boundary or
// where it is turned off, a leak. This refuses, in server code:
//
//   - a console.* call that prints anything but literals (an error, its
//     message or stack, a `detail`, even an id — what a log line says about
//     a run goes through opsLog/opsError, whose fields have shapes);
//   - console.* passed around as a value (`.catch(console.error)`), and
//     process.stdout.write / process.stderr.write;
//   - an opsLog/opsError whose event is not a literal (the event is the one
//     part the writer cannot shape-check into safety).
//
// What was already there on 5 Nov 2026 is each repo's baseline, by call
// fingerprint (the file and the call's own text), not by line number: a new
// call fails, a changed one fails, and a removed one must leave the
// baseline too, so the baseline only shrinks.
//
// It reads TypeScript with a small tokenizer, not a compiler (core and
// platform typecheck with TypeScript 7, which has no JavaScript API). It
// skips comments and the text of strings and templates — a console.log in
// generated code, a script held in a template literal, is that script's
// business — and reads a template's `${…}` as code.
//
//   node scripts/log-guard.mjs <file|dir>…    # every refusal; exit 1 on any
//
// Tests: core tests/log-guard.test.ts (the rules) and each repo's guard
// test over its own server code.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONSOLE_METHODS = "log|error|warn|info|debug|trace|dir|table|assert|count|group|groupCollapsed|time|timeEnd|timeLog|dirxml";
const CONSOLE = new RegExp(`console\\s*\\.\\s*(${CONSOLE_METHODS})\\b\\s*(\\()?`, "y");
const STREAM = /process\s*\.\s*(stdout|stderr)\s*\.\s*write\b/y;
const OPS = /(opsLog|opsError)\s*\(/y;

/**
 * Every place in the source the guard has an opinion on, with the text of
 * its arguments. Comments and string/template text are skipped.
 * @returns {{ kind: "console" | "console-value" | "stream" | "opsLog" | "opsError", line: number, method?: string, args: string }[]}
 */
export function findCalls(src) {
  const found = [];
  const n = src.length;
  const lineAt = (pos) => {
    let l = 1;
    for (let k = 0; k < pos; k++) if (src.charCodeAt(k) === 10) l++;
    return l;
  };

  const skipString = (at) => {
    const q = src[at];
    let j = at + 1;
    while (j < n && src[j] !== q) {
      if (src[j] === "\\") j++;
      else if (src[j] === "\n") break;
      j++;
    }
    return j + 1;
  };
  const skipTemplate = (at) => {
    let j = at + 1;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "`") return j + 1;
      if (c === "$" && src[j + 1] === "{") { j = code(j + 2, "}"); continue; }
      j++;
    }
    return n;
  };
  const skipRegex = (at) => {
    let j = at + 1;
    let cls = false;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "\n") return j;
      if (cls) { if (c === "]") cls = false; }
      else if (c === "[") cls = true;
      else if (c === "/") { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
      j++;
    }
    return n;
  };
  const regexMayStart = (prev) => prev === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|do|else|in|of|void|yield|await|throw)$/.test(prev);
  const wordStart = (j) => j === 0 || !/[\w$.]/.test(src[j - 1]);

  // Code from `at` up to the `close` that balances it; returns past it.
  function code(at, close) {
    let j = at;
    let depth = 0;
    let prev = "";
    while (j < n) {
      const c = src[j];
      if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); if (j < 0) return n; continue; }
      if (c === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j + 2); if (j < 0) return n; j += 2; continue; }
      if (c === "'" || c === '"') { j = skipString(j); prev = "a"; continue; }
      if (c === "`") { j = skipTemplate(j); prev = "a"; continue; }
      if (c === "/" && regexMayStart(prev)) { j = skipRegex(j); prev = "a"; continue; }
      if (wordStart(j) && (c === "c" || c === "p" || c === "o")) {
        let matched = false;
        for (const [re, kind] of [[CONSOLE, "console"], [STREAM, "stream"], [OPS, "ops"]]) {
          re.lastIndex = j;
          const m = re.exec(src);
          if (!m) continue;
          const line = lineAt(j);
          if (kind === "console" && !m[2]) {
            found.push({ kind: "console-value", line, method: m[1], args: "" });
            j = re.lastIndex;
          } else if (kind === "stream") {
            found.push({ kind: "stream", line, method: m[1], args: "" });
            j = re.lastIndex;
          } else {
            const open = re.lastIndex - 1;
            const end = code(open + 1, ")");
            found.push({ kind: kind === "ops" ? m[1] : "console", line, method: m[1], args: src.slice(open + 1, end - 1) });
            j = end;
          }
          prev = ")";
          matched = true;
          break;
        }
        if (matched) continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0 && c === close) return j + 1;
        depth--;
      }
      if (/[\w$]/.test(c)) {
        let k = j;
        while (k < n && /[\w$]/.test(src[k])) k++;
        prev = src.slice(j, k);
        j = k;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      j++;
    }
    return n;
  }
  code(0, "\u0000");
  return found;
}

/** Split argument text at its top-level commas. */
export function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"') { j++; while (j < text.length && text[j] !== c) { if (text[j] === "\\") j++; j++; } continue; }
    if (c === "`") {
      j++;
      let d = 0;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (d === 0 && text[j] === "`") break;
        if (text[j] === "$" && text[j + 1] === "{") { d++; j += 2; continue; }
        if (d > 0 && text[j] === "{") d++;
        if (d > 0 && text[j] === "}") d--;
        j++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, j)); start = j + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** A literal: a quoted string, a template with no `${}`, a number, a
 *  boolean. Nothing a value of the program flows into. */
export function isLiteral(arg) {
  const a = arg.trim();
  return (
    /^'([^'\\\n]|\\.)*'$/.test(a) ||
    /^"([^"\\\n]|\\.)*"$/.test(a) ||
    (/^`([^`\\$]|\\.|\$(?!\{))*`$/s.test(a)) ||
    /^-?\d[\d_]*(\.\d+)?$/.test(a) ||
    /^(true|false)$/.test(a)
  );
}

/** What the guard refuses in one file's source. */
export function scanSource(src, file = "<source>") {
  const out = [];
  for (const c of findCalls(src)) {
    const text = `${c.kind}:${c.method ?? ""}(${c.args.replace(/\s+/g, " ").trim()})`;
    const fp = crypto.createHash("sha1").update(`${file}\u0000${text}`).digest("hex").slice(0, 12);
    const at = { file, line: c.line, fp, text: text.slice(0, 140) };
    if (c.kind === "console-value") out.push({ ...at, why: `console.${c.method} passed as a value` });
    else if (c.kind === "stream") out.push({ ...at, why: `process.${c.method}.write` });
    else if (c.kind === "console") {
      const args = splitArgs(c.args);
      if (!args.every(isLiteral)) out.push({ ...at, why: `console.${c.method} prints a value, not only literals` });
    } else {
      const args = splitArgs(c.args);
      const event = c.kind === "opsLog" ? args[1] : args[0];
      if (!event || !/^"[a-z][a-z0-9_.]*"$/.test(event.trim())) out.push({ ...at, why: `${c.kind} with an event that is not a literal` });
    }
  }
  return out;
}

const SOURCE = /\.(ts|tsx|mts|mjs|js)$/;

/** Every source file under these roots, tests and type declarations aside. */
export function listSources(roots) {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) if (e !== "node_modules" && !e.startsWith(".")) walk(path.join(p, e));
    } else if (SOURCE.test(p) && !/\.test\.|\.d\.ts$/.test(p)) files.push(p);
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  return files.sort();
}

/**
 * Scan roots. `skip` maps a path (relative to `base`) to the reason its
 * output is not a platform log — a command-line tool printing to the
 * terminal of the person who ran it, the writer itself.
 */
export function scanTree(roots, { base = process.cwd(), skip = {} } = {}) {
  const found = [];
  for (const f of listSources(roots.map((r) => path.resolve(base, r)))) {
    const rel = path.relative(base, f).split(path.sep).join("/");
    if (skip[rel]) continue;
    found.push(...scanSource(fs.readFileSync(f, "utf8"), rel));
  }
  return found;
}

/**
 * Compare with a baseline ({ file: [fingerprint, …] }): what is new (not in
 * it) and what is stale (in it, no longer in the source).
 */
export function compareBaseline(found, baseline) {
  const left = new Map();
  for (const [file, fps] of Object.entries(baseline)) for (const fp of fps) left.set(`${file}#${fp}`, (left.get(`${file}#${fp}`) ?? 0) + 1);
  const fresh = [];
  for (const f of found) {
    const k = `${f.file}#${f.fp}`;
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else fresh.push(f);
  }
  const stale = [...left.entries()].filter(([, n]) => n > 0).map(([k]) => k);
  return { fresh, stale };
}

export function baselineOf(found) {
  const out = {};
  for (const f of found) (out[f.file] ??= []).push(f.fp);
  for (const k of Object.keys(out)) out[k].sort();
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function format(list) {
  return list.map((f) => `${f.file}:${f.line} ${f.why} — ${f.text}`).join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scanTree(process.argv.slice(2).length ? process.argv.slice(2) : ["src"]);
  if (found.length) {
    process.stderr.write(format(found) + `\n${found.length} call(s) refused\n`);
    process.exit(1);
  }
  process.stdout.write("log guard: nothing refused\n");
}
