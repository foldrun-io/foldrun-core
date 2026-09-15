// Test mode's one table, pinned: what the proxy allows, refuses and
// rewrites per host and method; how a Resend body is pointed at the sink;
// which secrets a sandbox is not handed; and how a step's state/ writes
// are moved under the run instead of onto the workspace.
//
//   node --test tests/test-mode.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TEST_SINK_EMAIL,
  WITHHELD,
  bodySummary,
  isDivertedPath,
  isSendCapableSecret,
  refusalBody,
  restoreDivertedDirs,
  rewriteResendEmail,
  snapshotDivertedDirs,
  testHeadline,
  testModeEnv,
  testPolicy,
  withholdSecrets,
} from "../src/test-mode.ts";
import { applyContainerChanges } from "../src/run-container.ts";
import { parseScripts } from "../src/script-tools.ts";
import { createFlowRun } from "../src/runner.ts";
import { parseFlow, readRun } from "../src/store.ts";
import { parseEval } from "../src/evals.ts";

test("reads always pass, whatever the host", () => {
  for (const host of ["api.twilio.com", "mybusiness.googleapis.com", "app.getreach.com", "api.resend.com", "example.org"]) {
    assert.deepEqual(testPolicy("GET", host, "/anything"), { action: "allow" }, host);
    assert.deepEqual(testPolicy("HEAD", host, "/"), { action: "allow" });
    assert.deepEqual(testPolicy("OPTIONS", host, "/"), { action: "allow" });
  }
});

test("a write to a model provider or a read-only service passes", () => {
  for (const host of ["api.anthropic.com", "openrouter.ai", "api.openai.com", "generativelanguage.googleapis.com", "api.dataforseo.com", "searxng.foldrun.svc.cluster.local"]) {
    assert.deepEqual(testPolicy("POST", host, "/v1/x"), { action: "allow" }, host);
  }
  // A port is not a different host.
  assert.deepEqual(testPolicy("POST", "API.OPENAI.COM:443", "/v1/chat/completions"), { action: "allow" });
});

test("a write anywhere else is refused — SMS, Business Profile, orders, the CRM, an unknown host", () => {
  for (const [host, p] of [
    ["api.twilio.com", "/2010-04-01/Accounts/AC1/Messages.json"],
    ["mybusiness.googleapis.com", "/v4/accounts/1/locations/2/localPosts"],
    ["mybusinessbusinessinformation.googleapis.com", "/v1/locations/2"],
    ["app.getreach.com", "/api/v1/orders"],
    ["api.github.com", "/repos/x/y/git/refs"],
    ["example.org", "/"],
  ]) {
    assert.deepEqual(testPolicy("POST", host, p), { action: "refuse" }, `${host}${p}`);
    assert.deepEqual(testPolicy("PATCH", host, p), { action: "refuse" });
    assert.deepEqual(testPolicy("DELETE", host, p), { action: "refuse" });
  }
  // A subdomain rule does not match its own apex, and never a lookalike.
  assert.deepEqual(testPolicy("POST", "dataforseo.com", "/"), { action: "refuse" });
  assert.deepEqual(testPolicy("POST", "notapi.openai.com.evil.example", "/"), { action: "refuse" });
});

test("a Resend send is the one write that is rewritten, and only on /emails", () => {
  assert.deepEqual(testPolicy("POST", "api.resend.com", "/emails"), { action: "rewrite", rewrite: "resend-email" });
  assert.deepEqual(testPolicy("POST", "api.resend.com", "/emails/batch"), { action: "rewrite", rewrite: "resend-email" });
  // Domains, API keys, audiences: writes that are not a send are still writes.
  assert.deepEqual(testPolicy("POST", "api.resend.com", "/domains"), { action: "refuse" });
  assert.deepEqual(testPolicy("DELETE", "api.resend.com", "/api-keys/1"), { action: "refuse" });
});

test("the Resend body goes to the sink, marked, with cc and bcc gone", () => {
  const out = rewriteResendEmail(JSON.stringify({ from: "d@x.io", to: ["a@b.com", "c@d.com"], cc: "e@f.com", bcc: ["g@h.com"], subject: "Your report", html: "<p>hi</p>" }))!;
  const mail = JSON.parse(out.body);
  assert.deepEqual(mail.to, [TEST_SINK_EMAIL]);
  assert.equal(mail.cc, undefined);
  assert.equal(mail.bcc, undefined);
  assert.equal(mail.subject, "[TEST] Your report");
  assert.equal(mail.html, "<p>hi</p>", "the content is untouched");
  assert.equal(mail.from, "d@x.io");
  assert.deepEqual(out.to, ["a@b.com", "c@d.com", "e@f.com", "g@h.com"], "who it would have gone to, for the trace");
  // A subject already marked is not marked twice; a body with no recipients still gets the sink.
  assert.equal(JSON.parse(rewriteResendEmail(JSON.stringify({ subject: "[TEST] x" }))!.body).subject, "[TEST] x");
  assert.deepEqual(JSON.parse(rewriteResendEmail("{}")!.body).to, [TEST_SINK_EMAIL]);
  // Not a JSON object: nothing safe to rewrite.
  assert.equal(rewriteResendEmail("to=a@b"), null);
  assert.equal(rewriteResendEmail("[1,2]"), null);
});

