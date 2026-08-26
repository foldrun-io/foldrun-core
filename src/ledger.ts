// The money ledger. Append-only, one line per event, one file per account:
//
//   data/<tenant>/ledger.jsonl
//
// A balance is the sum of the lines — there is no stored balance to drift
// out of agreement with its own history, which for money is the failure
// mode that matters. Run costs are recorded once per run (idempotent by
// run id), so re-driving a resumed run cannot bill it twice.
//
// Enforcement is opt-in per install: FOLDRUN_BILLING=1 makes an empty tank
// refuse new runs. Self-hosters who never set it get the ledger as pure
// observability — the "Spent" tile with a paper trail — and the CLI never
// sets it, so local runs are never refused. The hosted platform sets it.

import fs from "node:fs";
import path from "node:path";
import { accountDir, assertSafeName, registerRunDeletionListener } from "./store.ts";

// The books hear about deletions without store.ts importing money.
registerRunDeletionListener((tenant, workspace, runId) => noteRunDeleted(tenant, workspace, runId));

export interface LedgerEntry {
  t: string;
  kind: "topup" | "run" | "adjustment";
  /** Positive credits the account, negative spends it. For a run this is
   *  the *charge* — what the customer's credits paid, margin included. */
  usd: number;
  /** What the run cost the platform at the provider, before margin. Kept on
   *  the same line so every charge carries its own audit: the margin earned
   *  on any entry is `-usd - cost`, derivable forever, stored nowhere.
   *  Absent on entries written before margin existed (charge == cost then).
   *  Zero on a BYOK run — the tokens were bought on the customer's own
   *  account and never passed through ours. */
  cost?: number;
  /** The non-token units this run was billed on. Recorded because a line
   *  that says only "$0.03" cannot be argued with; one that says "4 steps,
   *  71.2 sandbox seconds" can be checked against the run it came from.
   *  Absent on entries written before run/step/compute pricing existed. */
  meter?: { steps: number; computeSecs: number; netBytes?: number };
  workspace?: string;
  runId?: string;
  note?: string;
}

/**
 * What a finished run consumed. `store.ts#runMeter` produces it; nothing
 * else should, because "which steps count" is a question with one answer.
 *
 * The token cost is zero for a BYOK run, and the run is still billable:
 * bringing your own key buys you out of token resale, not out of the pod,
 * the storage and the orchestration that ran your flow.
 */
export interface RunMeter {
  tokenCostUsd: number;
  steps: number;
  computeSecs: number;
  /** Seconds of computeSecs held at the small reservation; the rest were
   *  large. Absent means all large. */
  smallSecs?: number;
  /** Bytes on the wire, both directions, where the sandbox could read its
   *  counters. Absent/zero on older runs and unreadable sandboxes. */
  netBytes?: number;
}

/** A bare number is a token-only run — the CLI and self-host paths, which
 *  rent no metered sandbox and have no compute leg to report. */
function asMeter(meter: RunMeter | number): RunMeter {
  return typeof meter === "number"
    ? { tokenCostUsd: meter, steps: 0, computeSecs: 0 }
    : meter;
}

/**
 * Pricing, as platform configuration — not code, and never per-customer
 * logic scattered through the runner:
 *
 *   FOLDRUN_MARGIN=1.25            charge 25% over provider token cost
 *   FOLDRUN_RUN_FEE=0.02           per run, whoever's key paid for tokens
 *   FOLDRUN_COMPUTE_USD_PER_SEC    per LARGE sandbox second the run rented
 *   FOLDRUN_COMPUTE_USD_PER_SEC_SMALL  per small second (defaults to the
 *                                  large rate — a discount is a decision)
 *   FOLDRUN_NET_USD_PER_GB         per GB the run moved on the wire
 *   FOLDRUN_MIN_RUN_FEE=0.01       no billable run charges less than this
 *
 * No per-step fee, decidedly: a step is not a unit of anything the platform
 * pays for — steps ARE sandbox-seconds, so a step fee double-charges
 * compute and punishes well-factored flows for being well-factored.
 *
 * Network is charged on what the meter read, not on what the platform paid
 * (its own egress is free): the price of a metered unit is a product
 * decision, and moving bytes for a customer is worth something whether or
 * not the wire invoiced us.
 *
 * Everything defaults to zero, so a self-hoster who sets none of it keeps
 * exactly the old behaviour: charge equals provider cost, and a BYOK run
 * costs nothing at all.
 */
