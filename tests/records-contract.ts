// What any RecordsPort must do, seen through core's own functions (writeRun,
// listRunSummaries, recordTriggerEvent, putFile …) — so the suite checks the
// port AND that core's wiring uses it. Run against the in-memory fake in core
// (records-contract-fake.test.ts) and against real Postgres in
// foldrun-platform (tests/records-contract-pg.test.ts).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerPlatform, resetPlatform } from "../src/platform.ts";
import type { RecordsPort } from "../src/records.ts";
import {
  writeRun, writeRunAsync, readRun, readRunAsync, listRunSummariesAsync, liveRunsAsync, deleteRun, liveRuns, listRuns, listRunSummaries, listAllRuns, listWorkspaces,
  runStamp, runUpdatedMs, readRunText, runsStartedSince, renameWorkspace, deleteWorkspace, workspaceDir,
  type RunRecord,
} from "../src/store.ts";
import { recordTriggerEvent, readTriggerEvents, summariseTriggers } from "../src/trigger-log.ts";
import { contextKey, earlierTurns } from "../src/conversation.ts";
import { putFile, getFile, listStorage, deleteFile, readFileBytes, withFileStoreLock, purgeWorkspaceStorage, moveWorkspaceStorage, usedBytes } from "../src/storage.ts";

const run = (id: string, at: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  flow: "publish",
  status: "completed",
  startedAt: at,
  finishedAt: at,
  summary: `${id} done`,
  steps: [
    {
      agent: "writer", instruction: "write", group: 1, optional: false, status: "completed",
      events: [{ t: at, type: "text", text: "a reply" }], result: "the reply", conclusion: "done", costUsd: 0.25,
    },
  ],
  ...extra,
});

export interface Subject {
  port: RecordsPort;
  /** Called when the test is over. */
  done(): Promise<void> | void;
}

