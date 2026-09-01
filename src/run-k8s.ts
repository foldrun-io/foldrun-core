// The Kubernetes executor: the same step isolation as run-container.ts,
// spoken to a cluster instead of a docker daemon. Selected with
// FOLDRUN_RUN_ISOLATION=k8s; this is what replaces the dind sidecar — pods
// scheduled by the cluster, gVisor via runtimeClassName, egress policy via
// NetworkPolicy on the run namespace.
//
// Same protocol, same driver, same image, same copy-out filter. What
// differs is plumbing: a pod cannot be created stopped the way a container
// can, so the pod starts as a shim that waits for a `go` marker; the files
// are copied in while it idles, the marker released, the driver's JSONL
// read from `kubectl logs -f`, and the pod holds after finishing until the
// host acknowledges the copy-out — a terminated pod cannot be copied from.
//
//   FOLDRUN_RUNNER_IMAGE      required — the runner image, already in the
//                             cluster (k3d image import / a registry)
//   FOLDRUN_K8S_NAMESPACE     default foldrun-runs
//   FOLDRUN_KUBECTL           default kubectl (kubeconfig from the env)
//   FOLDRUN_RUNNER_RUNTIME    a RuntimeClass name, e.g. gvisor

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  applyContainerChanges,
  parseDriverLine,
  timingLine,
  sizeLimits,
  RUN_LABEL,
  RUNTIME_CACHE,
  type ContainerStepOutcome,
  type RunInContainerArgs,
  type StepTiming,
} from "./run-container.ts";
import { safeTenantSegment } from "./runtime.ts";
import { isPlatformPath } from "./store.ts";

const kubectl = () => process.env.FOLDRUN_KUBECTL ?? "kubectl";
const namespace = () => process.env.FOLDRUN_K8S_NAMESPACE ?? "foldrun-runs";
/**
 * The claim backing the dependency cache, in the *run* namespace — PVCs are
 * namespaced, so the platform's own foldrun-data claim is not reachable from
 * here even though it is on the same disk. Unset means no cache: every step
 * installs fresh, which is exactly the behaviour that shipped before this.
 * That default matters, because a name pointing at a claim that does not
 * exist leaves every run pod Pending, and a slow platform beats a stopped one.
 */
const cachePvc = () => process.env.FOLDRUN_RUNTIME_CACHE_PVC ?? "";

// The shim the pod runs. Stages: wait for files, take the env, hand the
// tree to the agent user, run the driver, then hold for the ack so the
// workspace can be copied out of a still-live container.
// The wait for `go` is bounded (10 minutes): if the platform dies between
// creating the pod and writing the marker, the shim exits instead of holding
// its reservation forever — the one orphan a step deadline used to reap, now
// that a step with no \`timeout:\` carries none.
const SHIM = `i=0; while [ ! -f /opt/runner/job/go ] && [ $i -lt 3000 ]; do sleep 0.2; i=$((i+1)); done
[ -f /opt/runner/job/go ] || { echo "no go marker after 10 minutes — platform gone, exiting" >&2; exit 1; }
set -a; [ -f /opt/runner/job/env.sh ] && . /opt/runner/job/env.sh; set +a
chown -R agent:agent /workspace /library /opt/runner/job
chown agent:agent ${RUNTIME_CACHE} 2>/dev/null || true
runuser -u agent -- node /opt/runner/driver.mjs
touch /opt/runner/job/finished
i=0; while [ ! -f /opt/runner/job/ack ] && [ $i -lt 600 ]; do sleep 0.5; i=$((i+1)); done`;

/**
 * Delete any run pod still alive for this run. Best effort, and by label
 * rather than name: the pod's name is random, and the run id is the only
 * thing a person stopping a run actually knows.
 */
export function killRunPods(runId: string): number {
  const ns = namespace();
  const got = kcSync(["get", "pods", "-n", ns, "-l", `${RUN_LABEL}=${runId}`, "-o", "name"]);
  const list = (got.out ?? "").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("pod/"));
  if (list.length) kcSync(["delete", ...list, "-n", ns, "--wait=false"]);
  return list.length;
}

/**
 * Delete run pods that have finished and been left behind.
 *
 * The normal path deletes a pod in runStepInK8s's `finally`. That handle is
 * lost whenever the platform process goes away mid-step — which, with a
 * single replica on a Recreate strategy, is every deploy. Measured on the
 * production box 2026-08-28: seven terminated pods still present, the oldest
 * two and a half days old, one of them the DeadlineExceeded the cluster
 * reaped precisely because nobody was left to reap it.
 *
 * Terminated pods hold no CPU or memory, so this is not urgent — but they
 * hold names, IPs and an etcd record each, and nothing else in the system
 * ever removes them. Pods have no `ttlSecondsAfterFinished` (that is a Job
 * field), so the sweep has to be ours.
 */
