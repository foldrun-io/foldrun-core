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
import { matchFilter } from "./trigger-filter.ts";

export type IsolatedStepRunner = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

/** Who this install is for. `hosted` means someone is paying the operator
 *  for it — a wallet, a plan, a bill. `self-hosted` is everything else: a
 *  laptop, a dev install, a box nobody bills on. */
export type Edition = "self-hosted" | "hosted";

/** What a trigger gate decided. `admit: false` is never an error: the
 *  trigger was received and understood, and the flow's own file says this
 *  one does not become a run. `detail` is what the sender and the log are
 *  told, because a silent drop reads exactly like a broken hook. */
export type TriggerAdmission =
  | { admit: true }
  | { admit: false; reason: "duplicate" | "throttled" | "quarantined" | "paused" | "halted" | "debounced" | "filtered"; detail: string; firesAt?: number };

export interface PlatformHooks {
  /** Is this a hosted install? The ONE question every commercial surface —
   *  the wallet, top-ups, plan limits, whatever is added next that assumes
   *  a customer — asks before it renders or answers. Default: self-hosted,
   *  which is what a process that never registered a platform is, and what
   *  any install is unless its operator configures billing. One predicate,
   *  one place, so "does an unbilled install show X" is a test and not an
   *  audit. */
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
    /** `test: true` marks the run a test run (see test-mode.ts). Unset
     *  lets the platform decide — a preview workspace's runs are tests
     *  unless the flow says `live: true`. */
    opts?: { test?: boolean },
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
    /** `fields`: what the flow's `filter:` is matched against — a webhook's
     *  JSON, an email, a chained run, a storage event. Absent: no filter
     *  applies (a schedule has nothing to match). */
    opts?: { deliveryKey?: string | null; body?: string; tag?: string; fields?: unknown },
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
  /** Destroy ONE step's sandbox, by the ref on its record — a sandbox: own
   *  job orphaned by a restart while its parent re-attaches, where killing
   *  the whole run's would take the parent too. Optional: an executor that
   *  cannot re-attach never needs it (the whole run's are killed instead). */
  killSandbox?(sandbox: { kind: string; ref: string }): void;
  /** A restarted driver's sweep of the run's orphans: destroy its
   *  sandboxes except `keep` (the refs its steps re-attach to). Not a stop —
   *  the run goes on, and steps of it are about to start. Optional: without
   *  it the whole run's are killed (killRunSandboxes). */
  killOrphanSandboxes?(runId: string, keep: readonly string[]): void;
  /** Is there room for a step waiting in the queue to start now — by the
   *  same rules as the executor's room gate — and if not, why. Asked before
   *  such a step is started again, so a run claimed only to find no room
   *  yet adds nothing to its trail. Optional: without it the step goes to
   *  its executor, which looks there. */
  roomCheck?(ask: { tenant: string; workspace: string; runId: string; since: string; cpus: number; memGiB: number; diskGiB: number }): Promise<string | null>;
  /** Publish storage/public/ as share links after a run. Default: no links. */
  syncPublicShares(tenant: string, workspace: string): Promise<{ added: string[] }>;
  /** This account's own data key, or null to use the install key. */
  tenantKey(tenant: string): Buffer | null;
  /** The egress proxy — a per-step lease that keeps credentials out of the
   *  sandbox. Default: none, and the runner materialises as it always did. */
  egress: EgressHooks;
  /** A workspace's files changed — written, deployed, pushed, or the
   *  workspace deleted. What a scheduler that keeps flows in memory rather
   *  than re-reading every workspace each tick needs to hear. Default:
   *  nothing — locally the scheduler reads the disk. Never throws. */
  workspaceChanged(tenant: string, workspace: string, why: "write" | "deploy" | "delete"): void;
  /** Can a step in this isolation mode be re-attached to after the driver
   *  that started it is gone? True means an orphaned step with a `sandbox`
   *  on its record is resumed rather than destroyed and run again. Default:
   *  nothing is. */
  sandboxResumable(kind: string): boolean;
  /** May this account's steps run on the platform's own model credential
   *  (the host's key or Claude login)? A hosted platform lets only its
   *  operator's accounts do so; every customer brings their own API key.
   *  Default: yes — a laptop or a self-hosted install is its own operator. */
  platformKeyAllowed(tenant: string): boolean;
  /**
   * An operator setting, by the environment variable that used to hold it
   * (30 Oct 2026): the platform answers with the operator's value where one
   * is set (its settings store) and the variable otherwise, spelled as the
   * variable would be. Read where core reads FOLDRUN_EMAIL_FROM, the
   * platform mail caps and the step sizes. Default: the variable itself —
   * a laptop or the CLI reads its environment as before.
   */
  setting(env: string): string | undefined;
  /**
   * Where the platform's built-in tools sit on disk, materialised at boot —
   * a shelf every account reads, beneath its own library. A name found in
   * the workspace wins, then the account's copy, then this. Default: none,
   * which is what a laptop has; there the gallery is a dashboard feature and
   * not a directory, and an agent grants only what it or its account owns.
   */
  galleryDir(): string | null;
  /**
   * An oauth2 secret was just refreshed — `error` null when it worked, the
   * provider's reason when it did not. The platform keeps each connection's
   * health, emails once when a grant is dead, and answers with the one-click
   * reconnect address, which the failing step's error then quotes. Default:
   * nothing to say, which is a laptop.
   */
  noteOAuthRefresh(ctx: { tenant: string; workspace?: string }, name: string, error: string | null): Promise<string | undefined>;
  /**
   * fetch() for a URL a tenant chose — a webhook, an OAuth token endpoint,
   * a provider base URL, an OpenAPI source. On a platform these run on the
   * worker or web tier, which can reach what a sandbox cannot, so the
   * platform refuses private and cluster addresses. Default: plain fetch,
   * which is a laptop calling its own LAN on purpose. Core calls this only
   * through untrusted-fetch.ts, once per hop with `redirect: "manual"`, so
   * every redirect target is checked here like the first URL was.
   * `maxBytes` is the most the answer may be, read (untrusted-fetch.ts
   * caps it again, so a laptop's plain fetch may ignore it).
   */
  fetchUntrusted(url: string, init?: RequestInit, opts?: { maxBytes?: number }): Promise<Response>;
  /**
   * May the host call this URL a tenant chose — a provider's base_url,
   * before an eval's judge or a dashboard draft talks to it? A reason it may
   * not, or null. This is the early refusal people can read; the guarantee
   * is that every byte of such a call goes through fetchUntrusted (FOL-95).
   * Default: hostUrlProblem below — https on an install that guards
   * untrusted fetches, anything on a laptop (its own localhost included).
   * A platform may bind a stricter check (the addresses a name resolves to).
   */
  checkUntrustedUrl(url: string): Promise<string | null>;
  /**
   * Hand a notify: webhook to whatever delivers it. The platform records
   * the delivery, makes the first attempt now and retries on a backoff from
   * the worker (`retry: true`); `retry: false` is one attempt, recorded —
   * the test button. Default: one attempt now, recorded nowhere, which is a
   * laptop: there is no worker to retry from and nobody to read the log.
   */
  deliverWebhook(
    tenant: string,
    workspace: string,
    delivery: { event: string; body: string; retry: boolean },
  ): Promise<WebhookDeliveryOutcome>;
  /**
   * Does this person take this optional category of mail — for this
   * workspace, when the category is per workspace? Asked by mail.ts at send
   * time, never for required mail. Default: yes; a laptop keeps no
   * preferences and sends what it always sent.
   */
  mailPreference(tenant: string, email: string, category: string, workspace: string | null): Promise<boolean>;
}

