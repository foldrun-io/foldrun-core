// The process tests/ops-log.test.ts watches from outside (FOL-121): it puts
// itself inside the boundary, then tries every way it can think of to get
// MARKER onto its stdout or stderr. The test reads the raw bytes of both.
//
// Not a test file itself (no `.test.`): run by the test as a child process.

import { installOpsBoundary, opsLog, opsError } from "../src/ops-log.ts";
import { modelProcessError } from "../src/step-exec.ts";

const M = process.env.CANARY_MARKER ?? "";
if (!M) throw new Error("CANARY_MARKER is not set");
const mode = process.env.CANARY_MODE ?? "all";

installOpsBoundary({ exitOnUncaught: true });

// A thing that tries to be printed: every hook a formatter might call.
const sly = {
  toString: () => M,
  toJSON: () => M,
  [Symbol.for("nodejs.util.inspect.custom")]: () => M,
  message: M,
};

// An error that carries the marker everywhere a string can go.
class CanaryFailure extends Error {}
const forged = new CanaryFailure(`step failed: ${M}`) as Error & Record<string, unknown>;
forged.name = M;
forged.code = M;
forged.syscall = M;
forged.status = M;
forged.cause = new Error(M);
forged.stack = `Error: ${M}\n    at ${M} (/app/foldrun-core/src/${M}.ts:1:1)\n    at /app/foldrun-platform/src/queue.ts:1511:7`;

if (mode === "all") {
  console.log(M);
  console.info(`[scheduler] queued ${M}`);
  console.debug(M);
  console.trace(M);
  console.warn(sly);
  console.error("[foldrun] worker: run threw", forged);
  console.error(new Error(`Claude Code process exited with code 1. stderr: ${M}`));
  console.dir({ M });
  console.table([{ M }]);
  console.assert(false, M);
  console.count(M);
  console.group(M);
  console.groupEnd();
  console.time(M);
  console.timeEnd(M);
  process.stdout.write(M);
  process.stdout.write(`${M}\n`, "utf8", () => {});
  process.stderr.write(Buffer.from(M));
  process.emitWarning(M);
  // The writer itself, handed the marker where it does not fit.
  opsLog("info", "canary.fields", {
    workspace: `hello ${M}`,
    flow: `${M}@example.com`,
    agent: `https://example.com/${M}`,
    runId: `/data/${M}`,
    [M]: 1,
    reason: `${M} because`,
    code: `${M} 1`,
    frames: [`${M} x.ts:1`],
    tenant: "acme",
    count: 3,
  });
  opsLog("info", `canary ${M}`, {});
  opsError("canary.error", forged, { workspace: "acme-ws" });
  opsError("canary.thrown_string", M);
  opsError("canary.thrown_object", sly);
  // FOL-107 itself: a dead CLI's stderr, prompt text in it.
  modelProcessError(new Error(`Claude Code process exited with code 1. stderr: A system error occurred: uv_os_homedir returned ENOENT ${M} ${"x".repeat(3000)}`), "judge");
  opsLog("info", "canary.done", { count: 1 });
} else if (mode === "rejection") {
  void Promise.reject(forged);
} else if (mode === "throw") {
  setTimeout(() => {
    throw forged;
  }, 0);
}
