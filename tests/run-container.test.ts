// The container boundary's pure parts: what may come back from a run, and
// what the driver's stdout lines mean. The docker-shaped rest lives in
// tests/container-e2e.test.ts, opt-in.
//
//   node --test tests/run-container.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  allowedBack,
  applyContainerChanges,
  parseDriverLine,
} from "../packages/core/src/run-container.ts";

test("what the spec says agents own comes back; what they must not touch does not", () => {
  assert.ok(allowedBack("agents/writer/outputs/report.md"));
  assert.ok(allowedBack("agents/writer/memory/learned.md"));
  assert.ok(allowedBack("memory/fact.md"));
  assert.ok(allowedBack("state/cursor.json"));
  assert.ok(allowedBack("outputs/digest.md"));

  assert.ok(!allowedBack("knowledge/policy.md"), "knowledge is read-only, physically");
  assert.ok(!allowedBack("agents/writer/knowledge/prices.md"));
  assert.ok(!allowedBack("secrets.json"));
  assert.ok(!allowedBack("hooks.json"), "webhook rotation state is the platform's");
  assert.ok(!allowedBack("hook-deliveries.jsonl"));
  assert.ok(!allowedBack("runs/run-1.json"));
  assert.ok(!allowedBack(".git/config"));
  assert.ok(!allowedBack("../outside.md"), "no escaping the workspace");
});

