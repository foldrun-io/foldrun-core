// Where the hosted platform plugs in.
//
// @foldrun/core is the framework: the format, the runner, the checks. The
// platform — a queue with a worker behind it, per-account encryption keys in
// Postgres, pods on a cluster, public share links, branch previews — is a
// separate, private package. It does not fork core; it registers here.
//
// Every hook has a local default that is right for a laptop or a
// self-hosted single box: a flow run that would be queued runs now, a step
// that would be a pod is a container, a vault with no account key uses the
// install key. Core never imports the platform; the platform imports core
// and calls registerPlatform() once at boot. A process that forgets to is a
// local install — which is exactly the failure that is safe.

import type { FlowStep, RunRecord } from "./store.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "./run-container.ts";

export type IsolatedStepRunner = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

export interface PlatformHooks {
  /** Put a flow run where a worker will pick it up. Default: start it here, now. */
  enqueueFlowRun(
    tenant: string,
    workspace: string,
    steps: FlowStep[],
    flowName: string,
    modelOverride?: string | null,
    tags?: string[],
  ): Promise<RunRecord>;
  /** A parked run was approved and has no driver; line it up. Default: nothing —
   *  locally the starter that parked it is still polling the record. */
  enqueueResume(tenant: string, workspace: string, runId: string): Promise<void>;
  /** Step executors by FOLDRUN_RUN_ISOLATION value, beyond the `container`
   *  one core ships. The platform adds `k8s`. */
  isolation: Record<string, IsolatedStepRunner>;
  /** Destroy whatever sandboxes a stopped run still has. Default: nothing to destroy. */
  killRunSandboxes(runId: string): void;
  /** Publish storage/public/ as share links after a run. Default: no links. */
  syncPublicShares(tenant: string, workspace: string): { added: string[] };
  /** The workspace a preview was branched from, for inherited secrets. Default: none. */
  previewSourceOf(tenant: string, workspace: string): string | null;
  /** This account's own data key, or null to use the install key. */
  tenantKey(tenant: string): Buffer | null;
}

const local: PlatformHooks = {
  async enqueueFlowRun(tenant, workspace, steps, flowName, modelOverride, tags = []) {
    // Imported here, not at the top: runner.ts imports this file.
    const { startFlowRun } = await import("./runner.ts");
    return startFlowRun(tenant, workspace, steps, flowName, modelOverride ?? null, tags);
  },
  async enqueueResume() {},
  isolation: {},
  killRunSandboxes() {},
  syncPublicShares: () => ({ added: [] }),
  previewSourceOf: () => null,
  tenantKey: () => null,
};

// One object per PROCESS, not per module instance. A bundler that compiles
// the boot file and each route handler separately (Next does) gives every
// bundle its own copy of this module; registerPlatform() in the boot bundle
// then filled one copy while the approval route read another, still on the
// local defaults — and enqueueResume was a no-op there. An approved run sat
// parked until the worker's periodic reconcile happened to find it, minutes
// later, with an empty queue and nothing in any log. globalThis is the one
// thing every bundle in a process shares.
const KEY = Symbol.for("foldrun.platform");
const g = globalThis as unknown as Record<symbol, PlatformHooks | undefined>;
export const platform: PlatformHooks = (g[KEY] ??= { ...local });

/** Install the platform's implementations. Partial: what is not given keeps its local default. */
export function registerPlatform(hooks: Partial<PlatformHooks>): void {
  Object.assign(platform, hooks, {
    isolation: { ...platform.isolation, ...(hooks.isolation ?? {}) },
  });
}

/** Back to the local defaults — for tests that register and must not leak. */
export function resetPlatform(): void {
  Object.assign(platform, local, { isolation: {} });
}