/** What handing a webhook over came to: the delivery's id (the
 *  X-Foldrun-Delivery header) and its first attempt, when one was made. */
export interface WebhookDeliveryOutcome {
  ok: boolean;
  deliveryId: string;
  statusCode: number | null;
  /** The receiver's words or the error, trimmed — what the test reports. */
  detail: string;
  /** True when a failed first attempt has later ones scheduled. */
  retrying?: boolean;
}

/** Marks the laptop's fetchUntrusted. A symbol from the global registry, not
 *  the function itself: every bundle has its own copy of this module (see
 *  KEY below), and only the shared object says which one was registered. */
const LAPTOP_FETCH = Symbol.for("foldrun.laptop-fetch");

const local: PlatformHooks = {
  edition: () => "self-hosted",
  async enqueueFlowRun(tenant, workspace, steps, flowName, modelOverride, tags = [], startedBy = null, opts = {}) {
    // Imported here, not at the top: runner.ts imports this file.
    const { startFlowRun } = await import("./runner.ts");
    return startFlowRun(tenant, workspace, steps, flowName, modelOverride ?? null, tags, null, startedBy, opts);
  },
  async enqueueResume() {},
  // The flow's own `filter:` holds here too: a laptop has no fleet, but a
  // delivery the flow says is not for it is still not for it.
  admitTrigger: async (_tenant, _workspace, flow, opts) => {
    if (flow.filter == null || opts?.fields === undefined) return { admit: true };
    const v = matchFilter(flow.filter, opts.fields);
    return v.match ? { admit: true } : { admit: false, reason: "filtered", detail: `filter: ${v.reason} — no run started` };
  },
  async rollbackTrigger() {},
  runSpend: (run) => run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
  isolation: {},
  killRunSandboxes() {},
  syncPublicShares: async () => ({ added: [] }),
  tenantKey: () => null,
  egress: { lease: async () => null },
  workspaceChanged() {},
  sandboxResumable: () => false,
  platformKeyAllowed: () => true,
  setting: (env) => process.env[env],
  galleryDir: () => null,
  noteOAuthRefresh: async () => undefined,
  fetchUntrusted: Object.assign((url: string, init?: RequestInit) => fetch(url, init), { [LAPTOP_FETCH]: true }),
  checkUntrustedUrl: async (url) => hostUrlProblem(url),
  async deliverWebhook(tenant, workspace, delivery) {
    const { attemptWebhook, newDeliveryId } = await import("./notify.ts");
    const deliveryId = newDeliveryId();
    const a = await attemptWebhook(tenant, workspace, { id: deliveryId, event: delivery.event, body: delivery.body, attempt: 1 });
    return { ok: a.ok, deliveryId, statusCode: a.statusCode, detail: a.error ?? a.response ?? "" };
  },
  mailPreference: async () => true,
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

/** True when this process fetches tenant-chosen URLs through a guard: a
 *  platform bound fetchUntrusted. A laptop has not, and calls its own LAN on
 *  purpose. */
export function guardsUntrustedUrls(): boolean {
  return !(platform.fetchUntrusted as unknown as Record<symbol, unknown>)[LAPTOP_FETCH];
}

/**
 * Why the host may not call a tenant's model endpoint at this URL, or null.
 * On an install that guards untrusted fetches the endpoint must be https: the
 * key rides in every request, and a plain-http base is also how a tenant
 * names a cluster service. Private and internal addresses are refused by the
 * guard itself, on every hop. FOLDRUN_EGRESS_ALLOW_PRIVATE=1 — the operator's
 * own install calling its own network — lifts this as it lifts the guard. A
 * laptop: always null.
 */
export function hostUrlProblem(url: string): string | null {
  if (!guardsUntrustedUrls() || process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE === "1") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${url} is not a URL`;
  }
  if (u.protocol !== "https:") return `${u.origin} is not https — this platform calls a model endpoint only over https`;
  return null;
}

/** Install the platform's implementations. Partial: what is not given keeps its local default. */
export function registerPlatform(hooks: Partial<PlatformHooks>): void {
  Object.assign(platform, hooks, {
    isolation: { ...platform.isolation, ...(hooks.isolation ?? {}) },
  });
}

/**
 * Does a platform own the queue? True once something registered its own
 * enqueueFlowRun — whatever process asks. An eval used to decide this from
 * FOLDRUN_ROLE === "web", so on a worker it started the run in-process and
 * walked around the queue the platform was counting on (the account cap,
 * the lanes, the per-pod lease). The seam is the fact; the role is a guess.
 */
export function platformQueues(): boolean {
  return platform.enqueueFlowRun !== local.enqueueFlowRun;
}

/** Back to the local defaults — for tests that register and must not leak. */
export function resetPlatform(): void {
  Object.assign(platform, local, { isolation: {} });
}