interface PriceConfig {
  margin: number;
  runFee: number;
  computeUsdPerSec: number;
  computeUsdPerSecSmall: number;
  netUsdPerGb: number;
  minFee: number;
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function priceConfig(): PriceConfig {
  return {
    margin: envNum("FOLDRUN_MARGIN", 1),
    runFee: envNum("FOLDRUN_RUN_FEE", 0),
    computeUsdPerSec: envNum("FOLDRUN_COMPUTE_USD_PER_SEC", 0),
    computeUsdPerSecSmall: envNum(
      "FOLDRUN_COMPUTE_USD_PER_SEC_SMALL",
      envNum("FOLDRUN_COMPUTE_USD_PER_SEC", 0),
    ),
    netUsdPerGb: envNum("FOLDRUN_NET_USD_PER_GB", 0),
    minFee: envNum("FOLDRUN_MIN_RUN_FEE", 0),
  };
}

const micro = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * What a run consumed → what the customer is charged. Pure, so the price of
 * a run is testable without a ledger, and rounded to a whole number of
 * micro-dollars so float dust never accumulates in an append-only file.
 *
 * Two invariants, both about not inventing bills:
 *
 *   - A run that did nothing is free. Not "cheap" — free. A run our own
 *     gate refused before its first step spent nothing of ours, and the
 *     floor must never manufacture a charge for it.
 *   - A run that did something but priced to zero stays zero. That is the
 *     self-hoster with no pricing configured, and the floor is not an
 *     invitation to start charging them.
 */
export function priceRun(meter: RunMeter | number): number {
  const m = asMeter(meter);
  const tokens = m.tokenCostUsd > 0 ? m.tokenCostUsd : 0;
  const steps = m.steps > 0 ? m.steps : 0;
  // Whole seconds, rounded up, never less than one for a run that computed
  // at all — the industry's floor, and the honest one: a bill line reading
  // "0.4s" invites a dispute about measurement precision that a floor
  // announces away. A run with zero compute stays zero. The floor applies
  // to the run's total; the small share is priced at its own rate and the
  // remainder at the large rate.
  const rawSmall = Math.min(m.smallSecs ?? 0, m.computeSecs > 0 ? m.computeSecs : 0);
  const secs = m.computeSecs > 0 ? Math.max(1, Math.ceil(m.computeSecs)) : 0;
  const small = secs > 0 ? Math.min(Math.round(rawSmall), secs) : 0;
  const large = secs - small;
  const gb = (m.netBytes ?? 0) > 0 ? m.netBytes! / (1024 * 1024 * 1024) : 0;
  if (tokens === 0 && steps === 0 && secs === 0 && gb === 0) return 0;

  const c = priceConfig();
  const charge =
    tokens * c.margin + c.runFee +
    large * c.computeUsdPerSec + small * c.computeUsdPerSecSmall +
    gb * c.netUsdPerGb;
  if (!(charge > 0)) return 0;
  return micro(Math.max(charge, c.minFee));
}

function ledgerFile(tenant: string) {
  return path.join(accountDir(tenant), "ledger.jsonl");
}

export function billingEnabled() {
  return process.env.FOLDRUN_BILLING === "1";
}

export function readLedger(tenant: string): LedgerEntry[] {
  const file = ledgerFile(tenant);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as LedgerEntry;
      } catch {
        return null; // a torn tail line loses one entry, never the file
      }
    })
    .filter((e): e is LedgerEntry => e !== null);
}

export function creditBalance(tenant: string): number {
  return readLedger(tenant).reduce((sum, e) => sum + e.usd, 0);
}

