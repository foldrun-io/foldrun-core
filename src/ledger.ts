// The money ledger. Append-only, one line per event, one file per account:
//
//   data/<tenant>/ledger.jsonl
//
// A balance is the sum of the lines — there is no stored balance to drift
// out of agreement with its own history, which for money is the failure
// mode that matters. Run costs are recorded once per run (idempotent by
// run id), so re-driving a resumed run cannot bill it twice.
//
// Enforcement is opt-in per install: MDAGENT_BILLING=1 makes an empty tank
// refuse new runs. Self-hosters who never set it get the ledger as pure
// observability — the "Spent" tile with a paper trail — and the CLI never
// sets it, so local runs are never refused. The hosted platform sets it.

import fs from "node:fs";
import path from "node:path";
import { accountDir } from "./store.ts";

export interface LedgerEntry {
  t: string;
  kind: "topup" | "run" | "adjustment";
  /** Positive credits the account, negative spends it. */
  usd: number;
  workspace?: string;
  runId?: string;
  note?: string;
}

function ledgerFile(tenant: string) {
  return path.join(accountDir(tenant), "ledger.jsonl");
}

export function billingEnabled() {
  return process.env.MDAGENT_BILLING === "1";
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
    usd: -costUsd,
    workspace,
    runId,
  };
  append(tenant, entry);
  return entry;
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
