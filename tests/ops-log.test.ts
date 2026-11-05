// FOL-121: no account content in a platform log line. The writer's rules,
// then the proof that matters — a process inside the boundary that tries
// every way to print a marker, watched from outside through the raw bytes
// of its stdout and stderr.
//
//   node --test tests/ops-log.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { opsLine, errorFields, errorClass, stackFrames, ERROR_CLASSES, FIELDS, withOpsReason, opsBoundaryInstalled } from "../src/ops-log.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// All capitals and digits: the shape of a code and of an id, so every
// shape check is exercised rather than dodged by a lower-case letter.
const MARKER = "CANARYQ121ZZ";

test("a field holds only its shape; a sentence, a URL, a path, an email address does not fit and is dropped by count", () => {
  const line = opsLine("info", "scheduler.queued", {
    tenant: "acme",
    workspace: "sales-desk",
    runId: "run-mh2k9x-ab12",
    count: 3,
    ms: 12.5,
    retrying: true,
    flow: "write the report about Q3",
    agent: "https://example.com/x",
    eval: "/data/tenants/acme",
    tool: "ana@example.com",
    prompt: "hello",
    errorClass: "disk_full",
    reason: "Because It Said So",
  });
  assert.deepEqual(line, {
    ops: 1, level: "info", event: "scheduler.queued",
    tenant: "acme", workspace: "sales-desk", runId: "run-mh2k9x-ab12", count: 3, ms: 12.5, retrying: true, errorClass: "disk_full",
    dropped: 6,
  });
  assert.equal(opsLine("info", "not an event").event, "invalid_event");
  assert.equal(opsLine("info", "x".repeat(65)).event, "invalid_event");
  assert.equal(opsLine("error", "x", { errorClass: "made_up" }).errorClass, undefined);
  assert.equal(opsLine("error", "x", { count: Number.NaN }).count, undefined);
});

test("an error gives its class, its class name, a known code, its status and frames of our real files — never its message", () => {
  const err = Object.assign(new Error(`could not parse: ${MARKER}`), { code: "ECONNREFUSED", syscall: "connect", status: 503 });
  const f = errorFields(err);
  assert.equal(f.errorClass, "network_error");
  assert.equal(f.errorName, "Error");
  assert.equal(f.code, "ECONNREFUSED");
  assert.equal(f.syscall, "connect");
  assert.equal(f.status, 503);
  assert.ok(Array.isArray(f.frames) && f.frames.some((x) => x.startsWith("ops-log.test.ts:")), `frames: ${JSON.stringify(f.frames)}`);
  assert.doesNotMatch(JSON.stringify(opsLine("error", "x", f)), new RegExp(MARKER));

  // A settable name and code are not taken at their word.
  class ModelKeyError extends Error {}
  const named = Object.assign(new ModelKeyError("x"), { name: MARKER, code: MARKER });
  const nf = errorFields(named);
  assert.equal(nf.errorName, "ModelKeyError", "the class's name, not the settable `name`");
  assert.equal(nf.code, undefined, "an upper-case word is not a code");
  assert.equal(errorFields(Object.assign(new Error("x"), { code: "23505" })).code, "23505", "a SQLSTATE is");
  assert.equal(errorFields(Object.assign(new Error("x"), { code: "ERR_INVALID_ARG_TYPE" })).code, "ERR_INVALID_ARG_TYPE");

  // A forged stack names files that are not there: no frame is kept.
  assert.deepEqual(stackFrames(`Error: x\n    at ${MARKER} (/app/foldrun-core/src/${MARKER}.ts:1:1)\n    at /tmp/acme/hooks/run.mjs:3:1`), []);
  // A reason our own code attached, when it is a word.
  assert.equal(errorFields(withOpsReason(new Error("needs FOLDRUN_EGRESS_URL"), "no_egress_url")).reason, "no_egress_url");
  // A getter that throws does not take the log down.
  const nasty = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.equal(errorFields(nasty).errorClass, "platform_error");
});