function append(tenant: string, entry: LedgerEntry) {
  const file = ledgerFile(tenant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_APPEND: single-line writes land whole even if two land at once.
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

/**
 * A run was deleted from history; say so where its charge lives. Written
 * only when the run had a charge — an unbilled run deleted leaves nothing
 * behind to explain. Zero-value: deletion never moves money, it only
 * completes the story of a line that now points at nothing.
 */
export function noteRunDeleted(tenant: string, workspace: string, runId: string) {
  const charged = readLedger(tenant).some((e) => e.kind === "run" && e.runId === runId);
  if (!charged) return;
  append(tenant, {
    t: new Date().toISOString(),
    kind: "adjustment",
    usd: 0,
    workspace,
    runId,
    note: "run deleted from history — the charge stands",
  });
}

/**
 * The recurring half of the bill, accrued daily so a mid-month customer is
 * never charged a month: the base fee (unlimited seats — people supervising
 * agents are not a metered unit, and taxing the reviewer who clicks approve
 * would price out the platform's own safety story) and storage at rate per
 * GB-month, both divided by the days in that month.
 *
 *   FOLDRUN_BASE_FEE_MONTHLY=29     the account, per month
 *   FOLDRUN_STORAGE_USD_PER_GB_MONTH=0.15
 *
 * Idempotent per calendar day per kind: the sweep can run every tick and
 * writes at most one line of each. Zero-rate installs accrue nothing, and
 * accrual only happens where billing is enforced — a self-hoster's ledger
 * is observability, not a subscription.
 */
export function accrueDaily(tenant: string, storageBytes: number, now = new Date()): LedgerEntry[] {
  if (!billingEnabled()) return [];
  const day = now.toISOString().slice(0, 10);
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const existing = readLedger(tenant).filter(
    (e) => e.kind === "adjustment" && e.note?.endsWith(day),
  );
  const written: LedgerEntry[] = [];

  const baseMonthly = Number(process.env.FOLDRUN_BASE_FEE_MONTHLY);
  if (Number.isFinite(baseMonthly) && baseMonthly > 0 &&
      !existing.some((e) => e.note?.startsWith("base fee"))) {
    const entry: LedgerEntry = {
      t: now.toISOString(),
      kind: "adjustment",
      usd: -micro(baseMonthly / daysInMonth),
      note: `base fee ${day}`,
    };
    append(tenant, entry);
    written.push(entry);
  }

  const perGbMonth = Number(process.env.FOLDRUN_STORAGE_USD_PER_GB_MONTH);
  const gb = storageBytes / (1024 * 1024 * 1024);
  if (Number.isFinite(perGbMonth) && perGbMonth > 0 && gb > 0 &&
      !existing.some((e) => e.note?.startsWith("storage"))) {
    const usd = micro((gb * perGbMonth) / daysInMonth);
    if (usd > 0) {
      const entry: LedgerEntry = {
        t: now.toISOString(),
        kind: "adjustment",
        usd: -usd,
        note: `storage ${gb.toFixed(2)}GB ${day}`,
      };
      append(tenant, entry);
      written.push(entry);
    }
  }
  return written;
}

export function recordTopUp(tenant: string, usd: number, note?: string): LedgerEntry {
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error("top-up must be a positive amount");
  const entry: LedgerEntry = { t: new Date().toISOString(), kind: "topup", usd, note };
  append(tenant, entry);
  return entry;
}

/**
 * Record what a finished run consumed. Idempotent: the worker calls this
 * after every drive, and a parked-then-resumed run is driven more than once.
 *
 * Returns null when there is nothing to charge — including the self-hoster
 * with no pricing configured, whose ledger stays empty rather than filling
 * with zero-dollar lines.
 *
 * Idempotence has to hold under *concurrency*, not just repetition: a parked
 * run is re-enqueued by the approval API while its previous drive may still
 * be settling, so two drivers can reach this function for one run at once.
 * A read-then-append check leaves a window where both see "not billed" and
 * both charge. The claim below closes it: creating the run's marker file
 * with O_EXCL is atomic on the filesystem, so exactly one caller wins the
 * right to append.
 *
 * The ledger scan stays, first, because runs billed before markers existed
 * have a line but no marker — without the scan an upgrade would re-bill
 * history. Ordering the marker before the append means a crash between the
 * two loses one run's charge rather than ever doubling one; between those
 * failure modes, the one the customer can't be hurt by is the right one.
 */
function claimSettle(tenant: string, runId: string): boolean {
  assertSafeName(runId, "run id");
  const dir = path.join(accountDir(tenant), "billed");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, runId), "", { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export function recordRunCost(
  tenant: string,
  workspace: string,
  runId: string,
  meter: RunMeter | number,
): LedgerEntry | null {
  const m = asMeter(meter);
  const charge = priceRun(m);
  if (!(charge > 0)) return null;
  if (readLedger(tenant).some((e) => e.kind === "run" && e.runId === runId)) return null;
  if (!claimSettle(tenant, runId)) return null;
  const steps = m.steps > 0 ? m.steps : 0;
  const computeSecs = m.computeSecs > 0 ? micro(m.computeSecs) : 0;
  const netBytes = Math.round(m.netBytes ?? 0);
  const entry: LedgerEntry = {
    t: new Date().toISOString(),
    kind: "run",
    usd: -charge,
    cost: m.tokenCostUsd > 0 ? micro(m.tokenCostUsd) : 0,
    ...(steps || computeSecs || netBytes
      ? { meter: { steps, computeSecs, ...(netBytes ? { netBytes } : {}) } }
      : {}),
    workspace,
    runId,
  };
  append(tenant, entry);
  return entry;
}

/**
 * The account's money in one shape: what's left, what was charged, what the
 * charged runs cost the platform, and the difference — the margin actually
 * earned, derived from the lines rather than tracked beside them. Entries
 * from before `cost` existed count as charge == cost: honest, since margin
 * was 1 then.
 */
export function ledgerSummary(tenant: string): {
  balanceUsd: number;
  chargedUsd: number;
  providerCostUsd: number;
  marginUsd: number;
} {
  let balance = 0;
  let charged = 0;
  let cost = 0;
  for (const e of readLedger(tenant)) {
    balance += e.usd;
    if (e.kind === "run") {
      charged += -e.usd;
      cost += e.cost ?? -e.usd;
    }
  }
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    balanceUsd: r(balance),
    chargedUsd: r(charged),
    providerCostUsd: r(cost),
    marginUsd: r(charged - cost),
  };
}

/**
 * The gate on starting anything new. Enforced only when the install opted
 * in, and only at the point work is *added* — a run already in flight is
 * never cut off mid-step over money, because a half-done run still costs
 * what it cost and delivers nothing.
 *
 * `balance > 0` alone has two holes, both stemming from the same fact: a
 * run's cost is unknown until it finishes, so the check is structurally one
 * run late. Sequentially, a $0.01 balance admits a run that then costs
 * whatever it costs. Concurrently it is worse — a webhook burst fires ten
 * runs in a second, every one sees the same positive balance, and every one
 * is admitted before any settles.
 *
 *   FOLDRUN_MAX_RUN_EXPOSURE=2.00   worst-case cost the platform will
 *                                   carry per admitted-but-unsettled run
 *
 * Set, the gate holds that much of the balance for every run already in
 * flight and requires headroom for the new one on top: overdraft is bounded
 * by how far a real run beats the estimate, instead of by how many jobs a
 * burst can enqueue. Unset, the old behaviour — positive balance admits —
 * which remains the self-hoster default, where the ledger is observability
 * and nobody is owed anything.
 *
 * `inFlight` is the caller's count of admitted-but-unsettled runs for this
 * tenant. The queue knows it (this module deliberately doesn't — money must
 * not import the machinery it gates), and counting jobs *after* this check
 * still narrows the burst window rather than closing it — two enqueues can
 * interleave between count and write. Closing it fully needs the count and
 * the admission under one lock; at this tier the bound is the product:
 * N racing enqueues can overshoot by N × exposure at most once, not
 * unboundedly.
 */
export function assertFunds(tenant: string, inFlight = 0) {
  if (!billingEnabled()) return;
  const balance = creditBalance(tenant);
  const exposure = Number(process.env.FOLDRUN_MAX_RUN_EXPOSURE);
  const refuse = (msg: string) => {
    const err = new Error(msg);
    // HTTP is not this module's business, but the routes that surface this
    // refusal should say 402, and they duck-type this field to do it.
    (err as Error & { status: number }).status = 402;
    throw err;
  };
  if (Number.isFinite(exposure) && exposure > 0) {
    const needed = exposure * (inFlight + 1);
    if (balance < needed) {
      refuse(
        `insufficient credits for another run — $${needed.toFixed(2)} held ` +
          `($${exposure.toFixed(2)} × ${inFlight + 1} unsettled run${inFlight ? "s" : ""}), ` +
          `balance $${balance.toFixed(2)} (existing runs finish either way)`,
      );
    }
    return;
  }
  if (balance > 0) return;
  refuse("out of credits — top up before starting new runs (existing runs finish either way)");
}
