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
  hashTree,
  parseDriverLine,
  RUNTIME_CACHE,
  runtimeCacheMount,
} from "../src/run-container.ts";

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

test("two runs appending to the same ledger both keep their rows", () => {
  // outreach-desk 2026-09-14: the 09:30 run finished after a ledger-check run
  // and its copy of state/sends.md replaced the live file, erasing the other
  // run's rows. Both started from the same file; both only appended.
  for (const baselineKind of ["dir", "hashes"] as const) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-merge-"));
    const host = path.join(base, "host");
    const handed = path.join(base, "in");
    const out = path.join(base, "out");
    for (const d of [host, handed, out]) fs.mkdirSync(path.join(d, "state"), { recursive: true });
    const v1 = "| date | run |\n|---|---|\n| 09-08 | legacy |\n";
    fs.writeFileSync(path.join(handed, "state/sends.md"), v1);
    // Run A finished first and appended its row to the live file.
    fs.writeFileSync(path.join(host, "state/sends.md"), v1 + "| 09-14 | run-a |\n");
    // Run B, started from v1, appends its own.
    fs.writeFileSync(path.join(out, "state/sends.md"), v1 + "| 09-14 | run-b |\n");
    const notes: string[] = [];
    const baseline = baselineKind === "dir" ? handed : hashTree(handed);
    applyContainerChanges(host, out, baseline, (m) => notes.push(m));
    assert.equal(
      fs.readFileSync(path.join(host, "state/sends.md"), "utf8"),
      v1 + "| 09-14 | run-a |\n| 09-14 | run-b |\n",
      `${baselineKind}: an append-only file lost a concurrent run's rows`,
    );
    assert.deepEqual(notes, []);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a real conflict keeps the live file and saves the step's copy beside it", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-conflict-"));
  const host = path.join(base, "host");
  const handed = path.join(base, "in");
  const out = path.join(base, "out");
  for (const d of [host, handed, out]) fs.mkdirSync(path.join(d, "state"), { recursive: true });
  fs.writeFileSync(path.join(handed, "state/cursor.md"), "offset: 10\n");
  fs.writeFileSync(path.join(host, "state/cursor.md"), "offset: 20\n");
  fs.writeFileSync(path.join(out, "state/cursor.md"), "offset: 15\n");
  const notes: string[] = [];
  const applied = applyContainerChanges(host, out, hashTree(handed), (m) => notes.push(m));
  assert.equal(fs.readFileSync(path.join(host, "state/cursor.md"), "utf8"), "offset: 20\n", "live edit was overwritten");
  const copies = fs.readdirSync(path.join(host, "state")).filter((f) => f.startsWith("cursor.conflict-"));
  assert.equal(copies.length, 1, "the step's version must be kept, not dropped");
  assert.equal(fs.readFileSync(path.join(host, "state", copies[0]), "utf8"), "offset: 15\n");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /state\/cursor\.md/);
  assert.deepEqual(applied, [`state/${copies[0]}`]);
  fs.rmSync(base, { recursive: true, force: true });
});

test("append merge: host rows without a trailing newline, a rewrite, and a new file on both sides", async () => {
  const { mergeAppends } = await import("../src/run-container.ts");
  const b = (s: string) => Buffer.from(s, "utf8");
  assert.equal(mergeAppends(b("a\n"), b("a\nx"), b("a\ny\n"))!.toString(), "a\nx\ny\n");
  assert.equal(mergeAppends(b("a\nb\n"), b("a\nB\n"), b("a\nb\nc\n")), null, "a rewritten line is not an append");
  assert.equal(mergeAppends(null, b("{}\n"), b("[]\n")), null, "two new files are a conflict");
});