export async function sweepFinishedRunPods(olderThanMs = 10 * 60_000): Promise<number> {
  if (process.env.FOLDRUN_RUN_ISOLATION !== "k8s") return 0;
  const ns = namespace();
  const got = await kc([
    "get", "pods", "-n", ns, "-l", "app=foldrun-run",
    "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.phase} {.metadata.creationTimestamp}{\"\\n\"}{end}",
  ]);
  if (got.status !== 0) return 0;

  const stale: string[] = [];
  for (const line of got.out.split("\n")) {
    const [name, phase, created] = line.trim().split(/\s+/);
    if (!name || (phase !== "Succeeded" && phase !== "Failed")) continue;
    // Age-gated, because a pod that has just written its `done` line is still
    // being copied out of by a live step — deleting that races the copy-out
    // and loses the run's file changes.
    const age = Date.now() - new Date(created).getTime();
    if (Number.isFinite(age) && age > olderThanMs) stale.push(`pod/${name}`);
  }
  if (!stale.length) return 0;
  await kc(["delete", ...stale, "-n", ns, "--wait=false"]);
  return stale.length;
}

/** The pod, as a manifest — pure, so tests can read it without a cluster. */
export function runPodManifest(
  name: string,
  image: string,
  runId?: string,
  size?: "small" | "large" | "heavy",
  deadlineSec?: number,
  tenant?: string,
): object {
  // The dependency cache: one claim, one sub-directory per tenant. subPath is
  // what keeps tenants apart — the pod sees only its own sub-tree, so a step
  // cannot read, let alone poison, the venvs another account's steps execute.
  // kubelet creates the sub-directory on first use, so nothing has to
  // pre-provision it. No claim configured, or a tenant name that is not a safe
  // single segment, and the pod simply gets no volume.
  const claim = cachePvc();
  const seg = tenant ? safeTenantSegment(tenant) : null;
  const cache = claim && seg ? { claim, seg } : null;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      labels: { app: "foldrun-run", ...(runId ? { [RUN_LABEL]: runId } : {}) },
    },
    spec: {
      restartPolicy: "Never",
      // A k8s-native backstop that does not depend on the platform staying
      // alive. The in-process watch below also deletes an overrunning pod, but
      // if the platform restarts mid-run it loses that handle and the shim can
      // spin forever waiting for a `go` marker that will never be written —
      // which is how run pods were seen Running for 40+ minutes, holding their
      // memory reservation. activeDeadlineSeconds lets the cluster reap them.
      // Only when the step set a timeout: the platform has no opinion of its
      // own about how long real work takes — a step with no `timeout:` runs
      // until it finishes, and stopping it is what the stop button is for.
      ...(deadlineSec ? { activeDeadlineSeconds: deadlineSec } : {}),
      ...(process.env.FOLDRUN_RUNNER_RUNTIME
        ? { runtimeClassName: process.env.FOLDRUN_RUNNER_RUNTIME }
        : {}),
      ...(cache
        ? {
            volumes: [
              { name: "runtime-cache", persistentVolumeClaim: { claimName: cache.claim } },
            ],
          }
        : {}),
      containers: [
        {
          name: "runner",
          image,
          imagePullPolicy: "IfNotPresent",
          command: ["sh", "-c", SHIM],
          securityContext: {
            // Root for the chown-and-drop; runuser sheds everything before
            // any model-directed code runs. Two capabilities more than the
            // docker flags — DAC_OVERRIDE and FOWNER — because kubectl cp
            // is an exec of tar *inside* the pod (docker cp is daemon-side),
            // and capless root can neither write into the agent-owned trees
            // nor chmod what it lands there.
            runAsUser: 0,
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"], add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
          resources: {
            // No CPU ceiling: CPU is compressible, so a step that can use more
            // cores finishes sooner and bills for what the tier prices, rather
            // than being throttled while cores sit idle. The request is a token
            // scheduling hint (the reservation that decides packing), kept small
            // so many steps share the node; the real price comes from the tier.
            // Memory IS a hard limit: it is not compressible, and without a cap
            // one runaway step OOMs the whole box, which on a single-node
            // install is every tenant's runs and the control plane at once.
            requests: { cpu: "100m" },
            limits: {
              memory: sizeLimits(size).memory,
            },
          },
          ...(cache
            ? {
                volumeMounts: [
                  { name: "runtime-cache", mountPath: RUNTIME_CACHE, subPath: cache.seg },
                ],
              }
            : {}),
        },
      ],
    },
  };
}

