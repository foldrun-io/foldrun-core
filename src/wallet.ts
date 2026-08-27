// The wallet: what the ledger looks like from the account's side.
//
// The ledger answers "what happened"; the wallet answers the two questions a
// person with a scheduled flow actually has — "when do I run out?" and "will
// anything tell me before my 8 PM run refuses to start?". Both failure modes
// are silent by default: assertFunds throws at run start, which is exactly
// when nobody is watching a cron-fired flow.
//
// Three pieces:
//   walletSummary  — balance, burn rate, and the projected empty date
//   walletGuard    — swept hourly: auto top-up from a saved card, or a
//                    warning email, when the balance crosses the threshold
//   billing.json   — the account's wallet settings, beside its ledger

import fs from "node:fs";
import path from "node:path";
import { accountDir } from "./store.ts";
import { readLedger, creditBalance, billingEnabled } from "./ledger.ts";
import { getSecret } from "./secrets.ts";
import matter from "gray-matter";

export interface WalletConfig {
  /** Stripe customer holding the saved card, once one has been saved. */
  stripeCustomerId?: string;
  /** Refill automatically: below `thresholdUsd`, charge `amountUsd`. */
  autoTopUp?: { enabled: boolean; thresholdUsd: number; amountUsd: number };
  /** Where low-balance warnings go. Falls back to the account AGENTS.md
   *  notify email when unset. */
  email?: string;
  /** Set when a warning for the current crossing has been sent; cleared when
   *  the balance recovers. One email per crossing, not one per sweep. */
  warnedAt?: string;
  /** Set when an off-session charge has been created and its webhook has not
   *  yet landed — the guard against charging twice for one dip. */
  pendingChargeAt?: string;
}

const configPath = (tenant: string) => path.join(accountDir(tenant), "billing.json");

export function walletConfig(tenant: string): WalletConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(tenant), "utf8")) as WalletConfig;
  } catch {
    return {};
  }
}

export function saveWalletConfig(tenant: string, config: WalletConfig) {
  fs.mkdirSync(accountDir(tenant), { recursive: true });
  fs.writeFileSync(configPath(tenant), JSON.stringify(config, null, 2));
}

/** The warning threshold: explicit config, else 3 days of the current burn,
 *  else $5 — a floor so a fresh account with no history still gets warned. */
export function warnThresholdUsd(tenant: string, burnPerDay: number): number {
  const auto = walletConfig(tenant).autoTopUp;
  if (auto?.enabled && auto.thresholdUsd > 0) return auto.thresholdUsd;
  const env = Number(process.env.FOLDRUN_LOW_BALANCE_USD);
  if (Number.isFinite(env) && env > 0) return env;
  return Math.max(5, burnPerDay * 3);
}

export interface WalletSummary {
  balanceUsd: number;
  /** Average spend per day over the window that has data (up to 30 days). */
  burnPerDayUsd: number;
  spend7dUsd: number;
  spend30dUsd: number;
  /** Days until empty at the current burn; null when nothing is burning. */
  daysLeft: number | null;
  /** ISO date the balance hits zero at this burn; null when it doesn't. */
  emptyOn: string | null;
  warnBelowUsd: number;
}

export function walletSummary(tenant: string): WalletSummary {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let spend7 = 0;
  let spend30 = 0;
  let oldestSpend = now;
  for (const e of readLedger(tenant)) {
    if (e.usd >= 0) continue; // top-ups are not burn
    const t = new Date(e.t).getTime();
    if (now - t <= 30 * day) {
      spend30 += -e.usd;
      oldestSpend = Math.min(oldestSpend, t);
      if (now - t <= 7 * day) spend7 += -e.usd;
    }
  }
  // Burn over the days that actually have data: a two-day-old account
  // dividing by 30 would report a burn 15× too low and a runway 15× too
  // long, which is the one direction this number must never err in.
  const windowDays = Math.min(30, Math.max(1, (now - oldestSpend) / day));
  const burn = spend30 / windowDays;
  const balance = creditBalance(tenant);
  const daysLeft = burn > 0 ? balance / burn : null;
  return {
    balanceUsd: Number(balance.toFixed(6)),
    burnPerDayUsd: Number(burn.toFixed(4)),
    spend7dUsd: Number(spend7.toFixed(4)),
    spend30dUsd: Number(spend30.toFixed(4)),
    daysLeft: daysLeft === null ? null : Number(daysLeft.toFixed(1)),
    emptyOn: daysLeft === null ? null : new Date(now + daysLeft * day).toISOString().slice(0, 10),
    warnBelowUsd: Number(warnThresholdUsd(tenant, burn).toFixed(2)),
  };
}

// ------------------------------------------------------------------ guard

/**
 * Charge the account's saved card off-session. The ledger is NOT credited
 * here — the webhook does that when Stripe confirms, exactly as a checkout
 * top-up works. "We asked for money" and "the money arrived" stay different
 * facts with different writers.
 */