// A secret whose value holds a newline used to be dropped from the env
// file without a word — docker's --env-file is one KEY=value per line —
// and the step failed later, elsewhere, on a variable that read as unset.
test("a secret with a line break crosses as a file, and the trace says so", async () => {
  const { stageContainerEnv } = await import("../src/run-container.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-envfile-"));
  try {
    const events: string[] = [];
    const env = stageContainerEnv(
      {
        PLAIN_TOKEN: "abc123",
        PEM_KEY: "@file -----BEGIN KEY-----\nabc\n-----END KEY-----\n",
        MULTI_LINE: "line one\nline two",
        CRLF_VALUE: "first\r\nsecond",
      },
      root,
      "agents/worker",
      (type, text) => events.push(`${type}: ${text}`),
    );
    assert.equal(env.PLAIN_TOKEN, "abc123", "a plain value goes through the env file");
    assert.equal(env.PEM_KEY, "/workspace/agents/worker/.secret-files/pem_key");
    assert.equal(env.MULTI_LINE, "/workspace/agents/worker/.secret-files/multi_line", "not dropped: a path the step can read");
    assert.equal(env.CRLF_VALUE, "/workspace/agents/worker/.secret-files/crlf_value");
    assert.equal(fs.readFileSync(path.join(root, "agents/worker/.secret-files/multi_line"), "utf8"), "line one\nline two");
    for (const v of Object.values(env)) assert.ok(!/[\r\n]/.test(v), "nothing with a line break reaches the env file");
    assert.deepEqual(
      events.filter((e) => /line break/.test(e)).map((e) => e.replace(/ holds .*/, "")),
      ["info: MULTI_LINE", "info: CRLF_VALUE"],
      "each secret that could not cross as a variable is named on the trace",
    );
    assert.ok(events.every((e) => !e.includes("line one")), "the value itself never appears in an event");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- runtimeCacheMount: the container tier's cache is a Docker NAMED
// volume, never a host path. The bug this replaces was a `-v <hostpath>:...`
// under FOLDRUN_DATA, which the host daemon on the far end of the socket could
// not resolve ("mounts denied"). Save/restore the two env vars it reads.
function withCacheEnv<T>(
  vars: { cache?: string; data?: string },
  body: () => T,
): T {
  const prev = {
    cache: process.env.FOLDRUN_RUNTIME_CACHE,
    data: process.env.FOLDRUN_DATA,
  };
  const set = (k: "FOLDRUN_RUNTIME_CACHE" | "FOLDRUN_DATA", v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  set("FOLDRUN_RUNTIME_CACHE", vars.cache);
  set("FOLDRUN_DATA", vars.data);
  try {
    return body();
  } finally {
    set("FOLDRUN_RUNTIME_CACHE", prev.cache);
    set("FOLDRUN_DATA", prev.data);
  }
}

test("runtimeCacheMount: off, and unsafe or empty tenants, all yield no mount", () => {
  withCacheEnv({ cache: "off" }, () => {
    assert.equal(runtimeCacheMount("acct-1"), null, "FOLDRUN_RUNTIME_CACHE=off disables the cache");
  });
  withCacheEnv({ cache: undefined }, () => {
    assert.equal(runtimeCacheMount(undefined), null, "no tenant, no mount");
    assert.equal(runtimeCacheMount(""), null, "empty tenant, no mount");
    assert.equal(runtimeCacheMount("../evil"), null, "path traversal is refused");
    assert.equal(runtimeCacheMount("."), null, "a lone dot is refused");
    assert.equal(runtimeCacheMount(".."), null, "a lone dot-dot is refused");
    assert.equal(runtimeCacheMount("a/b"), null, "a slash is not a single segment");
  });
});

test("runtimeCacheMount: a real tenant mounts a volume NAME, never a host path under FOLDRUN_DATA", () => {
  // This is the regression guard for the mounts-denied bug: the source must be
  // a daemon-resolvable volume name, not a filesystem path the daemon can't see.
  withCacheEnv({ cache: undefined, data: "/data" }, () => {
    const m = runtimeCacheMount("acct-123");
    assert.ok(m, "a safe tenant produces a mount");
    assert.ok(!path.isAbsolute(m!.source), "the source is not an absolute path");
    assert.ok(!m!.source.includes("/"), "the source is a volume name, not a path");
    assert.ok(
      !m!.source.startsWith(process.env.FOLDRUN_DATA!),
      "the source is not under FOLDRUN_DATA — the exact shape that failed with 'mounts denied'",
    );
    assert.ok(!m!.source.includes(".runtimes-sandbox"), "the old host-dir path is gone");
  });
});

test("runtimeCacheMount: target is RUNTIME_CACHE, and distinct tenants get distinct volumes", () => {
  withCacheEnv({ cache: undefined }, () => {
    const a = runtimeCacheMount("acct-a");
    const b = runtimeCacheMount("acct-b");
    assert.equal(a!.target, RUNTIME_CACHE, "mounted where prepareRuntime looks");
    assert.equal(b!.target, RUNTIME_CACHE);
    assert.notEqual(a!.source, b!.source, "one volume per tenant — no shared, executable cache");
  });
});

test("runtimeCacheMount: the volume name satisfies Docker's charset rule", () => {
  // Docker's own rule (docker/docker names.go): [a-zA-Z0-9][a-zA-Z0-9_.-]*
  const DOCKER_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  withCacheEnv({ cache: undefined }, () => {
    for (const tenant of ["acct-123", "ABC123", "a_b-c", "acct.1", "0account", "x"]) {
      const m = runtimeCacheMount(tenant);
      assert.ok(m, `${tenant} is a safe segment and should mount`);
      assert.match(
        m!.source,
        DOCKER_VOLUME_NAME,
        `volume name ${m!.source} must be a legal Docker volume name`,
      );
    }
  });
});
