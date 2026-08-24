// The Kubernetes executor: the same step isolation as run-container.ts,
// spoken to a cluster instead of a docker daemon. Selected with
// MDAGENT_RUN_ISOLATION=k8s; this is what replaces the dind sidecar — pods
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
//   MDAGENT_RUNNER_IMAGE      required — the runner image, already in the
//                             cluster (k3d image import / a registry)
//   MDAGENT_K8S_NAMESPACE     default mdagent-runs
//   MDAGENT_KUBECTL           default kubectl (kubeconfig from the env)
//   MDAGENT_RUNNER_RUNTIME    a RuntimeClass name, e.g. gvisor

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  applyContainerChanges,
  parseDriverLine,
  type ContainerStepOutcome,
  type RunInContainerArgs,
} from "./run-container.ts";

const kubectl = () => process.env.MDAGENT_KUBECTL ?? "kubectl";
const namespace = () => process.env.MDAGENT_K8S_NAMESPACE ?? "mdagent-runs";

// The shim the pod runs. Stages: wait for files, take the env, hand the
// tree to the agent user, run the driver, then hold for the ack so the
// workspace can be copied out of a still-live container.
const SHIM = `while [ ! -f /opt/runner/job/go ]; do sleep 0.2; done
set -a; [ -f /opt/runner/job/env.sh ] && . /opt/runner/job/env.sh; set +a
chown -R agent:agent /workspace /library /opt/runner/job
runuser -u agent -- node /opt/runner/driver.mjs
touch /opt/runner/job/finished
i=0; while [ ! -f /opt/runner/job/ack ] && [ $i -lt 600 ]; do sleep 0.5; i=$((i+1)); done`;

/** The pod, as a manifest — pure, so tests can read it without a cluster. */
export function runPodManifest(name: string, image: string): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      labels: { app: "mdagent-run" },
    },
    spec: {
      restartPolicy: "Never",
      ...(process.env.MDAGENT_RUNNER_RUNTIME
        ? { runtimeClassName: process.env.MDAGENT_RUNNER_RUNTIME }
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
            limits: {
              memory: process.env.MDAGENT_RUNNER_MEMORY ?? "2Gi",
              cpu: process.env.MDAGENT_RUNNER_CPUS ?? "2",
            },
          },
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

function kc(args: string[], input?: string): { status: number | null; out: string } {
  const res = spawnSync(kubectl(), args, { encoding: "utf8", input });
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

export async function runStepInK8s(args: RunInContainerArgs): Promise<ContainerStepOutcome> {
  const image = process.env.MDAGENT_RUNNER_IMAGE;
  if (!image) {
    args.emit("error", "MDAGENT_RUN_ISOLATION=k8s needs MDAGENT_RUNNER_IMAGE (an image the cluster can pull)");
    return { status: "failed", result: null, costUsd: null };
  }

  const ns = namespace();
  kc(["create", "namespace", ns]); // idempotent-by-outcome; AlreadyExists is fine

  const name = `mdagent-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const podRef = `pod/${name}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mdagent-k8s-"));
  let created = false;

  try {
    // Stage exactly what the docker path stages.
    const wsIn = path.join(staging, "workspace");
    fs.cpSync(args.workspaceRoot, wsIn, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(args.workspaceRoot, src).replaceAll("\\", "/");
        return !(rel === "secrets.json" || rel === "runs" || rel.startsWith("runs/") || rel === ".mdagent" || rel.startsWith(".mdagent/"));
      },
    });
    const libIn = path.join(staging, "library");
    if (fs.existsSync(args.libraryRoot)) fs.cpSync(args.libraryRoot, libIn, { recursive: true });
    else fs.mkdirSync(libIn, { recursive: true });
    fs.writeFileSync(path.join(staging, "input.json"), JSON.stringify(args.input, null, 2));
    fs.writeFileSync(path.join(staging, "env.sh"), envFileShell(args.env), { mode: 0o600 });

    const applied = kc(["apply", "-f", "-"], JSON.stringify(runPodManifest(name, image)));
    if (applied.status !== 0) throw new Error(`pod create failed:\n${applied.out.slice(0, 800)}`);
    created = true;

    const ready = kc(["wait", "--for=condition=Ready", podRef, "-n", ns, "--timeout=180s"]);
    if (ready.status !== 0) throw new Error(`pod never became ready:\n${ready.out.slice(0, 800)}`);

    const cp = (from: string, to: string) => {
      const out = kc(["cp", from, to, "-n", ns]);
      if (out.status !== 0) throw new Error(`kubectl cp failed:\n${out.out.slice(0, 500)}`);
    };
    cp(`${wsIn}/.`, `${ns}/${name}:/workspace`);
    cp(`${libIn}/.`, `${ns}/${name}:/library`);
    cp(path.join(staging, "input.json"), `${ns}/${name}:/opt/runner/job/input.json`);
    cp(path.join(staging, "env.sh"), `${ns}/${name}:/opt/runner/job/env.sh`);
    kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/go"]);

    // The driver's stdout, streamed. `logs -f` ends only when the container
    // does, and the shim holds for the ack — so the `done` line, not the
    // stream's end, is the signal to move on.
    const outcome = await new Promise<ContainerStepOutcome>((resolve) => {
      const child = spawn(kubectl(), ["logs", "-f", name, "-n", ns], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let buffer = "";
      const backstopMs = ((args.input.timeoutSec ?? 15 * 60) + 120) * 1000;
      const finish = (value: ContainerStepOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        child.kill();
        resolve(value);
      };
      const backstop = setTimeout(() => {
        args.emit("error", `pod exceeded its ${Math.round(backstopMs / 1000)}s backstop — deleted`);
        kc(["delete", podRef, "-n", ns, "--wait=false"]);
        finish({ status: "failed", result: null, costUsd: null });
      }, backstopMs);

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const parsed = parseDriverLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (!parsed) continue;
          if (parsed.e === "event") args.emit(parsed.type, parsed.text);
          else return finish(parsed);
        }
      });
      child.on("close", () => {
        finish({ status: "failed", result: null, costUsd: null });
      });
      child.on("error", (err) => {
        args.emit("error", err.message);
        finish({ status: "failed", result: null, costUsd: null });
      });
    });

    // Copy out of the still-held pod, then release it.
    const wsOut = path.join(staging, "out");
    fs.mkdirSync(wsOut);
    const back = kc(["cp", `${ns}/${name}:/workspace/.`, wsOut]);
    if (back.status === 0) {
      applyContainerChanges(args.workspaceRoot, wsOut);
    } else {
      args.emit("error", `copy-out failed — the step's file changes were lost:\n${back.out.slice(0, 500)}`);
    }
    kc(["exec", "-n", ns, name, "--", "touch", "/opt/runner/job/ack"]);

    return outcome;
  } finally {
    if (created) kc(["delete", podRef, "-n", ns, "--wait=false"]);
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
