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
import crypto from "node:crypto";
import { spawnSync as spawnSh } from "node:child_process";
import {
  DOCKERFILE,
  ENGINE_DOWNLOAD_ATTEMPTS,
  RETRY_SH,
  allowedBack,
  buildFailureSummary,
  applyContainerChanges,
  hashTree,
  parseDriverLine,
  RUNTIME_CACHE,
  runnerImageRef,
  runnerImageTag,
  runtimeCacheMount,
} from "../src/run-container.ts";

function withRunnerImage<T>(value: string | undefined, body: () => T): T {
  const prev = process.env.FOLDRUN_RUNNER_IMAGE;
  if (value === undefined) delete process.env.FOLDRUN_RUNNER_IMAGE;
  else process.env.FOLDRUN_RUNNER_IMAGE = value;
  try {
    return body();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNNER_IMAGE;
    else process.env.FOLDRUN_RUNNER_IMAGE = prev;
  }
}

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
  // Only the base's hash known: the same answers.
  const h = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  assert.equal(mergeAppends(h("a\n"), b("a\nx"), b("a\ny\n"))!.toString(), "a\nx\ny\n");
  assert.equal(mergeAppends(h("a\nb\n"), b("a\nB\n"), b("a\nb\nc\n")), null);
  assert.equal(mergeAppends(h(""), b("x\n"), b("y\n"))!.toString(), "x\ny\n", "an empty base");
  assert.equal(mergeAppends(h("é\n"), b("é\nx\n"), b("é\ny\n"))!.toString(), "é\nx\ny\n", "multi-byte lines");
  assert.equal(mergeAppends(b("a\nb\n"), b("a\nb\nx\n"), b("a\nb\ny\n"))!.toString(), "a\nb\nx\ny\n");
  assert.equal(mergeAppends(b("a"), b("ab\n"), b("ac\n")), null, "a base that ends mid-line");
});

