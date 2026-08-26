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
   *  Absent on entries written before margin existed (charge == cost then). */
  cost?: number;
  workspace?: string;
  runId?: string;
  note?: string;
}

/**
 * Margin, as platform configuration — not code, and never per-customer
 * logic scattered through the runner:
 *
 *   FOLDRUN_MARGIN=1.25       charge 25% over provider cost (default 1)
 *   FOLDRUN_MIN_RUN_FEE=0.01  no billable run charges less than this
 *
 * The floor only applies to runs that cost something: a run that failed
 * before its first model call spent nothing and is charged nothing —
 * billing a customer for our own gate refusing a step would be charging
 * them for the product working.
 */
function marginConfig(): { margin: number; minFee: number } {
  const margin = Number(process.env.FOLDRUN_MARGIN);
  const minFee = Number(process.env.FOLDRUN_MIN_RUN_FEE);
  return {
    margin: Number.isFinite(margin) && margin > 0 ? margin : 1,
    minFee: Number.isFinite(minFee) && minFee > 0 ? minFee : 0,
  };
}

/** Provider cost → customer charge. Pure, so the price of a run is testable
 *  without a ledger, and rounded to a whole number of micro-dollars so
 *  float dust never accumulates in an append-only file. */
export function priceRun(costUsd: number): number {
  if (!(costUsd > 0)) return 0;
  const { margin, minFee } = marginConfig();
  return Math.round(Math.max(costUsd * margin, minFee) * 1e6) / 1e6;
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
 * Record what a finished run cost. Idempotent: the worker calls this after
 * every drive, and a parked-then-resumed run is driven more than once.
 */
export function recordRunCost(
  tenant: string,
  workspace: string,
  runId: string,
  costUsd: number,
): LedgerEntry | null {
  if (!(costUsd > 0)) return null;
  if (readLedger(tenant).some((e) => e.kind === "run" && e.runId === runId)) return null;
  const entry: LedgerEntry = {
    t: new Date().toISOString(),
    kind: "run",
    usd: -priceRun(costUsd),
    cost: Math.round(costUsd * 1e6) / 1e6,
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