async function chargeSavedCard(tenant: string, customerId: string, usd: number): Promise<boolean> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return false;

  const pmRes = await fetch(
    `https://api.stripe.com/v1/payment_methods?customer=${encodeURIComponent(customerId)}&type=card&limit=1`,
    { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) },
  );
  const pms = (await pmRes.json()) as { data?: { id: string }[] };
  const pm = pms.data?.[0]?.id;
  if (!pm) {
    console.error(`[foldrun] wallet: auto top-up for ${tenant} has a customer but no saved card`);
    return false;
  }

  const form = new URLSearchParams({
    amount: String(Math.round(usd * 100)),
    currency: "usd",
    customer: customerId,
    payment_method: pm,
    off_session: "true",
    confirm: "true",
    description: "foldrun credits (auto top-up)",
    "metadata[tenant]": tenant,
    "metadata[kind]": "auto-topup",
  });
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      // One dip, one charge: if the sweep races itself, Stripe collapses the
      // duplicates instead of the card statement showing them.
      "idempotency-key": `foldrun-autotopup-${tenant}-${new Date().toISOString().slice(0, 13)}`,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    console.error(`[foldrun] wallet: auto top-up charge for ${tenant} refused: ${body.error?.message ?? res.status}`);
    return false;
  }
  return true;
}

/** The account's warning address: wallet config first, then the account
 *  AGENTS.md notify email — the same place run failures already go. */
function warningEmail(tenant: string): string | null {
  const own = walletConfig(tenant).email;
  if (own) return own;
  try {
    const raw = matter(fs.readFileSync(path.join(accountDir(tenant), "AGENTS.md"), "utf8")).data
      ?.notify as unknown;
    if (typeof raw === "string" && raw.includes("@") && !raw.includes("/")) return raw;
    if (raw && typeof raw === "object" && typeof (raw as { email?: string }).email === "string") {
      return (raw as { email: string }).email;
    }
  } catch {
    // no account AGENTS.md is normal
  }
  return null;
}

async function sendLowBalanceEmail(tenant: string, summary: WalletSummary): Promise<boolean> {
  const to = warningEmail(tenant);
  if (!to) {
    console.error(`[foldrun] wallet: ${tenant} is low ($${summary.balanceUsd.toFixed(2)}) and has no warning email configured`);
    return false;
  }
  const key = getSecret(tenant, "RESEND_API_KEY");
  if (!key) {
    console.error(`[foldrun] wallet: low-balance email for ${tenant} needs RESEND_API_KEY`);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key.value}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: "foldrun <onboarding@resend.dev>",
      to,
      subject: `foldrun credits low: $${summary.balanceUsd.toFixed(2)} left`,
      text:
        `Your foldrun balance is $${summary.balanceUsd.toFixed(2)}, below the $${summary.warnBelowUsd.toFixed(2)} warning level.\n\n` +
        (summary.daysLeft !== null
          ? `At the current burn of $${summary.burnPerDayUsd.toFixed(2)}/day it runs out around ${summary.emptyOn}.\n\n`
          : "") +
        `Runs already going always finish, but NEW runs — including scheduled flows — are refused at $0.\n` +
        `Top up in the dashboard under Wallet, or turn on auto top-up there so this takes care of itself.\n`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) console.error(`[foldrun] wallet: low-balance email for ${tenant} → HTTP ${res.status}`);
  return res.ok;
}

/**
 * The hourly wallet check for one account. Ordering is deliberate: a working
 * auto top-up makes the warning email unnecessary, so the email is the
 * fallback, not the companion.
 */
export async function walletGuard(tenant: string): Promise<void> {
  if (!billingEnabled()) return;
  const summary = walletSummary(tenant);
  const config = walletConfig(tenant);

  if (summary.balanceUsd >= summary.warnBelowUsd) {
    // Recovered: arm the next crossing.
    if (config.warnedAt || config.pendingChargeAt) {
      saveWalletConfig(tenant, { ...config, warnedAt: undefined, pendingChargeAt: undefined });
    }
    return;
  }

  const auto = config.autoTopUp;
  if (auto?.enabled && auto.amountUsd > 0 && config.stripeCustomerId) {
    // A charge already in flight means the webhook simply hasn't landed;
    // asking again would double-bill the same dip. Six hours is far beyond
    // Stripe's confirmation time, so a marker older than that is a failed
    // charge — fall through and at least warn.
    const pending = config.pendingChargeAt && Date.now() - new Date(config.pendingChargeAt).getTime() < 6 * 60 * 60 * 1000;
    if (pending) return;
    if (await chargeSavedCard(tenant, config.stripeCustomerId, auto.amountUsd)) {
      saveWalletConfig(tenant, { ...walletConfig(tenant), pendingChargeAt: new Date().toISOString() });
      return;
    }
  }

  if (!config.warnedAt) {
    if (await sendLowBalanceEmail(tenant, summary)) {
      saveWalletConfig(tenant, { ...walletConfig(tenant), warnedAt: new Date().toISOString() });
    }
  }
}