// A conflicted file of a few MB held the worker's event loop for minutes on
// 6 Oct 2026 (the liveness probe killed it every 4.5 minutes).
test("mergeAppends is linear in the file's size", async () => {
  const { mergeAppends } = await import("../src/run-container.ts");
  const base = Array.from({ length: 50_000 }, (_, i) => `{"line":${i},"pad":"${"x".repeat(80)}"}`).join("\n") + "\n";
  const t = Date.now();
  assert.equal(mergeAppends("0".repeat(64), Buffer.from(base + "host\n"), Buffer.from(base + "step\n")), null);
  const hash = crypto.createHash("sha256").update(base, "utf8").digest("hex");
  assert.equal(mergeAppends(hash, Buffer.from(base + "host\n"), Buffer.from(base + "step\n"))!.length, base.length + 10);
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t}ms on a ${(base.length / 1e6).toFixed(1)}MB file`);
});

// FOLDRUN_RUNNER_IMAGE names an image to run as-is; anything falsy means
// "build the content-hash image core produces itself". An empty string used
// to survive `??` into the build path as `docker build -t ""`, which docker
// rejects ("repository name must have at least one component"), so every step
// failed with the var set empty — exactly what a compose `${VAR:-…}` yields
// when someone tries to clear it. runnerImageRef resolves this without docker.
test("an empty or unset FOLDRUN_RUNNER_IMAGE builds the content-hash tag; a real value is used as-is", () => {
  const content = withRunnerImage(undefined, () => runnerImageTag());
  assert.notEqual(content, "");

  const empty = withRunnerImage("", () => runnerImageRef());
  assert.notEqual(empty.tag, "", "an empty value must not become an empty docker tag");
  assert.equal(empty.tag, content);
  assert.equal(empty.explicit, false);

  const unset = withRunnerImage(undefined, () => runnerImageRef());
  assert.equal(unset.tag, content);
  assert.equal(unset.explicit, false);

  const set = withRunnerImage("ghcr.io/foldrun-io/runner:v9", () => runnerImageRef());
  assert.equal(set.tag, "ghcr.io/foldrun-io/runner:v9");
  assert.equal(set.explicit, true);

  // The arch suffix is core's own naming for a cross-built image and rides
  // only the content-hash tag — an explicit image name is taken verbatim.
  const built = withRunnerImage("", () => runnerImageRef({ platform: "linux/arm64" }));
  assert.equal(built.tag, `${content}-arm64`);
  const explicit = withRunnerImage("me/runner:x", () => runnerImageRef({ platform: "linux/arm64" }));
  assert.equal(explicit.tag, "me/runner:x");
});

// The slim image is its own tag and its own override, so a step that asks
// for it can never be handed the full image by name collision, and setting
// one override never moves the other.
test("the slim variant has its own tag and its own override", () => {
  const prev = process.env.FOLDRUN_RUNNER_SLIM_IMAGE;
  try {
    delete process.env.FOLDRUN_RUNNER_SLIM_IMAGE;
    const full = withRunnerImage(undefined, () => runnerImageTag());
    const slim = withRunnerImage(undefined, () => runnerImageTag("slim"));
    assert.equal(slim, `${full}-slim`);
    // FOLDRUN_RUNNER_IMAGE names the full image only.
    const ref = withRunnerImage("reg/runner:full", () => runnerImageRef({ variant: "slim" }));
    assert.equal(ref.tag, slim);
    assert.equal(ref.explicit, false);
    process.env.FOLDRUN_RUNNER_SLIM_IMAGE = "reg/runner:slim";
    const set = withRunnerImage("reg/runner:full", () => runnerImageRef({ variant: "slim" }));
    assert.deepEqual(set, { tag: "reg/runner:slim", explicit: true });
    assert.equal(withRunnerImage("reg/runner:full", () => runnerImageRef()).tag, "reg/runner:full");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNNER_SLIM_IMAGE;
    else process.env.FOLDRUN_RUNNER_SLIM_IMAGE = prev;
  }
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

test("mtimeManifest + APPLY_MTIMES_JS put back the times a copy lost", async () => {
  const { mtimeManifest, APPLY_MTIMES_JS } = await import("../src/run-container.ts");
  const { spawnSync } = await import("node:child_process");
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "mt-src-"));
  fs.mkdirSync(path.join(src, "storage"));
  fs.writeFileSync(path.join(src, "storage/pending-replies.json"), "{}");
  const old = new Date("2026-09-13T23:42:08Z");
  fs.utimesSync(path.join(src, "storage/pending-replies.json"), old, old);
  const manifest = mtimeManifest(src);
  // A copy that stamps "now", the way kubectl cp's tar -m does.
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), "mt-dst-"));
  fs.cpSync(src, dst, { recursive: true });
  const f = path.join(dst, "storage/pending-replies.json");
  assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60_000, "the copy looks fresh — the bug");
  const m = path.join(os.tmpdir(), `mt-${process.pid}.json`);
  fs.writeFileSync(m, JSON.stringify(manifest));
  const r = spawnSync(process.execPath, ["-e", APPLY_MTIMES_JS, m, dst]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(Math.round(fs.statSync(f).mtimeMs / 1000), Math.round(old.getTime() / 1000));
});

test("the base image is pinned by digest — the same runner tag must always hold the same base", () => {
  const from = DOCKERFILE.split("\n")[0];
  assert.match(from, /^FROM node:\d+-[a-z]+-slim@sha256:[0-9a-f]{64} AS base$/);
  assert.doesNotMatch(DOCKERFILE, /FROM node:[^@\s]+ /, "no floating node tag anywhere");
});

test("Lightpanda past 0.3.6 needs glibc 2.38 — the base must not be Debian 12", () => {
  const lp = DOCKERFILE.match(/lightpanda-io\/browser\/releases\/download\/(\d+)\.(\d+)\.(\d+)\//);
  assert.ok(lp, "Lightpanda is downloaded by an exact version");
  const [maj, min, pat] = lp!.slice(1).map(Number);
  const past036 = maj > 0 || min > 3 || (min === 3 && pat > 6);
  if (past036) assert.doesNotMatch(DOCKERFILE.split("\n")[0], /bookworm/, "bookworm's glibc 2.36 cannot run it");
});

test("the slim runner ships fonts — without them every non-browser render draws empty boxes", () => {
  const slim = DOCKERFILE.split("FROM base AS slim")[1].split("FROM base AS browsers")[0];
  assert.match(slim, /fonts-dejavu-core/);
  assert.match(slim, /fontconfig/);
  // Emoji, CJK, Devanagari and Thai drew as empty boxes with DejaVu alone.
  for (const pkg of ["fonts-symbola", "fonts-wqy-microhei", "fonts-lohit-deva", "fonts-tlwg-loma-otf"]) assert.match(slim, new RegExp(pkg));
  // Not in base: the full image's browser layers must stay cached.
  assert.doesNotMatch(DOCKERFILE.split("FROM base AS slim")[0], /fonts-dejavu/);
});

test("core is installed in its own stage — the tarball and core's README never become a layer of slim or full", () => {
  const core = DOCKERFILE.split("FROM base AS core")[1].split("FROM base AS slim")[0];
  assert.match(core, /COPY foldrun-core\.tgz/);
  assert.match(core, /rm -f foldrun-core\.tgz node_modules\/@foldrun\/core\/README\.md/);
  const slim = DOCKERFILE.split("FROM base AS slim")[1].split("FROM base AS browsers")[0];
  const full = DOCKERFILE.split("FROM browsers AS full")[1];
  for (const stage of [slim, full]) {
    assert.match(stage, /COPY --from=core --chown=agent:agent \/opt\/runner\/ \.\//);
    assert.doesNotMatch(stage, /foldrun-core\.tgz/);
  }
});

test("the browsers stage installs Xvfb by name — headless: false must not hang on a Playwright dependency list", () => {
  const browsers = DOCKERFILE.split("FROM base AS browsers")[1].split("FROM browsers AS full")[0];
  assert.match(browsers, /apt-get install -y --no-install-recommends xvfb\b/);
  const commands = browsers.split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.doesNotMatch(commands, /xauth/, "nothing runs xvfb-run, so nothing needs xauth");
});

test("the full image writes down which engines it has, and an x86_64 build missing one fails", () => {
  const browsers = DOCKERFILE.split("FROM base AS browsers")[1].split("FROM browsers AS full")[0];
  assert.match(browsers, /\/opt\/browser\/engines\.json/);
  for (const e of ["chromium", "chrome", "firefox", "webkit", "lightpanda", "obscura"]) assert.match(browsers, new RegExp(`"${e}"|\\b${e}: one\\(`), `${e} is in the manifest`);
  assert.match(browsers, /arch === "x86_64"\) \{[^}]*process\.exit\(1\)/);
  // The probe is one shell-quoted program: a single quote inside it would end it early.
  const probe = browsers.split("RUN node -e '")[1].split("\n '")[0];
  assert.doesNotMatch(probe, /'/);
});

test("every best-effort engine download retries before the build gives up on it", () => {
  const browsers = DOCKERFILE.split("FROM base AS browsers")[1].split("FROM browsers AS full")[0];
  const runs = browsers.replace(/\\\n/g, "").split("\n").filter((l) => l.startsWith("RUN "));
  for (const engine of ["chrome", "chrome-beta", "lightpanda", "obscura"]) {
    const run = runs.find((r) => new RegExp(`retry ${engine} `).test(r));
    assert.ok(run, `${engine}'s download goes through retry`);
    assert.ok(run!.includes(RETRY_SH), `the RUN that retries ${engine} defines retry (a RUN is its own shell)`);
  }
  // The checksum is inside what is retried: a truncated download is a failed one.
  for (const engine of ["lightpanda", "obscura"]) {
    const run = runs.find((r) => r.includes(`retry ${engine} fetch`))!;
    assert.match(run.split("fetch() {")[1].split("; }")[0], /sha256sum -c/);
  }
  assert.equal(ENGINE_DOWNLOAD_ATTEMPTS, 3);
});

