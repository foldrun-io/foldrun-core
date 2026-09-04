// The k8s executor against a real cluster: pod created, files copied in,
// driver streamed, workspace copied back out of the held pod, pod deleted.
// No model call — the credential wall is where it should fail, proving
// everything on this side of it.
//
// Opt-in, run where kubectl reaches a cluster that has the runner image:
//
//   FOLDRUN_K8S_E2E=1 FOLDRUN_RUNNER_IMAGE=foldrun-runner:<tag> \
//     node --test tests/k8s-e2e.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runStepInK8s } from "../packages/core/src/run-k8s.ts";

const enabled = process.env.FOLDRUN_K8S_E2E === "1";

/**
 * The runner image to launch, asked of the cluster when nobody said.
 *
 * Requiring it by hand is how this test stayed unrun: the tag changes every
 * deploy, so the only correct value is whatever the worker is configured with
 * right now — which the cluster already knows. Falling back to asking it
 * turns `npm run k8s` into something that works with no arguments.
 */
function runnerImage(): string | null {
  if (process.env.FOLDRUN_RUNNER_IMAGE) return process.env.FOLDRUN_RUNNER_IMAGE;
  const kubectl = process.env.FOLDRUN_KUBECTL ?? "kubectl";
  const got = spawnSync(
    kubectl,
    ["-n", "foldrun", "get", "deploy", "foldrun-worker", "-o",
     'jsonpath={.spec.template.spec.containers[0].env[?(@.name=="FOLDRUN_RUNNER_IMAGE")].value}'],
    { encoding: "utf8" },
  );
  const tag = (got.stdout ?? "").trim();
  return got.status === 0 && tag ? tag : null;
}

const image = enabled ? runnerImage() : null;
if (image) process.env.FOLDRUN_RUNNER_IMAGE = image;
const opts = {
  skip: enabled
    ? image
      ? false
      : "set FOLDRUN_RUNNER_IMAGE — no foldrun-worker deployment to ask"
    : "set FOLDRUN_K8S_E2E=1 to run (needs kubectl + a cluster)",
};

test("a step runs as a pod, and the pod is gone afterwards", opts, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-k8s-e2e-"));
  fs.mkdirSync(path.join(ws, "agents/writer"), { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
  fs.writeFileSync(
    path.join(ws, "agents/writer/agent.md"),
    "---\nname: writer\ndescription: writes\n---\n\nWrite.\n",
  );

  const events: { type: string; text: string }[] = [];
  // Which run pods exist BEFORE this test. The assertion below used to be
  // "the namespace is empty", which is only true on an idle cluster — run it
  // on the box while a scheduled flow is working and it failed, blaming the
  // executor for somebody else's pod. What this test can honestly claim is
  // that IT left nothing behind.
  const runPods = () => {
    const ns = process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";
    const got = spawnSync(process.env.FOLDRUN_KUBECTL ?? "kubectl",
      ["get", "pods", "-n", ns, "-l", "app=foldrun-run", "--no-headers"], { encoding: "utf8" });
    return (got.stdout ?? "")
      .split("\n")
      .filter((l) => l.trim() && !l.includes("Terminating"))
      .map((l) => l.split(/\s+/)[0]);
  };
  const before = new Set(runPods());
  try {
    const outcome = await runStepInK8s({
      workspaceRoot: ws,
      libraryRoot: path.join(ws, "..", "no-library"),
      input: {
        agentRel: "agents/writer",
        prompt: "Say hello.",
        model: "haiku",
        systemPrompt: "You write one short sentence.",
        allowed: ["Read", "Write"],
        mcpNames: [],
        mcpServers: {},
        apis: [],
        scripts: [],
        runtime: null,
        consults: [],
        timeoutSec: 180,
      },
      env: { FOLDRUN_E2E_MARKER: "it's got 'quotes' to survive" },
      emit: (type, text) => events.push({ type, text }),
    });

    // No credentials in the cluster → the loop fails, as streamed protocol.
    assert.equal(outcome.status, "failed", JSON.stringify(events.slice(-3)));
    assert.ok(events.length > 0, "the failure arrived as streamed events");

    // Nothing left behind — by this test. A pod that was already running when
    // it started belongs to somebody else and is not evidence of a leak.
    const leaked = runPods().filter((name) => !before.has(name));
    assert.deepEqual(leaked, [], `pods left behind: ${leaked.join(", ")}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
