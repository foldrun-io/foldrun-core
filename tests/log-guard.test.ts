// FOL-121: the source half of "no account content in a platform log line".
// The rules of scripts/log-guard.mjs, then core's own server code under it.
//
//   node --test tests/log-guard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — a plain .mjs script, no declarations
import { scanSource, scanTree, compareBaseline, format } from "../scripts/log-guard.mjs";

type Found = { file: string; line: number; fp: string; why: string; text: string };
const scan = (src: string): Found[] => scanSource(src, "x.ts");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a raw console call may print literals only", () => {
  assert.equal(scan(`console.log("[scheduler] started (30s tick)");`).length, 0);
  assert.equal(scan("console.error(`no interpolation here`, 'nor here', 3);").length, 0);
  for (const bad of [
    "console.error(`[foldrun] ${where}: ${full}`);",
    `console.error("failed:", err);`,
    `console.error("failed:", err instanceof Error ? err.message : err);`,
    "console.log(`[scheduler] queued ${tenant}/${workspace}`);", // even an id: that is opsLog's job
    `console.warn(JSON.stringify(x));`,
    `console.log("a" + prompt);`,
    `console.dir(step);`,
    `console.table(rows);`,
  ]) assert.equal(scan(bad).length, 1, bad);
});

test("console passed as a value, aliased, or the streams written directly, are refused", () => {
  assert.equal(scan(`p.catch(console.error);`).length, 1);
  assert.equal(scan(`const log = console.log; log(prompt);`).length, 1);
  assert.equal(scan(`const log = opts.log ?? ((line) => console.error(line));`).length, 1);
  assert.equal(scan(`process.stderr.write(out);`).length, 1);
  assert.equal(scan(`process . stdout . write("x");`).length, 1);
});

test("opsLog and opsError need a literal event", () => {
  assert.equal(scan(`opsLog("info", "scheduler.queued", { tenant });`).length, 0);
  assert.equal(scan(`opsError("worker.run_threw", err, { runId });`).length, 0);
  assert.equal(scan("opsLog(\"info\", `x.${kind}`, {});").length, 1);
  assert.equal(scan(`opsError(name, err);`).length, 1);
  assert.equal(scan(`opsLog("info", "Not An Event");`).length, 1);
  // A comment between the name and its call is still the call (Codex review).
  assert.equal(scan(`opsLog /* why */ ("info", userInput);`).length, 1);
  assert.equal(scan(`console /* x */ . error // y\n (err);`).length, 1);
  assert.equal(scan(`process./* x */stderr.write(out);`).length, 1);
});

test("comments, strings, regexes and generated scripts are not code; a template's ${} is", () => {
  assert.equal(scan(`// console.log(prompt)\n/* console.error(err) */ const a = 1;`).length, 0);
  assert.equal(scan(`const s = "console.log(prompt)"; const t = 'process.stdout.write(x)';`).length, 0);
  assert.equal(scan(`const re = /console\\.log\\(x\\)/; const d = a / b / console;`).length, 0);
  // A script held in a template literal prints to its own stdout — a run
  // pod's protocol — not to ours.
  assert.equal(scan("const shim = `\nconsole.log(JSON.stringify(manifest));\nprocess.stdout.write(x);\n`;").length, 0);
  // But code inside ${} is code.
  assert.equal(scan("const s = `a ${(() => { console.error(err); return 1; })()} b`;").length, 1);
  // Line numbers are right after all that.
  const f = scan("// one\nconst s = `two\n${3}`;\n\nconsole.error(err);");
  assert.equal(f[0]?.line, 5);
});

test("a baseline fingerprints the call, not its line: moving it is fine, changing or adding one is not, and a removed one is stale", () => {
  const before = scan(`\nconsole.error("x", err);`);
  const moved = scan(`\n\n\n\nconsole.error("x", err);`);
  const baseline = { "x.ts": before.map((f) => f.fp) };
  assert.deepEqual(compareBaseline(moved, baseline), { fresh: [], stale: [] });
  const changed = scan(`console.error("x", err.stack);`);
  const c = compareBaseline(changed, baseline);
  assert.equal(c.fresh.length, 1);
  assert.deepEqual(c.stale, [`x.ts#${before[0].fp}`]);
  // The same call twice needs two entries.
  assert.equal(compareBaseline(scan(`console.error("x", err);\nconsole.error("x", err);`), baseline).fresh.length, 1);
});

/** Core files whose console output is not a platform log line. */
const CORE_SKIP: Record<string, string> = {
  "src/ops-log.ts": "the writer and the boundary themselves",
};

test("core's own server code: no raw console call prints a value, every ops event is a literal", () => {
  const found: Found[] = scanTree(["src", "index.ts"], { base: root, skip: CORE_SKIP });
  assert.equal(found.length, 0, `print these through opsLog/opsError (src/ops-log.ts):\n${format(found)}`);
});