test("the classes: a small closed set, chosen from codes and status, not prose", () => {
  assert.deepEqual([...ERROR_CLASSES], ["policy_denied", "timeout", "oom", "disk_full", "model_error", "network_error", "user_code_error", "not_found", "cancelled", "platform_error"]);
  const c = (props: Record<string, unknown>, message = "x") => errorClass(Object.assign(new Error(message), props));
  assert.equal(c({ code: "ENOSPC" }), "disk_full");
  assert.equal(c({ code: "ETIMEDOUT" }), "timeout");
  assert.equal(c({ name: "AbortError" }), "cancelled");
  assert.equal(c({ code: "ENOTFOUND" }), "network_error");
  assert.equal(c({ code: "ENOENT" }), "not_found");
  assert.equal(c({ status: 403 }), "policy_denied");
  assert.equal(c({}, "container OOMKilled"), "oom");
  assert.equal(c({}, "Claude Code process exited with code 1"), "model_error");
  assert.equal(c({ errorClass: "user_code_error" }), "user_code_error", "our own code may say");
  assert.equal(c({}), "platform_error");
  assert.equal(FIELDS.errorClass, "class");
});

test("outside a hosted process there is no boundary, and this test process is outside", () => {
  assert.equal(opsBoundaryInstalled(), false);
});

function runChild(mode: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: Buffer; err: Buffer }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(here, "ops-canary-child.ts")], {
      env: { ...process.env, CANARY_MARKER: MARKER, CANARY_MODE: mode, NODE_ENV: "production", FOLDRUN_LOG_MODE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout.on("data", (d: Buffer) => out.push(d));
    c.stderr.on("data", (d: Buffer) => err.push(d));
    c.on("close", (code) => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err) }));
  });
}

const lines = (b: Buffer) => b.toString("utf8").split("\n").filter(Boolean);

test("inside the boundary, no way of printing gets the marker onto stdout or stderr — and every line is one the writer made", async () => {
  const { code, out, err } = await runChild("all");
  const all = Buffer.concat([out, err]).toString("utf8");
  assert.equal(code, 0, all.slice(0, 2000));
  assert.ok(!all.toLowerCase().includes(MARKER.toLowerCase()), `the marker reached the streams:\n${all.slice(0, 4000)}`);
  // Every byte is a line the writer built: JSON, ops: 1, known fields only.
  const parsed = [...lines(out), ...lines(err)].map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const p of parsed) {
    assert.equal(p.ops, 1);
    for (const k of Object.keys(p)) assert.ok(["ops", "level", "event", "dropped"].includes(k) || k in FIELDS, `unknown field ${k}`);
  }
  const events = parsed.map((p) => p.event);
  // The raw calls arrived as what they are, with where they were made.
  assert.ok(events.filter((e) => e === "console").length >= 6, events.join(" "));
  assert.ok(events.includes("stream.raw"));
  assert.ok(parsed.some((p) => p.event === "console" && typeof p.at === "string" && /^ops-canary-child\.ts:\d+$/.test(p.at as string)), "a raw call says where it was made");
  const threw = parsed.find((p) => p.event === "console" && p.errorName === "CanaryFailure");
  assert.ok(threw, "a raw call handed an Error keeps its class name");
  assert.deepEqual(threw!.frames, [], "the forged stack's frames are not kept");
  const fields = parsed.find((p) => p.event === "canary.fields")!;
  assert.equal(fields.tenant, "acme");
  assert.equal(fields.count, 3);
  assert.equal(fields.dropped, 8);
  const fol107 = parsed.find((p) => p.event === "model.process_failed")!;
  assert.equal(fol107.errorClass, "model_error");
  assert.equal(fol107.where, "judge");
  assert.ok(events.includes("canary.done"), "the process got to the end");
});

for (const mode of ["rejection", "throw"]) {
  test(`inside the boundary, an uncaught ${mode} exits 1 and says only its class`, async () => {
    const { code, out, err } = await runChild(mode);
    const all = Buffer.concat([out, err]).toString("utf8");
    assert.equal(code, 1, all);
    assert.ok(!all.toLowerCase().includes(MARKER.toLowerCase()), all);
    const p = lines(err).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(p.some((l) => l.event === (mode === "throw" ? "process.uncaught_exception" : "process.unhandled_rejection") && l.errorName === "CanaryFailure"), all);
  });
}

test("FOLDRUN_LOG_MODE=raw keeps a process out of the boundary — the marker then prints, which is why manifests may not set it", async () => {
  const { out, err } = await runChild("all", { FOLDRUN_LOG_MODE: "raw" });
  assert.ok(Buffer.concat([out, err]).toString("utf8").includes(MARKER));
});
