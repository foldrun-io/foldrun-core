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

import type { FlowInfo, FlowStep, RunRecord } from "./store.ts";
import type { RunInContainerArgs, ContainerStepOutcome } from "./run-container.ts";
import type { EgressHooks } from "./egress.ts";

export type IsolatedStepRunner = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

/** Who this install is for. `hosted` means someone is paying the operator
 *  for it — a wallet, a plan, a bill. `self-hosted` is everything else: a
 *  laptop, a company's own box, the open-source download. */
export type Edition = "self-hosted" | "hosted";

/** What a trigger gate decided. `admit: false` is never an error: the
 *  trigger was received and understood, and the flow's own file says this
 *  one does not become a run. `detail` is what the sender and the log are
 *  told, because a silent drop reads exactly like a broken hook. */
export type TriggerAdmission =
  | { admit: true }
  | { admit: false; reason: "duplicate" | "throttled" | "quarantined" | "debounced"; detail: string; firesAt?: number };

export interface PlatformHooks {
  /** Is this a hosted install? The ONE question every commercial surface —
   *  the wallet, top-ups, plan limits, whatever is added next that assumes
   *  a customer — asks before it renders or answers. Default: self-hosted,
   *  which is what a process that never registered a platform is, and what
   *  the open-source image is unless its operator configures billing. One
   *  predicate, one place, so "does the community build show X" is a test
   *  and not an audit. */
  edition(): Edition;
  /** Put a flow run where a worker will pick it up. Default: start it here, now. */
  enqueueFlowRun(
    tenant: string,
    workspace: string,
    steps: FlowStep[],
    flowName: string,
    modelOverride?: string | null,
    tags?: string[],
    /** The person who asked, when one did — their email. A schedule, a
     *  webhook and a chained flow leave it unset, which is what makes
     *  "nobody approves their own run" a rule the record can enforce. */
    startedBy?: string | null,
  ): Promise<RunRecord>;
  /** A parked run was approved and has no driver; line it up. Default: nothing —
   *  locally the starter that parked it is still polling the record. */
  enqueueResume(tenant: string, workspace: string, runId: string): Promise<void>;
  /**
   * What a run has spent so far, in the money the customer is actually
   * billed — tokens AND the sandbox seconds behind them.
   *
   * `budget:` says "the most one run may spend", and for a long time it
   * only ever compared token cost. A step that called no model — a script
   * looping on a page that never loads, a browser waiting on a selector
   * that never appears — spent nothing by that reading and was capped by
   * nothing, while the sandbox billed by the second. The platform has no
   * clock of its own by design, so the cap is the only backstop there is,
   * and it has to count the whole bill for that to be true.
   *
   * Default: token cost, which is the entire bill on an install that
   * prices no compute.
   */
  runSpend(run: RunRecord): number;
  /**
   * Should a trigger become a run? The flow file's `idempotency:`,
   * `throttle:`, `debounce:` and `disable_after:` are all answered here,
   * because all four need state that outlives one delivery — what has been
   * seen, when the last run started, what is still being waited out.
   *
   * Default: yes, always. A laptop has no fleet to protect and no duplicate
   * deliveries to remember; the local runner is the one asking, and it asked
   * because a person did.
   */
  admitTrigger(
    tenant: string,
    workspace: string,
    flow: FlowInfo,
    opts?: { deliveryKey?: string | null; body?: string; tag?: string },
  ): Promise<TriggerAdmission>;
  /** An admitted trigger whose start then threw. Undoes what admitTrigger
   *  recorded — the delivery as seen, the throttle window — so the sender's
   *  retry is a fresh event rather than a "duplicate" of a run that never
   *  existed. Default: nothing, because the default gate records nothing. */
  rollbackTrigger(
    tenant: string,
    workspace: string,
    flow: FlowInfo,
    opts?: { deliveryKey?: string | null; reason?: string },
  ): Promise<void>;
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
  /** The egress proxy — a per-step lease that keeps credentials out of the
   *  sandbox. Default: none, and the runner materialises as it always did. */
  egress: EgressHooks;
  /** A workspace's files changed — written, deployed, pushed, or the
   *  workspace deleted. What a scheduler that keeps flows in memory rather
   *  than re-reading every workspace each tick needs to hear. Default:
   *  nothing — locally the scheduler reads the disk. Never throws. */
  workspaceChanged(tenant: string, workspace: string, why: "write" | "deploy" | "push" | "delete"): void;
  /** Can a step in this isolation mode be re-attached to after the driver
   *  that started it is gone? True means an orphaned step with a `sandbox`
   *  on its record is resumed rather than destroyed and run again. Default:
   *  nothing is. */
  sandboxResumable(kind: string): boolean;
}

const local: PlatformHooks = {
  edition: () => "self-hosted",
  async enqueueFlowRun(tenant, workspace, steps, flowName, modelOverride, tags = [], startedBy = null) {
    // Imported here, not at the top: runner.ts imports this file.
    const { startFlowRun } = await import("./runner.ts");
    return startFlowRun(tenant, workspace, steps, flowName, modelOverride ?? null, tags, null, startedBy);
  },
  async enqueueResume() {},
  admitTrigger: async () => ({ admit: true }),
  async rollbackTrigger() {},
  runSpend: (run) => run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
  isolation: {},
  killRunSandboxes() {},
  syncPublicShares: () => ({ added: [] }),
  previewSourceOf: () => null,
  tenantKey: () => null,
  egress: { lease: async () => null },
  workspaceChanged() {},
  sandboxResumable: () => false,
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