test("the refusal names what would have gone, cut short", () => {
  const body = JSON.parse(refusalBody("POST", "api.twilio.com", "/Messages.json", "To=%2B61400000000&From=%2B61400000001&Body=Hello"));
  assert.equal(body.test_mode, true);
  assert.equal(body.would_have.to, "+61400000000", "a form body's To is read");
  assert.equal(body.would_have.host, "api.twilio.com");
  const json = JSON.parse(refusalBody("POST", "h", "/p", JSON.stringify({ to: ["a@b"], text: "x".repeat(500) })));
  assert.deepEqual(json.would_have.to, ["a@b"]);
  assert.ok(json.would_have.body.length <= 201, "the summary is the first 200 characters");
  assert.equal(bodySummary("a  b\n\nc"), "a b c");
});

test("send-capable secrets are withheld by name; a declared sender loses all, a declared reader keeps all", () => {
  for (const n of ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN", "TWILIO_SID", "GETREACH_API_KEY", "GITHUB_TOKEN", "MONDAY_API_TOKEN", "OI_CRM_API_KEY", "CLOUDFLARE_R2_API_TOKEN", "LINKEDIN_ACCESS_TOKEN", "MEDIUM_COOKIES", "TIKTOK_CLIENT_KEY"]) {
    assert.ok(isSendCapableSecret(n), n);
  }
  for (const n of ["DATAFORSEO_LOGIN", "ANTHROPIC_API_KEY", "GSC_SERVICE_ACCOUNT", "RESEND_API_KEY_OLD", "MY_TWILIO_THING"]) {
    assert.ok(!isSendCapableSecret(n), n);
  }
  const secrets = { RESEND_API_KEY: "re_1", DATAFORSEO_LOGIN: "u", TWILIO_AUTH_TOKEN: "t" };
  const plain = withholdSecrets(secrets);
  assert.deepEqual(plain.env, { RESEND_API_KEY: WITHHELD, DATAFORSEO_LOGIN: "u", TWILIO_AUTH_TOKEN: WITHHELD });
  assert.deepEqual(plain.withheld, ["RESEND_API_KEY", "TWILIO_AUTH_TOKEN"]);
  const outward = withholdSecrets(secrets, { outward: true, allow: true });
  assert.deepEqual(Object.values(outward.env), [WITHHELD, WITHHELD, WITHHELD], "outward wins over allow");
  const allow = withholdSecrets(secrets, { allow: true });
  assert.deepEqual(allow.env, secrets);
  assert.deepEqual(allow.withheld, []);
  assert.deepEqual(testModeEnv(), { FOLDRUN_TEST_MODE: "1", FOLDRUN_RUN_TEST: "1" });
});

test("a tool file's outward: and test_mode: reach the parsed spec", () => {
  const [a, b, c] = parseScripts([
    { name: "send_sms", run: "run.py", outward: true },
    { name: "read_gbp", run: "run.py", test_mode: "allow" },
    { name: "plain", run: "run.py", outward: "yes", test_mode: "deny" },
  ]);
  assert.equal(a.outward, true);
  assert.equal(a.testMode, undefined);
  assert.equal(b.testMode, "allow");
  assert.equal(b.outward, undefined);
  assert.equal(c.outward, undefined, "only the literal true");
  assert.equal(c.testMode, undefined, "only the literal allow");
});

test("state/ and storage/ are diverted; everything else is not", () => {
  assert.ok(isDivertedPath("state/sends.md"));
  assert.ok(isDivertedPath("storage/report.csv"));
  assert.ok(isDivertedPath("storage/public/x.png"));
  assert.ok(!isDivertedPath("agents/a/outputs/x.md"));
  assert.ok(!isDivertedPath("memory/lesson.md"));
  assert.ok(!isDivertedPath("statement.md"), "a prefix match is on the directory, not the letters");
  assert.equal(testHeadline("GOOD: 3 sent"), "[test] GOOD: 3 sent");
  assert.equal(testHeadline("[test] already"), "[test] already");
});