/** Shell-safe `export`s — the shim sources this, so quoting is load-bearing. */
export function envFileShell(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", `'\\''`)}'`)
    .join("\n");
}

function kcSync(args: string[], input?: string): { status: number | null; out: string } {
  const res = spawnSync(kubectl(), args, { encoding: "utf8", input });
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/**
 * kubectl, off the event loop. These calls run inside the PLATFORM process,
 * and spawnSync here froze everything the process serves: `wait
 * --for=condition=Ready --timeout=180s` held the loop for up to three
 * minutes per step, three parallel steps interleaved their holds, and the
 * readiness probe, every API request and the scheduler starved together —
 * a whole install unresponsive because one flow had a parallel group.
 */
function kc(args: string[], input?: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(kubectl(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err) => resolve({ status: null, out: String(err) }));
    child.on("close", (status) => resolve({ status, out }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runStepInK8s(args: RunInContainerArgs): Promise<ContainerStepOutcome> {
  const image = process.env.FOLDRUN_RUNNER_IMAGE;
  if (!image) {
    args.emit("error", "FOLDRUN_RUN_ISOLATION=k8s needs FOLDRUN_RUNNER_IMAGE (an image the cluster can pull)");
    return { status: "failed", result: null, costUsd: null };
  }

  const ns = namespace();
  await kc(["create", "namespace", ns]); // idempotent-by-outcome; AlreadyExists is fine

  const name = `foldrun-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const podRef = `pod/${name}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-k8s-"));
  let created = false;

  try {
    // Stage exactly what the docker path stages — same single definition of
    // platform-owned, so the two executors cannot drift.
    const wsIn = path.join(staging, "workspace");
    fs.cpSync(args.workspaceRoot, wsIn, {
      recursive: true,
      filter: (src) => !isPlatformPath(path.relative(args.workspaceRoot, src)),
    });
    const libIn = path.join(staging, "library");
    if (fs.existsSync(args.libraryRoot)) fs.cpSync(args.libraryRoot, libIn, { recursive: true });
    else fs.mkdirSync(libIn, { recursive: true });
    fs.writeFileSync(path.join(staging, "input.json"), JSON.stringify(args.input, null, 2));
    fs.writeFileSync(path.join(staging, "env.sh"), envFileShell(args.env), { mode: 0o600 });

    // The rent clock starts at apply. Everything before it — copying the
    // workspace into staging — is host work on a machine that is already
    // paid for; the pod is the thing that scales to zero and therefore the
    // thing that costs when it doesn't.
    const t0 = Date.now();
    // The pod's own deadline mirrors the in-process backstop (below), plus a
    // small margin so the watch loop is normally the one to act — the pod
    // deadline is the fallback for when the platform is not there to.
    const deadlineSec = args.input.timeoutSec ? args.input.timeoutSec + 180 : undefined;
    const applied = await kc([
      "apply", "-f", "-",
    ], JSON.stringify(runPodManifest(name, image, args.runId, args.size, deadlineSec, args.tenant)));
    if (applied.status !== 0) throw new Error(`pod create failed:\n${applied.out.slice(0, 800)}`);
    created = true;

    const ready = await kc(["wait", "--for=condition=Ready", podRef, "-n", ns, "--timeout=180s"]);
    if (ready.status !== 0) throw new Error(`pod never became ready:\n${ready.out.slice(0, 800)}`);
    // Scheduling + image + gVisor sandbox boot. This is the cold-start
    // number: the one that decides whether a human can wait on a run.
    const sandboxMs = Date.now() - t0;

    const cp = async (from: string, to: string) => {
      const out = await kc(["cp", from, to, "-n", ns]);
      if (out.status !== 0) throw new Error(`kubectl cp failed:\n${out.out.slice(0, 500)}`);
    };
    await cp(`${wsIn}/.`, `${ns}/${name}:/workspace`);
    await cp(`${libIn}/.`, `${ns}/${name}:/library`);
    await cp(path.join(staging, "input.json"), `${ns}/${name}:/opt/runner/job/input.json`);
    await cp(path.join(staging, "env.sh"), `${ns}/${name}:/opt/runner/job/env.sh`);
    await kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/go"]);

    // The driver's stdout, streamed. `logs -f` ends only when the container
    // does, and the shim holds for the ack — so the `done` line, not the
    // stream's end, is the signal to move on.
    let firstOutputAt: number | null = null;
    const outcome = await new Promise<ContainerStepOutcome>((resolve) => {
      let settled = false;
      let reattaches = 0;
      let child: ReturnType<typeof spawn> | null = null;
      const MAX_REATTACH = 5;
      // No `timeout:` on the step means no backstop: the step runs until it
      // finishes. There used to be a silent 15-minute default here, and it
      // killed an enricher that was doing exactly what it was asked.
      const backstopMs = args.input.timeoutSec ? (args.input.timeoutSec + 120) * 1000 : null;
      const finish = (value: ContainerStepOutcome) => {
        if (settled) return;
        settled = true;
        if (backstop) clearTimeout(backstop);
        child?.kill();
        resolve(value);
      };
      // Fail the step, but do NOT delete the pod here: the copy-out below
      // needs it alive, and the finally deletes it right after. Deleting
      // first lost every file the step had written — an enricher killed at
      // 17 minutes left nothing, not even the rows it had finished. The
      // pod's own activeDeadlineSeconds sits 60s past this backstop, which
      // is the window the copy-out gets.
      const backstop = backstopMs
        ? setTimeout(() => {
            args.emit("error", `pod exceeded its ${Math.round(backstopMs / 1000)}s backstop — stopping; copying its files out first`);
            finish({ status: "failed", result: null, costUsd: null });
          }, backstopMs)
        : null;

      /** One parsed line. Returns true when it was the terminal one. */
      const handle = (raw: string): boolean => {
        const parsed = parseDriverLine(raw);
        if (!parsed) return false;
        firstOutputAt ??= Date.now();
        if (parsed.e === "event") {
          args.emit(parsed.type, parsed.text);
          return false;
        }
        finish(parsed);
        return true;
      };

      // `skip` is how many lines an earlier attach already handled: a re-read
      // starts at the beginning of the log, and replaying events would print
      // a step's output twice.
      const attach = (skip: number) => {
        let buffer = "";
        let seen = 0;
        const c = spawn(kubectl(), ["logs", "-f", name, "-n", ns], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = c;
        c.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          for (;;) {
            const nl = buffer.indexOf("\n");
            if (nl < 0) break;
            const raw = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            seen += 1;
            if (seen <= skip) continue;
            if (handle(raw)) return;
          }
        });
        c.on("close", () => void recover(seen));
        c.on("error", (err) => {
          args.emit("error", err.message);
          void recover(seen);
        });
      };

      // The stream ended without a terminal line. That has two very different
      // causes and they used to be treated as one: the container genuinely
      // stopped, or the connection dropped while the step was still thinking.
      // A `logs -f` held open across a quiet model call is exactly what an
      // idle-connection timeout kills, and failing the step for it fails work
      // that was fine. The pod's shim holds it open for the ack, so the log is
      // still readable — re-read it and let its contents decide.
      const recover = async (consumed: number) => {
        if (settled) return;
        let seen = consumed;
        const full = await kc(["logs", name, "-n", ns]);
        if (settled) return;
        if (full.status === 0) {
          const lines = full.out.split("\n");
          for (let i = seen; i < lines.length; i += 1) {
            if (handle(lines[i])) return;
          }
          seen = Math.max(seen, lines.length);
        }
        const phase = await kc(["get", "pod", name, "-n", ns, "-o", "jsonpath={.status.phase}"]);
        if (settled) return;
        const alive = phase.status === 0 && (phase.out === "Running" || phase.out === "Pending");
        if (alive && reattaches < MAX_REATTACH) {
          reattaches += 1;
          args.emit("info", `log stream dropped, pod still running — reattaching (${reattaches}/${MAX_REATTACH})`);
          attach(seen);
          return;
        }
        finish({ status: "failed", result: null, costUsd: null });
      };

      attach(0);
    });

    // Copy out of the still-held pod, then release it.
    const wsOut = path.join(staging, "out");
    fs.mkdirSync(wsOut);
    const back = await kc(["cp", `${ns}/${name}:/workspace/.`, wsOut]);
    if (back.status === 0) {
      applyContainerChanges(args.workspaceRoot, wsOut);
    } else {
      args.emit("error", `copy-out failed — the step's file changes were lost:\n${back.out.slice(0, 500)}`);
    }
    await kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/ack"]);

    // After the ack: the pod is held live for the copy-out, so the copy-out
    // is rented time like everything else.
    const timing: StepTiming = {
      sandboxMs,
      firstOutputMs: firstOutputAt === null ? null : firstOutputAt - t0 - sandboxMs,
      totalMs: Date.now() - t0,
    };
    args.emit("info", timingLine(timing));
    return { ...outcome, timing };
  } finally {
    if (created) await kc(["delete", podRef, "-n", ns, "--wait=false"]);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
