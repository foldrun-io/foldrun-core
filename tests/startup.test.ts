import { test } from "node:test";
import assert from "node:assert/strict";
import { startupBreakdown, STARTUP_PHASES } from "../src/startup.ts";
import { STARTUP_PHASES as FROM_CONTAINER } from "../src/run-container.ts";

const row = (s: ReturnType<typeof startupBreakdown>) =>
  s.map((x) => `${x.phase} ${x.from.toFixed(2)}→${x.at.toFixed(2)} +${x.took.toFixed(2)}${x.parallel ? " ∥" : ""}${x.waited ? ` waited ${x.waited.toFixed(2)}` : ""}`);

test("run-container's phase list is startup.ts's", () => {
  assert.equal(FROM_CONTAINER, STARTUP_PHASES);
});

test("services before the pod: every phase in line, each its gap since the one before", () => {
  const s = startupBreakdown({ services: 0.4, room: 0.45, applied: 0.52, ready: 1.38, files: 2.9, go: 3.38, model: 7.45 });
  assert.deepEqual(row(s), [
    "services 0.00→0.40 +0.40",
    "room 0.40→0.45 +0.05",
    "applied 0.45→0.52 +0.07",
    "ready 0.52→1.38 +0.86",
    "files 1.38→2.90 +1.52",
    "go 2.90→3.38 +0.48",
    "model 3.38→7.45 +4.07",
  ]);
});

test("FOL-74: a cold search pod booting alongside the step pod is a parallel lane, and go waits for it", () => {
  // services lands after ready and files: the search pod was up at 8s, the
  // step pod's own phases ran from the start beside it, go was held 4s.
  const s = startupBreakdown({ services: 8, room: 0.1, applied: 0.5, ready: 3, files: 4, go: 8.1, shim: 8.2, model: 11 });
  assert.deepEqual(row(s), [
    "services 0.00→8.00 +8.00 ∥",
    "room 0.00→0.10 +0.10",
    "applied 0.10→0.50 +0.40",
    "ready 0.50→3.00 +2.50",
    "files 3.00→4.00 +1.00",
    "go 8.00→8.10 +0.10 waited 4.00",
    "shim 8.10→8.20 +0.10",
    "model 8.20→11.00 +2.80",
  ]);
  // no phase it overlapped reads +0.00s any more
  assert.ok(s.filter((x) => x.phase !== "services").every((x) => x.took > 0));
  // and the own shares of the pod's lane, the wait and go add up to go's mark
  const lane = s.filter((x) => !x.parallel && x.phase !== "go" && x.at <= 4).reduce((n, x) => n + x.took, 0);
  assert.ok(Math.abs(lane + 4 + 0.1 - 8.1) < 1e-9);
});

test("a services pod that came up while the step pod was still booting holds nothing back", () => {
  // up at 2s, before files: parallel, but go waits on files, not on it
  const s = startupBreakdown({ services: 2, room: 0.1, ready: 3, files: 4, go: 4.2 });
  assert.equal(s[0]!.parallel, true);
  const go = s.find((x) => x.phase === "go")!;
  assert.equal(go.waited, 0);
  assert.equal(go.from, 4);
  assert.ok(Math.abs(go.took - 0.2) < 1e-9);
});

test("missing, junk and out-of-order marks: skipped, never negative", () => {
  assert.deepEqual(startupBreakdown(null), []);
  assert.deepEqual(startupBreakdown(undefined), []);
  assert.deepEqual(startupBreakdown({}), []);
  const s = startupBreakdown({ ready: 1, go: Number.NaN, driver: "x", tools: 0.5, model: 3 } as Record<string, unknown>);
  assert.deepEqual(row(s), ["ready 0.00→1.00 +1.00", "tools 1.00→0.50 +0.00", "model 1.00→3.00 +2.00"]);
  // services alone, or with nothing in line after it, is just itself
  assert.deepEqual(row(startupBreakdown({ services: 2 })), ["services 0.00→2.00 +2.00"]);
});