test("apply copies allowed changes, skips denied ones, deletes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-apply-"));
  try {
    const host = path.join(root, "host");
    const out = path.join(root, "out");
    // The host workspace before the run.
    fs.mkdirSync(path.join(host, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(host, "agents/writer/outputs"), { recursive: true });
    fs.writeFileSync(path.join(host, "knowledge/policy.md"), "authored truth");
    fs.writeFileSync(path.join(host, "agents/writer/outputs/old.md"), "from before");
    // What came out of the container.
    fs.mkdirSync(path.join(out, "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(out, "agents/writer/outputs"), { recursive: true });
    fs.mkdirSync(path.join(out, "memory"), { recursive: true });
    fs.writeFileSync(path.join(out, "knowledge/policy.md"), "the model edited this");
    fs.writeFileSync(path.join(out, "agents/writer/outputs/report.md"), "new work");
    fs.writeFileSync(path.join(out, "memory/fact.md"), "learned");
    // old.md absent in the container copy — it must survive on the host.

    const applied = applyContainerChanges(host, out).sort();
    assert.deepEqual(applied, ["agents/writer/outputs/report.md", "memory/fact.md"]);
    assert.equal(
      fs.readFileSync(path.join(host, "knowledge/policy.md"), "utf8"),
      "authored truth",
      "a knowledge edit inside the container dies with the container",
    );
    assert.equal(fs.readFileSync(path.join(host, "agents/writer/outputs/old.md"), "utf8"), "from before");
    assert.equal(fs.readFileSync(path.join(host, "memory/fact.md"), "utf8"), "learned");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("driver lines: events and the done marker parse, noise does not", () => {
  assert.deepEqual(parseDriverLine('{"e":"event","type":"text","text":"hi"}'), {
    e: "event",
    type: "text",
    text: "hi",
  });
  // A tool call's pairing fields cross the boundary — the id on the call,
  // the duration and error flag on its completion — and nothing else does.
  assert.deepEqual(parseDriverLine('{"e":"event","type":"tool","text":"read","call":"toolu_1","junk":1}'), {
    e: "event",
    type: "tool",
    text: "read",
    call: "toolu_1",
  });
  assert.deepEqual(parseDriverLine('{"e":"event","type":"tool","text":"read","call":"toolu_1","ms":840,"err":true}'), {
    e: "event",
    type: "tool",
    text: "read",
    call: "toolu_1",
    ms: 840,
    err: true,
  });
  const done = parseDriverLine('{"e":"done","status":"completed","result":"out","costUsd":0.01}');
  // `conclusion` is null when the driver sends none — an older driver, or a
  // step that produced no text at all.
  assert.deepEqual(done, { e: "done", status: "completed", result: "out", conclusion: null, costUsd: 0.01, usage: null, res: null });

  // The model's final block crosses the boundary beside the joined reply, so
  // the host can report what a step concluded rather than how it opened.
  const withConclusion = parseDriverLine(
    '{"e":"done","status":"completed","result":"first\\nlast","conclusion":"last","costUsd":0.01}',
  );
  assert.equal((withConclusion as { conclusion?: string }).conclusion, "last");
  // Token counts survive the boundary when the driver sends them — they are
  // what lets the host reprice a routed model from the gateway's catalogue.
  const withUsage = parseDriverLine(
    '{"e":"done","status":"completed","result":"out","costUsd":0.01,"usage":{"inputTokens":100,"outputTokens":20}}',
  );
  assert.deepEqual(
    withUsage && "usage" in withUsage ? withUsage.usage : null,
    { inputTokens: 100, outputTokens: 20 },
  );

  assert.equal(parseDriverLine("npm warn deprecated something"), null);
  assert.equal(parseDriverLine('{"unrelated":"json"}'), null);
  assert.equal(parseDriverLine('{broken'), null);
  const junkStatus = parseDriverLine('{"e":"done","status":"nonsense"}');
  assert.equal(junkStatus && "status" in junkStatus ? junkStatus.status : null, "failed");
});

test("the driver's resource reading survives the boundary, nulls intact", () => {
  const done = parseDriverLine(
    '{"e":"done","status":"completed","result":"out","costUsd":0.01,' +
      '"res":{"busyCpuSecs":12.5,"peakMemBytes":1073741824,"rxBytes":180000000,"txBytes":null}}',
  );
  assert.deepEqual((done as { res?: unknown }).res, {
    busyCpuSecs: 12.5,
    peakMemBytes: 1073741824,
    rxBytes: 180000000,
    // A metric the sandbox couldn't read stays null — never zero, which
    // would claim "measured: nothing" where the truth is "not measured".
    txBytes: null,
  });
});

test("a file the step never touched is not written back over a concurrent edit", () => {
  // The copy-back compared the container against the HOST, which is a
  // different question with a worse answer: a file the step never opened,
  // edited on the host while the step ran, differs — so it was written back
  // from the container's stale copy and the edit vanished. On 2026-09-03 a
  // tool.md fixed mid-run was reverted eight minutes later by a step that had
  // never read it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-back-"));
  const host = path.join(base, "host");
  const handed = path.join(base, "in");
  const out = path.join(base, "out");
  for (const d of [host, handed, out]) fs.mkdirSync(path.join(d, "tools"), { recursive: true });

  // Handed to the container, and returned unchanged by the step.
  fs.writeFileSync(path.join(handed, "tools/a.md"), "original\n");
  fs.writeFileSync(path.join(out, "tools/a.md"), "original\n");
  // Meanwhile a person fixed it on the host.
  fs.writeFileSync(path.join(host, "tools/a.md"), "the fix\n");

  // And a file the step genuinely wrote.
  fs.writeFileSync(path.join(handed, "tools/b.md"), "before\n");
  fs.writeFileSync(path.join(out, "tools/b.md"), "after the step\n");
  fs.writeFileSync(path.join(host, "tools/b.md"), "before\n");

  const applied = applyContainerChanges(host, out, handed);

  assert.equal(fs.readFileSync(path.join(host, "tools/a.md"), "utf8"), "the fix\n",
    "the concurrent edit was overwritten by the container's stale copy");
  assert.equal(fs.readFileSync(path.join(host, "tools/b.md"), "utf8"), "after the step\n",
    "a file the step really changed must still come back");
  assert.deepEqual(applied, ["tools/b.md"]);

  fs.rmSync(base, { recursive: true, force: true });
});

test("node_modules never comes back", () => {
  // A dependency tree is not workspace content: nothing authored lives there,
  // it is enormous, and a runtime linked beside a tool so ESM can resolve it
  // would otherwise be copied back file by file.
  assert.equal(allowedBack("tools/x/node_modules/sharp/package.json"), false);
  assert.equal(allowedBack("node_modules/left-pad/index.js"), false);
  assert.equal(allowedBack("tools/x/index.mjs"), true);
});
