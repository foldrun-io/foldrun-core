// FOL-240 slice 1: the computer's budget, what an agent asks (the cloud's own functions), what is in force.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentAsks, budgetFor, detectComputer, parseBudget, readHolds, recordHold, resolveLocal } from "../src/local-resources.ts";

const mac = { os: "darwin" as const, cores: 10, memoryMi: 16 * 1024 };

test("budgetFor: shares of what is left after room for the system, in half cores and 256 MiB", () => {
  assert.deepEqual(budgetFor("light", mac), { cpu: 2.5, memoryMi: 3584 });
  assert.deepEqual(budgetFor("balanced", mac), { cpu: 4.5, memoryMi: 7168 });
  assert.deepEqual(budgetFor("most", mac), { cpu: 7, memoryMi: 10752 });
  assert.deepEqual(budgetFor("none", mac), { cpu: null, memoryMi: null });
  const small = budgetFor("light", { os: "linux", cores: 1, memoryMi: 2048 });
  assert.ok(small.cpu! >= 0.5 && small.memoryMi! >= 512, "never below a usable floor");
  const c = detectComputer();
  assert.ok(c.cores >= 1 && c.memoryMi > 0);
});

test("parseBudget: cpu=…,memory=…, off, a choice's name; out-of-range refused", () => {
  assert.deepEqual(parseBudget("cpu=2,memory=4Gi", mac), { budget: { cpu: 2, memoryMi: 4096 } });
  assert.deepEqual(parseBudget("off", mac), { budget: { cpu: null, memoryMi: null } });
  assert.deepEqual(parseBudget("balanced", mac), { budget: budgetFor("balanced", mac) });
  assert.match((parseBudget("cpu=64", mac) as any).problem, /10 cores/);
  assert.match((parseBudget("memory=4", mac) as any).problem, /4Gi/);
  assert.match((parseBudget("ram=4Gi", mac) as any).problem, /cpu=2,memory=4Gi/);
});

test("agentAsks: from size: and resources: as the cloud resolves them; nothing when it writes neither", () => {
  assert.deepEqual(agentAsks({}), { ask: null, problems: [] });
  assert.deepEqual(agentAsks({ size: "heavy" }).ask, { cpu: 4, memoryMi: 8192 });
  assert.deepEqual(agentAsks({ size: "small", resources: { memory: "3Gi" } }).ask, { cpu: 1, memoryMi: 3072 });
  assert.match(agentAsks({ size: "huge" }).problems.join(), /small, large or heavy/);
});

test("resolveLocal: the lowest of budget, session ceiling and ask; over named; held said as it is", () => {
  const rows = resolveLocal({ budget: { cpu: 4, memoryMi: 4096 }, session: { cpu: null, memoryMi: 2048 }, ask: { cpu: 8, memoryMi: 1024 } });
  assert.deepEqual(rows[0], { resource: "cpu", asked: 8, allowed: 4, inForce: 4, over: true, held: "not yet held" });
  assert.deepEqual(rows[1], { resource: "memory", asked: 1024, allowed: 2048, inForce: 1024, over: false, held: "not yet held" });
  assert.equal(resolveLocal({ budget: { cpu: null, memoryMi: null }, ask: null })[0].held, "no limit");
  assert.equal(resolveLocal({ budget: { cpu: 2, memoryMi: 1024 }, ask: null, held: { cpu: "not yet held", memory: "sampled" } })[1].held, "sampled");
});

test("holds: each session's record, a gone session's dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-holds-"));
  try {
    const release = recordHold(dir, { folder: "/x", cpu: 2, memoryMi: 2048 });
    fs.writeFileSync(path.join(dir, "999999999.json"), JSON.stringify({ pid: 999999999, folder: "/y", cpu: 1, memoryMi: 1, since: "x" }));
    const held = readHolds(dir);
    assert.deepEqual(held.map((h) => h.pid), [process.pid]);
    assert.ok(!fs.existsSync(path.join(dir, "999999999.json")), "a gone session's record is removed");
    release();
    assert.deepEqual(readHolds(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
