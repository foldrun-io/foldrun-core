// The k8s executor's pure parts: the pod it would create, and the env file
// the shim will source. The cluster-shaped rest lives in tests/k8s-e2e.test.ts.
//
//   node --test tests/run-k8s.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { runPodManifest, envFileShell } from "../packages/core/src/run-k8s.ts";
import { k8sMemory } from "../packages/core/src/run-container.ts";

test("the pod carries the same hardening as the docker flags", () => {
  const pod = runPodManifest("foldrun-run-x", "foldrun-runner:abc") as {
    metadata: { labels: Record<string, string>; namespace: string };
    spec: {
      restartPolicy: string;
      runtimeClassName?: string;
      containers: {
        securityContext: {
          runAsUser: number;
          allowPrivilegeEscalation: boolean;
          capabilities: { drop: string[]; add: string[] };
        };
      }[];
    };
  };
  assert.equal(pod.spec.restartPolicy, "Never");
  assert.equal(pod.metadata.labels.app, "foldrun-run", "the NetworkPolicy selector");
  const sc = pod.spec.containers[0].securityContext;
  assert.deepEqual(sc.capabilities.drop, ["ALL"]);
  // DAC_OVERRIDE and FOWNER are the extras over the docker flags — kubectl cp execs
  // tar inside the pod, where capless root cannot write agent-owned trees.
  assert.deepEqual(sc.capabilities.add, ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]);
  assert.equal(sc.allowPrivilegeEscalation, false);
});

test("a RuntimeClass rides in from the same env var docker uses", () => {
  const previous = process.env.FOLDRUN_RUNNER_RUNTIME;
  process.env.FOLDRUN_RUNNER_RUNTIME = "gvisor";
  try {
    const pod = runPodManifest("x", "img") as { spec: { runtimeClassName?: string } };
    assert.equal(pod.spec.runtimeClassName, "gvisor");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_RUNNER_RUNTIME;
    else process.env.FOLDRUN_RUNNER_RUNTIME = previous;
  }
});

test("the env file survives shell metacharacters — quoting is load-bearing", () => {
  const file = envFileShell({
    PLAIN: "value",
    SPACED: "two words",
    QUOTED: "it's got 'quotes' and $HOME and `backticks`",
    "bad-name": "dropped, not exported",
  });
  assert.match(file, /^export PLAIN='value'$/m);
  assert.match(file, /^export SPACED='two words'$/m);
  assert.ok(!file.includes("bad-name"));
  // The single-quote escape: 'it'\''s ...' — the dangerous characters stay
  // inert inside single quotes, and embedded quotes hop out and back in.
  assert.ok(file.includes(`'it'\\''s got '\\''quotes'\\'' and $HOME and \`backticks\`'`));
});

test("a pod caps memory per class but never caps CPU", () => {
  process.env.FOLDRUN_RUNNER_MEMORY = "6Gi";
  process.env.FOLDRUN_RUNNER_CPUS = "3";
  try {
    type Manifest = {
      spec: {
        containers: {
          resources: { requests?: { cpu?: string }; limits: { memory: string; cpu?: string } }[];
        }[];
      };
    };
    const res = (m: Manifest) => m.spec.containers[0].resources;

    const large = runPodManifest("p1", "img", "run-x") as Manifest;
    // Memory is a hard ceiling; CPU is deliberately absent from limits so the
    // pod bursts uncapped. A CPU limit reappearing here is the regression this
    // guards: it silently throttles work the customer is paying for.
    assert.deepEqual(res(large).limits, { memory: "6Gi" });
    assert.equal(res(large).limits.cpu, undefined);
    // A small CPU request remains, as a scheduling hint only.
    assert.equal(res(large).requests?.cpu, "100m");

    const small = runPodManifest("p2", "img", "run-x", "small") as Manifest;
    assert.deepEqual(res(small).limits, { memory: "1Gi" });

    const heavy = runPodManifest("p3", "img", "run-x", "heavy") as Manifest;
    assert.deepEqual(res(heavy).limits, { memory: "8Gi" });

    // A pod carries a k8s-native deadline only when the step set a
    // `timeout:` — the platform has no default of its own, so a step that
    // names no limit runs until it finishes. Orphans (platform restarted
    // mid-run, shim spinning on a `go` that never comes) are reaped by boot
    // recovery killing the run's pods, not by a clock nobody chose.
    type WithDeadline = { spec: { activeDeadlineSeconds?: number } };
    assert.equal((large as unknown as WithDeadline).spec.activeDeadlineSeconds, undefined, "no timeout, no deadline");
    const custom = runPodManifest("p4", "img", "run-x", "large", 900) as unknown as WithDeadline;
    assert.equal(custom.spec.activeDeadlineSeconds, 900);
  } finally {
    delete process.env.FOLDRUN_RUNNER_MEMORY;
    delete process.env.FOLDRUN_RUNNER_CPUS;
  }
});

