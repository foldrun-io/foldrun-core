// The a2a handle file under two writers at once (Codex review, 1 Nov 2026).
//
// Parallel steps of one run borrow the same earlier step's handles and write
// them back to that step's file. Each read-merge-rename without a lock let
// the last rename drop the other's update — a reply one step recorded could
// vanish, and be sent again on resume. The write is now under an exclusive
// lock (O_EXCL, across processes), and a handle is merged field by field.
//
//   node --test tests/a2a-handles.test.ts

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mergeHandle, writeHandleFile, readRunHandles, type HandleRecord } from "../src/a2a-tools.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-a2a-handles-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = (over: Partial<HandleRecord> = {}): HandleRecord => ({
  handle: "a2a-000000000001",
  remote: "checker",
  step: 0,
  fingerprint: "f",
  ordinal: 0,
  messageId: "fr-x",
  taskId: "task-1",
  state: "TASK_STATE_INPUT_REQUIRED",
  replies: [],
  sentAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

test("mergeHandle keeps both writers' work: replies unioned in order, turns the larger, state the newer's", () => {
  const a = base({ replies: ["0:q|yes"], turns: 1, updatedAt: "2026-11-01T00:00:01.000Z" });
  const b = base({ state: "TASK_STATE_WORKING", updatedAt: "2026-11-01T00:00:02.000Z" });
  const m = mergeHandle(a, b);
  assert.deepEqual(m.replies, ["0:q|yes"], "the later poll did not drop the earlier reply");
  assert.equal(m.turns, 1);
  assert.equal(m.state, "TASK_STATE_WORKING");
  const c = mergeHandle(base({ replies: ["0:q|yes", "1:q|no"] }), base({ replies: ["0:q|yes", "1:r|maybe"], updatedAt: "2026-11-01T00:00:09.000Z" }));
  assert.deepEqual(c.replies, ["0:q|yes", "1:q|no", "1:r|maybe"]);
  assert.equal(mergeHandle(base({ state: "unconfirmed", taskId: undefined, updatedAt: "2026-11-01T00:00:05.000Z" }), base()).taskId, "task-1");
});

test("two processes writing the same handle file at once: no update is lost, no lock is left behind", async () => {
  const file = path.join(tmp, "run-1-0.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, handles: [base()] }));
  // Each writer is a long-lived step: it keeps its own copy of the handle,
  // records a reply, and writes it back — forty times, as fast as it can.
  const child = path.join(tmp, "writer.mjs");
  fs.writeFileSync(
    child,
    [
      "import fs from 'node:fs';",
      "const [mod, file, tag, n] = process.argv.slice(2);",
      "const { writeHandleFile } = await import(mod);",
      "const rec = JSON.parse(fs.readFileSync(file, 'utf8')).handles[0];",
      "for (let i = 0; i < Number(n); i++) {",
      "  rec.replies.push(`${tag}-${i}`);",
      "  rec.updatedAt = new Date().toISOString();",
      "  writeHandleFile(file, [rec]);",
      "}",
    ].join("\n"),
  );
  const mod = pathToFileURL(path.join(import.meta.dirname, "..", "src", "a2a-tools.ts")).href;
  const flags = process.execArgv.filter((a) => /strip-types|experimental-transform-types|no-warnings/.test(a));
  const run = (tag: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [...flags, child, mod, file, tag, "40"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (c) => (err += c));
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${err}`))));
    });
  await Promise.all([run("a"), run("b")]);
  const rec = JSON.parse(fs.readFileSync(file, "utf8")).handles[0] as HandleRecord;
  const want = [...Array.from({ length: 40 }, (_, i) => `a-${i}`), ...Array.from({ length: 40 }, (_, i) => `b-${i}`)].sort();
  assert.deepEqual([...rec.replies].sort(), want, "every reply both writers recorded is in the file");
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => /\.(lock|tmp)$/.test(f)), [], "the lock is released, no temp file left");
});

test("a held lock is waited for, and a stale one (a writer that died) is taken over", () => {
  const file = path.join(tmp, "run-2-0.json");
  fs.writeFileSync(`${file}.lock`, "999999@long ago");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  writeHandleFile(file, [base({ replies: ["0:q|yes"] })]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).handles[0].replies, ["0:q|yes"]);
  assert.ok(!fs.existsSync(`${file}.lock`));
});

test("a tie (the same millisecond): the update wins, so a step forward is not undone — but a task that ended does not start again", () => {
  const at = "2026-11-01T00:00:03.000Z";
  const disk = (state: string) => base({ state, updatedAt: at });
  assert.equal(mergeHandle(disk("TASK_STATE_WORKING"), base({ state: "TASK_STATE_COMPLETED", updatedAt: at })).state, "TASK_STATE_COMPLETED");
  assert.equal(mergeHandle(disk("TASK_STATE_INPUT_REQUIRED"), base({ state: "TASK_STATE_WORKING", updatedAt: at, replies: ["0:q|yes"] })).state, "TASK_STATE_WORKING");
  assert.equal(mergeHandle(disk("TASK_STATE_COMPLETED"), base({ state: "TASK_STATE_WORKING", updatedAt: at })).state, "TASK_STATE_COMPLETED");
  const m = mergeHandle(base({ replies: ["0:q|a"], updatedAt: at }), base({ replies: ["0:q|b"], updatedAt: at, answer: "kept" }));
  assert.deepEqual(m.replies.sort(), ["0:q|a", "0:q|b"], "replies still combine");
  assert.equal(m.answer, "kept");
});

test("two steps borrow one handle and each record a reply in their own file: reading sees one handle with both, conflict copies merged in", () => {
  const dir = path.join(tmp, "two-steps");
  fs.mkdirSync(dir, { recursive: true });
  // Step 0 sent it; steps 2 and 3 ran in parallel, each in its own sandbox.
  writeHandleFile(path.join(dir, "run-9-0.json"), [base()]);
  writeHandleFile(path.join(dir, "run-9-2.json"), [base({ replies: ["0:q|from-2"], turns: 1, updatedAt: "2026-11-01T00:00:02.000Z" })]);
  writeHandleFile(path.join(dir, "run-9-3.json"), [base({ replies: ["0:q|from-3"], state: "TASK_STATE_WORKING", updatedAt: "2026-11-01T00:00:03.000Z" })]);
  // What a copy-back leaves when two sandboxes changed one file.
  fs.writeFileSync(path.join(dir, "run-9-0.conflict-abc.json"), JSON.stringify({ version: 1, handles: [base({ replies: ["0:q|from-conflict"], updatedAt: "2026-11-01T00:00:01.000Z" })] }));
  // Another run's handle is not this run's.
  writeHandleFile(path.join(dir, "run-90-0.json"), [base({ handle: "a2a-other", replies: ["x"] })]);

  const { handles, own } = readRunHandles(dir, "run-9", path.join(dir, "run-9-3.json"));
  assert.deepEqual([...handles.keys()], ["a2a-000000000001"], "one handle, however many copies");
  const h = handles.get("a2a-000000000001")!;
  assert.deepEqual([...h.replies].sort(), ["0:q|from-2", "0:q|from-3", "0:q|from-conflict"]);
  assert.equal(h.state, "TASK_STATE_WORKING", "the newest copy's state");
  assert.equal(h.turns, 1);
  assert.deepEqual([...own], ["a2a-000000000001"], "step 3's own file holds its copy");
  // Nobody wrote step 0's file after it sent.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "run-9-0.json"), "utf8")).handles[0].replies, []);
});