test("the sandbox write-back keeps a test run's state/ under the run and leaves the workspace's copy alone", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-divert-"));
  const host = path.join(tmp, "ws");
  const staged = path.join(tmp, "in");
  const out = path.join(tmp, "out");
  const aside = path.join(host, "runs", "run-1", "test-writes");
  fs.mkdirSync(path.join(host, "state"), { recursive: true });
  fs.mkdirSync(path.join(host, "agents", "a", "outputs"), { recursive: true });
  fs.writeFileSync(path.join(host, "state", "sends.md"), "a\nb\n");
  fs.cpSync(host, staged, { recursive: true });
  fs.cpSync(host, out, { recursive: true });
  // What the step did: appended to state, created a storage file, wrote an output.
  fs.writeFileSync(path.join(out, "state", "sends.md"), "a\nb\nc\nd\n");
  fs.mkdirSync(path.join(out, "storage"), { recursive: true });
  fs.writeFileSync(path.join(out, "storage", "report.csv"), "x,y\n");
  fs.writeFileSync(path.join(out, "agents", "a", "outputs", "note.md"), "done");

  const notes: string[] = [];
  const applied = applyContainerChanges(host, out, staged, undefined, { to: aside, note: (rel, s) => notes.push(`${rel}: ${s}`) });

  assert.equal(fs.readFileSync(path.join(host, "state", "sends.md"), "utf8"), "a\nb\n", "the workspace's state is untouched");
  assert.ok(!fs.existsSync(path.join(host, "storage", "report.csv")), "nothing landed in storage/");
  assert.equal(fs.readFileSync(path.join(host, "agents", "a", "outputs", "note.md"), "utf8"), "done", "outputs still come back");
  assert.equal(fs.readFileSync(path.join(aside, "state", "sends.md"), "utf8"), "a\nb\nc\nd\n", "the would-be state is kept under the run");
  assert.equal(fs.readFileSync(path.join(aside, "storage", "report.csv"), "utf8"), "x,y\n");
  assert.deepEqual(applied.map((r) => r.replaceAll("\\", "/")), ["agents/a/outputs/note.md"]);
  assert.deepEqual(notes.sort(), ["state/sends.md: would have written state/sends.md, +2 lines", "storage/report.csv: would have created storage/report.csv (4 bytes)"]);

  // Without a divert (a live run) the same changes land where they always did.
  const live = path.join(tmp, "live");
  fs.cpSync(staged, live, { recursive: true });
  applyContainerChanges(live, out, staged);
  assert.equal(fs.readFileSync(path.join(live, "state", "sends.md"), "utf8"), "a\nb\nc\nd\n");
  assert.equal(fs.readFileSync(path.join(live, "storage", "report.csv"), "utf8"), "x,y\n");
});

test("the in-process path snapshots and restores: what changed goes under the run, deletions are undone", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-inproc-"));
  fs.mkdirSync(path.join(ws, "state"));
  fs.mkdirSync(path.join(ws, "storage", "sub"), { recursive: true });
  fs.writeFileSync(path.join(ws, "state", "cursor.json"), "{\"n\":1}");
  fs.writeFileSync(path.join(ws, "storage", "sub", "keep.txt"), "keep");
  fs.writeFileSync(path.join(ws, "storage", "gone.txt"), "gone");
  const before = snapshotDivertedDirs(ws);
  // The step: changes one, adds one, deletes one, leaves one.
  fs.writeFileSync(path.join(ws, "state", "cursor.json"), "{\"n\":2}");
  fs.writeFileSync(path.join(ws, "storage", "new.csv"), "a\n");
  fs.rmSync(path.join(ws, "storage", "gone.txt"));
  const to = path.join(ws, "runs", "run-9", "test-writes");
  const notes: string[] = [];
  const aside = restoreDivertedDirs(ws, before, to, (rel, s) => notes.push(s));
  assert.equal(fs.readFileSync(path.join(ws, "state", "cursor.json"), "utf8"), "{\"n\":1}", "restored");
  assert.ok(!fs.existsSync(path.join(ws, "storage", "new.csv")), "the new file is gone from the workspace");
  assert.equal(fs.readFileSync(path.join(ws, "storage", "gone.txt"), "utf8"), "gone", "the deletion is undone");
  assert.equal(fs.readFileSync(path.join(ws, "storage", "sub", "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(to, "state", "cursor.json"), "utf8"), "{\"n\":2}", "the would-be write is kept");
  assert.equal(fs.readFileSync(path.join(to, "storage", "new.csv"), "utf8"), "a\n");
  assert.deepEqual(aside.sort(), ["state/cursor.json", "storage/gone.txt", "storage/new.csv"]);
  assert.ok(notes.includes("would have deleted storage/gone.txt"));
  assert.ok(notes.includes("would have written state/cursor.json"));
});

test("the flag is on the record, live: is read off a flow and an eval, and nothing is a test by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-testflag-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "agents/worker"), { recursive: true });
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    const step = { agent: "worker", instruction: "work", group: 1, optional: false };
    const live = createFlowRun("acme", "desk", [step], "f", "queued");
    assert.equal(live.test, undefined, "a run is live unless asked");
    const t = createFlowRun("acme", "desk", [step], "f", "queued", [], null, { test: true });
    assert.equal(t.test, true);
    assert.equal(readRun("acme", "desk", t.id)?.test, true, "written to disk with the record");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
  }
  assert.equal(parseFlow("f.md", "---\nname: f\nlive: true\n---\n1. [[worker]] — go\n").live, true);
  assert.equal(parseFlow("f.md", "---\nname: f\nlive: yes\n---\n1. [[worker]] — go\n").live, false, "only the literal true");
  assert.equal(parseFlow("f.md", "---\nname: f\n---\n1. [[worker]] — go\n").live, false);
  assert.equal(parseEval("e.md", "---\nname: e\nagent: worker\nlive: true\n---\n\n## case\ntask: x\nexpect:\n- contains: y\n").live, true);
  assert.equal(parseEval("e.md", "---\nname: e\nagent: worker\n---\n\n## case\ntask: x\nexpect:\n- contains: y\n").live, false);
});