// ---------- the dependency cache ----------
//
// The volume that turns the runner's runtime cache from "rebuilt every step"
// into "built once per account". Two properties matter more than the mount
// itself: it is absent unless configured (a claim name pointing at nothing
// leaves every run pod Pending, which is worse than a slow one), and the
// subPath that separates tenants can never be talked into leaving its parent.

function withCachePvc<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  if (value === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
  else process.env.FOLDRUN_RUNTIME_CACHE_PVC = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_RUNTIME_CACHE_PVC;
    else process.env.FOLDRUN_RUNTIME_CACHE_PVC = previous;
  }
}

type Pod = {
  spec: {
    volumes?: { name: string; persistentVolumeClaim: { claimName: string } }[];
    containers: {
      volumeMounts?: { name: string; mountPath: string; subPath: string }[];
    }[];
  };
};

test("no claim configured, no volume — the pod is exactly what it was before", () => {
  withCachePvc(undefined, () => {
    const pod = runPodManifest("x", "img", "run1", "small", 600, "acct-1") as Pod;
    assert.equal(pod.spec.volumes, undefined);
    assert.equal(pod.spec.containers[0].volumeMounts, undefined);
  });
});

test("with a claim, the tenant's cache mounts by subPath", () => {
  withCachePvc("foldrun-runtimes", () => {
    const pod = runPodManifest("x", "img", "run1", "small", 600, "acct-1") as Pod;
    assert.deepEqual(pod.spec.volumes, [
      { name: "runtime-cache", persistentVolumeClaim: { claimName: "foldrun-runtimes" } },
    ]);
    const mount = pod.spec.containers[0].volumeMounts?.[0];
    assert.equal(mount?.subPath, "acct-1", "one sub-directory per account, not a shared root");
    // The path is load-bearing, not cosmetic: a venv writes its own absolute
    // path into every shebang, so a cache mounted anywhere else is a cache of
    // broken interpreters. It must equal what the driver's FOLDRUN_DATA and
    // the in-container tenant name produce.
    assert.equal(mount?.mountPath, "/home/agent/.foldrun/runner/.runtimes");
  });
});

test("a tenant name that is not one safe segment gets no volume at all", () => {
  withCachePvc("foldrun-runtimes", () => {
    for (const bad of ["../other", "a/b", "..", ".", "", "  "]) {
      const pod = runPodManifest("x", "img", "run1", "small", 600, bad) as Pod;
      assert.equal(pod.spec.volumes, undefined, `${JSON.stringify(bad)} must not mount`);
    }
  });
});

test("no tenant (an embedder with no tenancy) simply gets no cache", () => {
  withCachePvc("foldrun-runtimes", () => {
    const pod = runPodManifest("x", "img") as Pod;
    assert.equal(pod.spec.volumes, undefined);
  });
});

test("a Docker memory figure becomes one Kubernetes accepts", () => {
  // sizeLimits speaks Docker — `--memory 2g` — and its default is exactly
  // that. Kubernetes rejects the lowercase form with a message naming neither
  // the field nor the value, so every default-size step failed to create a pod
  // on any install that had not overridden FOLDRUN_RUNNER_MEMORY. These
  // manifests do, which is why it broke only for self-hosters.
  assert.equal(k8sMemory("2g"), "2Gi", "the default size, and the bug");
  assert.equal(k8sMemory("512m"), "512Mi", "docker's m is mebibytes, not millibytes");
  // `k` is a legal Kubernetes decimal suffix and Docker's kibibytes; case
  // decides, and everything here comes from sizeLimits, which speaks Docker.
  assert.equal(k8sMemory("1024k"), "1024Ki");
  assert.equal(k8sMemory("2t"), "2Ti");
  assert.equal(k8sMemory("2048b"), "2048");
  // Already a quantity: untouched, including what production actually sets.
  for (const q of ["6Gi", "8Gi", "1Gi", "500M", "2G", "1024"]) assert.equal(k8sMemory(q), q);
  // Anything else is handed over so the cluster's own error is the one read.
  assert.equal(k8sMemory("lots"), "lots");
});