test("retry: tries three times with a growing wait, says so on stderr, and gives up with a failure", () => {
  // sleep is stubbed so the backoff is recorded, not waited.
  const script = `${RETRY_SH}
sleep() { echo "slept $1" >&2; }
c=0; flaky() { c=$((c+1)); [ "$c" -ge 2 ]; }
retry flaky flaky && echo "flaky ok after $c"
retry broken false || echo "broken gave up"`;
  const r = spawnSh("sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /flaky ok after 2/);
  assert.match(r.stdout, /broken gave up/);
  assert.match(r.stderr, /runner image: broken - download failed \(attempt 1 of 3\), retrying in 15s/);
  assert.match(r.stderr, /runner image: broken - download failed \(attempt 2 of 3\), retrying in 30s/);
  assert.match(r.stderr, /runner image: broken - download failed 3 times, giving up/);
  assert.equal((r.stderr.match(/slept/g) ?? []).length, 1 + 2, "one wait for flaky, two for broken");
});

test("a missing engine on x86_64 is named on a line of its own that leads the failure", () => {
  const browsers = DOCKERFILE.split("FROM base AS browsers")[1].split("FROM browsers AS full")[0];
  assert.match(browsers, /"runner image: MISSING ENGINES on x86_64: " \+ missing\.join\(", "\)/);
});

test("buildFailureSummary keeps the engine lines from anywhere in the log, not just its last 2000 characters", () => {
  const log = [
    "#5 [browsers 3/6] RUN npm install -g playwright",
    "#5 812.1 runner image: chrome - download failed (attempt 1 of 3), retrying in 15s",
    "#5 845.9 runner image: chrome - download failed 3 times, giving up",
    "#5 846.0 runner image: chrome not installed - engine: chrome would fall back to chromium",
    "#5 DONE 900.2s",
    "#9 [browsers 6/6] RUN node -e ' const fs = require(\"fs\") ...",
    "#9 3.112 {\"arch\":\"x86_64\"}",
    "#9 3.113 runner image: MISSING ENGINES on x86_64: chrome",
    "#9 3.113 runner image: every engine ships for x86_64, so a missing one is a failed download - failing the build",
    "#9 ERROR: process \"/bin/sh -c node -e '" + "x".repeat(4000) + "'\" did not complete successfully: exit code: 1",
    "Dockerfile:91",
    "x".repeat(5000),
  ].join("\n");
  assert.doesNotMatch(log.slice(-2000), /MISSING ENGINES/, "the fixture reproduces the lost line");
  const s = buildFailureSummary(log);
  const lines = s.split("\n");
  assert.equal(lines[0], "  runner image: MISSING ENGINES on x86_64: chrome", "the missing engines lead");
  assert.match(s, /runner image: chrome - download failed 3 times, giving up/);
  assert.doesNotMatch(s, /#9 3\.113/, "BuildKit's step prefix is taken off");
  const error = lines.find((l) => l.includes("ERROR:"))!;
  assert.ok(error.length < 320, "an ERROR line quoting the whole instruction is cut short");
  assert.ok(s.length < 1500 + 2000, "a summary, not the log");
  assert.match(buildFailureSummary("nothing useful"), /no engine or ERROR line/);
});

// The engine's own home files in an agent's folder (settings, backups,
// plugin caches, every session's transcript) never go into a sandbox and
// never come back — 5,274 of them had piled up on the box by 6 Oct 2026.
test("the agent engine's home files are neither copied in nor applied back", async () => {
  const { allowedBack } = await import("../src/run-container.ts");
  const { isPlatformPath } = await import("../src/store.ts");
  for (const p of [
    "agents/writer/.claude.json",
    "agents/writer/.claude/projects/-workspace-agents-writer/0b1318ab.jsonl",
    "agents/writer/.claude/backups/.claude.json.backup.1791155292509",
    "agents/writer/.claude/plugins/plugin-directory-cache-v2.json",
    "agents/writer/.claude/.last-cleanup",
    "agents/post-writer/.claude.conflict-muvssaf1.json",
    "agents/writer/.claude",
  ]) {
    assert.ok(isPlatformPath(p), `${p} is the engine's, not the workspace's`);
    assert.equal(allowedBack(p), false, `${p} must not come back`);
  }
  for (const p of [
    ".claude/agents/researcher.md", // an author's Claude Code subagent, imported as an agent
    "agents/writer/agent.md",
    "agents/writer/outputs/claude-notes.md",
    "agents/writer/my.claude.txt",
  ]) {
    assert.equal(isPlatformPath(p), false, `${p} is the workspace's own`);
  }
  assert.equal(allowedBack("agents/writer/outputs/claude-notes.md"), true);
});