export function recordsContract(label: string, make: () => Promise<Subject>): void {
  let root: string;
  let subject: Subject;
  const T = "acme";
  const W = "desk";
  const mkWs = (name: string) => {
    fs.mkdirSync(path.join(root, T, "workspaces", name, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, T, "workspaces", name, "AGENTS.md"), `---\nname: ${name}\n---\n`);
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-records-"));
    process.env.FOLDRUN_DATA = root;
    delete process.env.FOLDRUN_STORAGE_DRIVER;
    subject = await make();
    registerPlatform({ records: subject.port });
    mkWs(W);
  });
  afterEach(async () => {
    resetPlatform();
    await subject.done();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FOLDRUN_DATA;
  });

  const t = (name: string) => `[${label}] ${name}`;

  test(t("a conversation's earlier turns (FOL-162): its key, its test flag, finished before the asking run was made, newest first"), () => {
    const key = contextKey("chat");
    const ctx = { context: { id: "chat", key } };
    writeRun(T, W, run("c1", "2026-11-01T01:00:00.000Z", { ...ctx, finishedAt: "2026-11-01T01:05:00.000Z" }));
    writeRun(T, W, run("c2", "2026-11-01T02:00:00.000Z", { ...ctx, status: "failed", finishedAt: "2026-11-01T02:05:00.000Z" }));
    writeRun(T, W, run("c-test", "2026-11-01T02:10:00.000Z", { ...ctx, test: true, finishedAt: "2026-11-01T02:15:00.000Z" }));
    writeRun(T, W, run("c-live", "2026-11-01T02:20:00.000Z", { ...ctx, status: "running", finishedAt: null }));
    writeRun(T, W, run("c-late", "2026-11-01T02:30:00.000Z", { ...ctx, finishedAt: "2026-11-01T09:00:00.000Z" }));
    writeRun(T, W, run("c-other", "2026-11-01T02:40:00.000Z", { context: { id: "other", key: contextKey("other") }, finishedAt: "2026-11-01T02:45:00.000Z" }));
    writeRun(T, W, run("c-none", "2026-11-01T02:50:00.000Z", { finishedAt: "2026-11-01T02:55:00.000Z" }));
    const asking = { id: "c-now", startedAt: "2026-11-01T03:00:00.000Z", ...ctx };
    assert.deepEqual(earlierTurns(T, W, asking).map((r) => r.id), ["c2", "c1"]);
    assert.deepEqual(earlierTurns(T, W, { ...asking, test: true }).map((r) => r.id), ["c-test"]);
    assert.deepEqual(earlierTurns(T, W, asking, 1).map((r) => r.id), ["c2"], "the limit holds");
    assert.deepEqual(earlierTurns(T, W, { ...asking, id: "c2", startedAt: "2026-11-01T02:00:00.000Z" }).map((r) => r.id), ["c1"]);
    assert.equal(earlierTurns(T, W, asking)[0]!.context?.key, key, "whole records come back");
  });

  test(t("a run round-trips whole, events and all, and nothing is written under runs/"), () => {
    const r = run("run-a", "2026-11-01T01:00:00.000Z");
    writeRun(T, W, r);
    assert.deepEqual(readRun(T, W, "run-a"), r);
    assert.equal(readRun(T, W, "run-nope"), null);
    assert.equal(fs.existsSync(path.join(workspaceDir(T, W), "runs")), false, "no file was made");
  });

  test(t("the last write of a run wins, and its stamp moves"), () => {
    writeRun(T, W, run("run-a", "2026-11-01T01:00:00.000Z", { status: "running", finishedAt: undefined }));
    const first = runStamp(T, W, "run-a");
    assert.ok(first);
    writeRun(T, W, run("run-a", "2026-11-01T01:00:00.000Z", { status: "completed" }));
    assert.equal(readRun(T, W, "run-a")!.status, "completed");
    assert.notEqual(runStamp(T, W, "run-a"), first);
    // Milliseconds, as the file's mtime is: a run just written is minutes old at most.
    assert.ok(Math.abs(Date.now() - runUpdatedMs(T, W, "run-a")!) < 60_000, "runUpdatedMs is epoch milliseconds");
    assert.equal(runStamp(T, W, "run-none"), null);
    assert.equal(JSON.parse(readRunText(T, W, "run-a")!).status, "completed");
    assert.equal(readRunText(T, W, "run-none"), null);
  });

  test(t("the async reads answer what the synchronous ones do, and fall back to them without an async port"), async () => {
    writeRun(T, W, run("run-a", "2026-11-01T10:00:00.000Z"));
    writeRun(T, W, run("run-b", "2026-11-01T11:00:00.000Z", { status: "running", finishedAt: undefined }));
    assert.deepEqual(await readRunAsync(T, W, "run-a"), readRun(T, W, "run-a"));
    assert.equal(await readRunAsync(T, W, "run-none"), null);
    assert.deepEqual(await listRunSummariesAsync(T, W), listRunSummaries(T, W));
    assert.deepEqual((await liveRunsAsync(T, W)).map((r) => r.id), liveRuns(T, W).map((r) => r.id));
    await assert.rejects(readRunAsync(T, W, "../x"), "the same name checks as the synchronous read");
    // a port with no async reads is read through its synchronous twin
    const plain = { ...subject.port, async: undefined } as RecordsPort;
    registerPlatform({ records: plain });
    assert.equal((await readRunAsync(T, W, "run-a"))?.id, "run-a");
    assert.deepEqual((await listRunSummariesAsync(T, W)).map((r) => r.id), ["run-b", "run-a"]);
  });

  test(t("an async run write lands like the synchronous one, replaces by id, and falls back to it without an async port"), async () => {
    await writeRunAsync(T, W, run("run-a", "2026-11-01T10:00:00.000Z", { status: "running", finishedAt: undefined }));
    assert.equal(readRun(T, W, "run-a")?.status, "running");
    assert.deepEqual(liveRuns(T, W).map((r) => r.id), ["run-a"]);
    await writeRunAsync(T, W, run("run-a", "2026-11-01T10:00:00.000Z"));
    assert.equal(readRun(T, W, "run-a")?.status, "completed");
    assert.deepEqual(liveRuns(T, W), [], "it ended, so it stopped being live");
    assert.equal(listRunSummaries(T, W).length, 1, "one row per run");
    await assert.rejects(writeRunAsync(T, W, run("../x", "2026-11-01T10:00:00.000Z")), "the same name checks as writeRun");
    const plain = { ...subject.port, async: undefined } as RecordsPort;
    registerPlatform({ records: plain });
    await writeRunAsync(T, W, run("run-b", "2026-11-01T11:00:00.000Z"));
    assert.equal(readRun(T, W, "run-b")?.id, "run-b");
  });

  test(t("summaries come back newest first, without replies; live runs are whole"), () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    writeRun(T, W, run("r2", "2026-11-01T02:00:00.000Z", { status: "running", finishedAt: undefined }));
    writeRun(T, W, run("r3", "2026-11-01T03:00:00.000Z", { status: "awaiting-approval", finishedAt: undefined }));
    writeRun(T, W, run("r4", "2026-11-01T04:00:00.000Z", { status: "failed" }));
    const rows = listRunSummaries(T, W);
    assert.deepEqual(rows.map((s) => s.id), ["r4", "r3", "r2", "r1"]);
    assert.equal(rows[3].steps[0].agent, "writer");
    assert.equal("result" in rows[3].steps[0], false);
    assert.deepEqual(liveRuns(T, W).map((x) => x.id), ["r3", "r2"]);
    assert.equal(liveRuns(T, W)[0].steps[0].events.length, 1, "a live run is read whole");
    assert.deepEqual(listRuns(T, W).map((x) => x.id), ["r4", "r3", "r2", "r1"]);
    assert.deepEqual(listAllRuns(T).map((x) => x.id), ["r4", "r3", "r2", "r1"]);
    assert.deepEqual(runsStartedSince(T, W, Date.parse("2026-11-01T02:30:00Z")).map((x) => x.id), ["r4", "r3"]);
  });

  test(t("a run that ends stops being live"), () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z", { status: "running", finishedAt: undefined }));
    assert.equal(liveRuns(T, W).length, 1);
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z", { status: "completed" }));
    assert.equal(liveRuns(T, W).length, 0);
  });

  test(t("deleting a run removes the row and its output folder, and says whether it was there"), () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    const out = path.join(workspaceDir(T, W), "runs", "r1", "outputs", "writer");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "a.txt"), "x");
    assert.equal(deleteRun(T, W, "r1"), true);
    assert.equal(readRun(T, W, "r1"), null);
    assert.equal(fs.existsSync(path.join(workspaceDir(T, W), "runs", "r1")), false);
    assert.equal(deleteRun(T, W, "r1"), false);
  });

  test(t("workspaces list their run count; other workspaces and accounts do not see each other's runs"), () => {
    mkWs("other");
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    writeRun(T, W, run("r2", "2026-11-01T02:00:00.000Z"));
    writeRun(T, "other", run("r1", "2026-11-01T03:00:00.000Z", { summary: "the other one" }));
    writeRun("someone", W, run("r1", "2026-11-01T04:00:00.000Z"));
    const counts = Object.fromEntries(listWorkspaces(T).map((w) => [w.name, w.runCount]));
    assert.deepEqual(counts, { desk: 2, other: 1 });
    assert.equal(readRun(T, "other", "r1")!.summary, "the other one");
    assert.equal(listRunSummaries("someone", W).length, 1);
  });

  test(t("renaming a workspace (as the API does: records, then the bytes) takes its runs, trigger log and files; deleting one drops them"), async () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    recordTriggerEvent(T, W, { t: "2026-11-01T01:00:00.000Z", flow: "f", trigger: "webhook", outcome: "started" });
    await putFile(T, W, "a.txt", Buffer.from("hello"), "user:a");
    renameWorkspace(T, W, "moved");
    assert.equal(readRun(T, W, "r1"), null);
    assert.equal(readRun(T, "moved", "r1")!.id, "r1");
    assert.equal(readTriggerEvents(T, "moved").length, 1);
    assert.equal(listStorage(T, W).length, 1, "the file index has not moved: it moves with the bytes");
    await moveWorkspaceStorage(T, W, "moved");
    assert.equal(listStorage(T, W).length, 0);
    assert.equal(listStorage(T, "moved").length, 1, "the rows survive a rename done in the API's order");
    assert.equal((await readFileBytes(T, "moved", "a.txt"))!.toString(), "hello");
    await purgeWorkspaceStorage(T, "moved");
    deleteWorkspace(T, "moved");
    assert.equal(readRun(T, "moved", "r1"), null);
    assert.equal(readTriggerEvents(T, "moved").length, 0);
    assert.equal(listStorage(T, "moved").length, 0);
  });

  test(t("a workspace the port says is on files is read and written as files; the others use the port"), () => {
    mkWs("other");
    registerPlatform({ records: { ...subject.port, onFiles: (_t: string, w: string) => w === "desk" } });
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    writeRun(T, "other", run("r2", "2026-11-01T02:00:00.000Z"));
    assert.ok(fs.existsSync(path.join(workspaceDir(T, W), "runs", "r1.json")), "desk wrote a file");
    assert.equal(fs.existsSync(path.join(workspaceDir(T, "other"), "runs", "r2.json")), false, "other wrote to the port");
    assert.equal(readRun(T, W, "r1")!.id, "r1");
    assert.deepEqual(listRunSummaries(T, W).map((x) => x.id), ["r1"]);
    assert.deepEqual(listRunSummaries(T, "other").map((x) => x.id), ["r2"]);
    assert.equal(Object.fromEntries(listWorkspaces(T).map((w) => [w.name, w.runCount])).desk, 1);
    recordTriggerEvent(T, W, { t: "2026-11-01T01:00:00.000Z", flow: "f", trigger: "webhook", outcome: "started" });
    assert.ok(fs.existsSync(path.join(workspaceDir(T, W), "trigger-log.jsonl")));
    assert.equal(readTriggerEvents(T, W).length, 1);
  });

  test(t("a rename whose records cannot move puts the folder back (Codex review)"), () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    registerPlatform({ records: { ...subject.port, workspaceMove() { throw new Error("database down"); } } });
    assert.throws(() => renameWorkspace(T, W, "moved"), /database down/);
    assert.ok(fs.existsSync(workspaceDir(T, W)), "the workspace is where it was");
    assert.equal(fs.existsSync(path.join(root, T, "workspaces", "moved")), false);
    registerPlatform({ records: subject.port });
    assert.equal(readRun(T, W, "r1")!.id, "r1", "and still has its runs");
  });

  test(t("a delete whose records cannot be dropped removes nothing, and can be retried (Codex review)"), () => {
    writeRun(T, W, run("r1", "2026-11-01T01:00:00.000Z"));
    registerPlatform({ records: { ...subject.port, workspaceDrop() { throw new Error("database down"); } } });
    assert.throws(() => deleteWorkspace(T, W), /database down/);
    assert.ok(fs.existsSync(workspaceDir(T, W)), "the folder is still there");
    registerPlatform({ records: subject.port });
    deleteWorkspace(T, W);
    assert.equal(readRun(T, W, "r1"), null);
    assert.equal(fs.existsSync(path.join(root, T, "workspaces", W)), false);
  });

  test(t("the trigger log answers newest first, keeps the newest 500, and feeds the summary"), () => {
    for (let i = 0; i < 520; i++) {
      recordTriggerEvent(T, W, { t: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(), flow: i % 2 ? "a" : "b", trigger: "webhook", outcome: i % 5 === 0 ? "duplicate" : "started", detail: `n${i}`, ...(i === 519 ? { runId: "run-x" } : {}) });
    }
    const all = readTriggerEvents(T, W, 1000);
    assert.equal(all.length, 500);
    assert.equal(all[0].detail, "n519");
    assert.equal(all[0].runId, "run-x");
    assert.equal(all.at(-1)!.detail, "n20");
    assert.equal(readTriggerEvents(T, W, 3).length, 3);
    const sum = summariseTriggers(T, W);
    assert.equal(sum.reduce((n, f) => n + f.fired, 0), 500);
    // Not for a workspace that is not there.
    recordTriggerEvent(T, "ghost", { t: "2026-11-01T00:00:00.000Z", flow: "f", trigger: "webhook", outcome: "started" });
    assert.equal(readTriggerEvents(T, "ghost").length, 0);
  });

  test(t("the storage index lives in the port: put, replace, list, delete, quota — and no index.json is written"), async () => {
    const a = await putFile(T, W, "docs/a.txt", Buffer.from("alpha"), "user:a");
    await putFile(T, W, "b.txt", Buffer.from("bravo"), "user:a");
    assert.deepEqual(listStorage(T, W).map((f) => f.path).sort(), ["b.txt", "docs/a.txt"]);
    assert.equal(getFile(T, W, "docs/a.txt")!.sha, a.sha);
    assert.equal(usedBytes(T, W), 10);
    const again = await putFile(T, W, "docs/a.txt", Buffer.from("alpha"), "user:b");
    assert.equal(again.by, "user:a", "same bytes under the same name: nothing happened");
    await putFile(T, W, "docs/a.txt", Buffer.from("alpha2"), "user:b");
    assert.equal(getFile(T, W, "docs/a.txt")!.by, "user:b");
    assert.equal((await readFileBytes(T, W, "docs/a.txt"))!.toString(), "alpha2");
    assert.equal(await deleteFile(T, W, "b.txt"), true);
    assert.equal(await deleteFile(T, W, "b.txt"), false);
    assert.equal(listStorage(T, W).length, 1);
    assert.equal(fs.existsSync(path.join(root, T, "storage", W, "index.json")), false);
    await purgeWorkspaceStorage(T, W);
    assert.equal(listStorage(T, W).length, 0);
  });

  test(t("concurrent uploads of different paths all land, and of one path leave one row"), async () => {
    const names = Array.from({ length: 16 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((n) => putFile(T, W, n, Buffer.from(`body ${n}`), "user:a")));
    assert.deepEqual(listStorage(T, W).map((f) => f.path).sort(), [...names].sort());
    await Promise.all(Array.from({ length: 8 }, (_, i) => putFile(T, W, "same.txt", Buffer.from(`v${i}`), "user:a")));
    assert.equal(listStorage(T, W).filter((f) => f.path === "same.txt").length, 1);
  });

  test(t("moving a workspace's storage carries its rows"), async () => {
    await putFile(T, W, "a.txt", Buffer.from("alpha"), "user:a");
    await moveWorkspaceStorage(T, W, "moved");
    assert.equal(listStorage(T, W).length, 0);
    assert.equal(listStorage(T, "moved").length, 1);
    assert.equal((await readFileBytes(T, "moved", "a.txt"))!.toString(), "alpha");
  });

  test(t("the short lock is exclusive, hands its result back, and a throw frees it"), async () => {
    const order: string[] = [];
    const slow = withFileStoreLock(T, W, async () => {
      order.push("a-in");
      await new Promise((r) => setTimeout(r, 60));
      order.push("a-out");
      return 1;
    });
    const fast = withFileStoreLock(T, W, async () => {
      order.push("b-in");
      order.push("b-out");
      return 2;
    });
    assert.deepEqual(await Promise.all([slow, fast]), [1, 2]);
    // Exclusive, not necessarily first-come: whichever got in finished before the other began.
    const joined = order.join(",");
    assert.ok(joined === "a-in,a-out,b-in,b-out" || joined === "b-in,b-out,a-in,a-out", joined);
    await assert.rejects(() => withFileStoreLock(T, W, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await withFileStoreLock(T, W, async () => "free"), "free");
  });
}
