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
import { accountDir } from "./store.ts";

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
  meter?: { steps: number; computeSecs: number };
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
 *   FOLDRUN_STEP_FEE=0.005         per step that actually ran
 *   FOLDRUN_COMPUTE_USD_PER_SEC    per sandbox second the run rented
 *   FOLDRUN_MIN_RUN_FEE=0.01       no billable run charges less than this
 *
 * The three new legs are what a customer can count in the flow file before
 * spending anything: the run is one, the steps are a list, and only the
 * compute leg is metered — the same bargain every serverless bill makes.
 *
 * Everything defaults to zero, so a self-hoster who sets none of it keeps
 * exactly the old behaviour: charge equals provider cost, and a BYOK run
 * costs nothing at all.
 */
interface PriceConfig {
  margin: number;
  runFee: number;
  stepFee: number;
  computeUsdPerSec: number;
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
    stepFee: envNum("FOLDRUN_STEP_FEE", 0),
    computeUsdPerSec: envNum("FOLDRUN_COMPUTE_USD_PER_SEC", 0),
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
  const secs = m.computeSecs > 0 ? m.computeSecs : 0;
  if (tokens === 0 && steps === 0 && secs === 0) return 0;

  const c = priceConfig();
  const charge = tokens * c.margin + c.runFee + steps * c.stepFee + secs * c.computeUsdPerSec;
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
 */
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
  const steps = m.steps > 0 ? m.steps : 0;
  const computeSecs = m.computeSecs > 0 ? micro(m.computeSecs) : 0;
  const entry: LedgerEntry = {
    t: new Date().toISOString(),
    kind: "run",
    usd: -charge,
    cost: m.tokenCostUsd > 0 ? micro(m.tokenCostUsd) : 0,
    ...(steps || computeSecs ? { meter: { steps, computeSecs } } : {}),
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
 */
export function assertFunds(tenant: string) {
  if (!billingEnabled()) return;
  if (creditBalance(tenant) > 0) return;
  const err = new Error(
    "out of credits — top up before starting new runs (existing runs finish either way)",
  );
  // HTTP is not this module's business, but the routes that surface this
  // refusal should say 402, and they duck-type this field to do it.
  (err as Error & { status: number }).status = 402;
  throw err;
}
