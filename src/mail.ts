// Every email the platform sends, through one door.
//
// Mail used to leave from six places, each with its own fetch to Resend and
// none of them asking whether the person reading it wanted it. A person who
// was tired of "credits low" had one remedy — a filter — and a filter that
// bins the low-balance warning bins the payment failure beside it.
//
// Now each send names a CATEGORY, and the category decides two things:
//
//   · whether the person may turn it off. Security, billing failures,
//     invites and account notices may not: a password reset nobody receives
//     is a locked-out person, and a payment failure nobody reads is an
//     account that stops working with no warning. Everything else — run
//     alerts, approval requests, low-balance warnings, product news — is the
//     reader's to refuse, per workspace where the mail is about one.
//
//   · whether it carries a one-click unsubscribe (RFC 8058): a
//     `List-Unsubscribe` URL with a signed token and `List-Unsubscribe-Post:
//     List-Unsubscribe=One-Click`, so the mail client's own "Unsubscribe"
//     turns that category off without a login. Gmail and Yahoo require it
//     of bulk senders; a person deserves it from anyone.
//
// The preference is asked at send time, here, through platform.mailPreference
// — the platform keeps them as records. A laptop has no preferences store and
// sends everything, which is what it always did.

import crypto from "node:crypto";
import { platform } from "./platform.ts";
import { installKey, publicUrl } from "./webhook.ts";

export type MailCategory =
  | "security"
  | "invites"
  | "billing"
  | "account"
  | "run-alerts"
  | "approvals"
  | "low-balance"
  | "product-updates";

export interface MailCategoryInfo {
  id: MailCategory;
  label: string;
  /** Required mail cannot be turned off — see `why`. */
  required: boolean;
  /** Can be turned off for one workspace while the rest still send. */
  perWorkspace: boolean;
  /** What it is, for the settings page and `foldrun notifications`. */
  description: string;
  /** For a required category: why it cannot be refused. */
  why?: string;
}

export const MAIL_CATEGORIES: readonly MailCategoryInfo[] = [
  {
    id: "security",
    label: "Security",
    required: true,
    perWorkspace: false,
    description: "Password resets, email confirmations, a login address changed, an account made for you.",
    why: "these are how you get back into your account and how you hear that someone else tried to",
  },
  {
    id: "invites",
    label: "Invites",
    required: true,
    perWorkspace: false,
    description: "An invitation to join an account. Sent once, to an address someone typed.",
    why: "an invite is a one-off message someone asked to send you, not a subscription",
  },
  {
    id: "billing",
    label: "Billing failures",
    required: true,
    perWorkspace: false,
    description: "A payment that failed, and the grace period before runs stop.",
    why: "a failed payment you never hear about is an account that stops working without warning",
  },
  {
    id: "account",
    label: "Account notices",
    required: true,
    perWorkspace: false,
    description: "Something about the account stopped working on its own — a notification webhook switched off after days of failures, a close request.",
    why: "each one is the only message saying a thing you rely on has stopped",
  },
  {
    id: "run-alerts",
    label: "Run alerts",
    required: false,
    perWorkspace: true,
    description: "A run failed, finished, or was blocked; a flow was quarantined, a run passed its SLA, a budget is nearly spent — mail from a workspace's notify: email.",
  },
  {
    id: "approvals",
    label: "Approval requests",
    required: false,
    perWorkspace: true,
    description: "A run is waiting for a person, with approve and reject links. Off means you decide from the dashboard.",
  },
  {
    id: "low-balance",
    label: "Low-balance warnings",
    required: false,
    perWorkspace: false,
    description: "Credits are below the warning level. Runs still stop at $0 whether or not you are told.",
  },
  {
    id: "product-updates",
    label: "Product updates",
    required: false,
    perWorkspace: false,
    description: "What changed in foldrun. Rare.",
  },
];

export function mailCategory(id: string): MailCategoryInfo | null {
  return MAIL_CATEGORIES.find((c) => c.id === id) ?? null;
}

export function isRequiredCategory(id: string): boolean {
  return mailCategory(id)?.required ?? false;
}

// ------------------------------------------------------------ unsubscribe

/** How long a token in a mail keeps working. Long: a person unsubscribes
 *  from a mail they kept, often months later, and an unsubscribe link that
 *  has died is the one that sends them to the spam button instead. */
export const UNSUBSCRIBE_TTL_MS = (Number(process.env.FOLDRUN_UNSUBSCRIBE_TTL_DAYS) || 180) * 86400_000;

export interface UnsubscribeClaim {
  tenant: string;
  email: string;
  category: MailCategory;
  /** The workspace the mail was about, when its category is per workspace. */
  workspace: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const sign = (payload: string) => crypto.createHmac("sha256", installKey()).update(`unsubscribe:${payload}`).digest("base64url").slice(0, 32);

/**
 * `<payload>.<signature>`: the payload is base64url JSON of who, what and
 * until when; the signature is an HMAC under the install key, so the token
 * is derived, never stored, and a key rotation kills every old one.
 */
export function unsubscribeToken(c: Omit<UnsubscribeClaim, "expiresAt"> & { expiresAt?: number }, now = Date.now()): string {
  const claim = {
    t: c.tenant,
    e: c.email.trim().toLowerCase(),
    c: c.category,
    w: c.workspace ?? null,
    x: Math.floor(c.expiresAt ?? now + UNSUBSCRIBE_TTL_MS),
  };
  const payload = b64(JSON.stringify(claim));
  return `${payload}.${sign(payload)}`;
}

/** What a presented token says, or why it says nothing. */
export function readUnsubscribeToken(
  token: string | null | undefined,
  now = Date.now(),
): { claim: UnsubscribeClaim } | { error: string; status: 400 | 401 | 410 } {
  if (!token || typeof token !== "string") return { error: "no token", status: 400 };
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return { error: "invalid token", status: 401 };
  const want = sign(payload);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    return { error: "invalid token", status: 401 };
  }
  let raw: { t?: unknown; e?: unknown; c?: unknown; w?: unknown; x?: unknown };
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "invalid token", status: 401 };
  }
  if (typeof raw.t !== "string" || typeof raw.e !== "string" || typeof raw.c !== "string" || typeof raw.x !== "number") {
    return { error: "invalid token", status: 401 };
  }
  const cat = mailCategory(raw.c);
  if (!cat) return { error: "invalid token", status: 401 };
  if (raw.x < now) return { error: "this unsubscribe link has expired — change what you receive from Profile → Notifications", status: 410 };
  return {
    claim: { tenant: raw.t, email: raw.e, category: cat.id, workspace: typeof raw.w === "string" ? raw.w : null, expiresAt: raw.x },
  };
}

/** The page a person opens, and the URL a mail client POSTs to. Null when
 *  the install does not know its own address — then there is no link. */
export function unsubscribeLinks(claim: Omit<UnsubscribeClaim, "expiresAt">, now = Date.now()): { page: string; oneClick: string } | null {
  const base = publicUrl();
  if (!base) return null;
  const token = encodeURIComponent(unsubscribeToken(claim, now));
  return { page: `${base}/unsubscribe?token=${token}`, oneClick: `${base}/api/unsubscribe?token=${token}` };
}

/** The RFC 8058 pair, for a mail whose category may be turned off. */
export function unsubscribeHeaders(claim: Omit<UnsubscribeClaim, "expiresAt">, now = Date.now()): Record<string, string> {
  const links = unsubscribeLinks(claim, now);
  if (!links) return {};
  return { "List-Unsubscribe": `<${links.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

// ------------------------------------------------------------------- send

export interface MailMessage {
  tenant: string;
  /** The Resend key and sender — platformMail(), accountMail() or notifyMail(). */
  mail: { key: string; from: string };
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  category: MailCategory;
  /** The workspace the mail is about, for per-workspace preferences. */
  workspace?: string | null;
}

export interface MailResult {
  /** True when every recipient who wanted it was handed to the provider —
   *  and when nobody wanted it, which is not a failure. */
  ok: boolean;
  /** The HTTP status of the last send, when one was made. */
  status?: number;
  /** The provider's own words on a refusal, trimmed. */
  error?: string;
  sent: string[];
  /** Recipients who turned this category off. */
  suppressed: string[];
}

const recipients = (to: string | string[]) =>
  (Array.isArray(to) ? to : to.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

/** Does this person take this category of mail? Required mail: always. */
export async function mailWanted(tenant: string, email: string, category: MailCategory, workspace: string | null = null): Promise<boolean> {
  if (isRequiredCategory(category)) return true;
  try {
    return await platform.mailPreference(tenant, email.trim().toLowerCase(), category, workspace);
  } catch (err) {
    // A preferences store that cannot be read sends: a missed alert is
    // worse than one unwanted mail, and the next send asks again.
    console.error(`[foldrun] mail: preference for ${category} unreadable, sending:`, err instanceof Error ? err.message : err);
    return true;
  }
}

/**
 * Send one message, honouring each recipient's preference for its
 * category. Optional mail is sent one recipient at a time so each copy
 * carries that reader's own unsubscribe token; required mail goes as one.
 * Never throws: a mail that fails is an `ok: false` with the reason.
 */
export async function sendMail(m: MailMessage): Promise<MailResult> {
  const all = recipients(m.to);
  const required = isRequiredCategory(m.category);
  const workspace = m.workspace ?? null;
  const sent: string[] = [];
  const suppressed: string[] = [];
  let status: number | undefined;
  let error: string | undefined;

  const post = async (to: string[], headers: Record<string, string>, footer: string) => {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${m.mail.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: m.mail.from,
          to: to.length === 1 ? to[0] : to,
          subject: m.subject,
          text: m.text + footer,
          ...(m.html ? { html: m.html } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      if (!res.ok) {
        error = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300) || `HTTP ${res.status}`;
        return false;
      }
      sent.push(...to);
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return false;
    }
  };

  if (required) {
    if (all.length) await post(all, {}, "");
    return { ok: all.length > 0 && sent.length === all.length, status, error, sent, suppressed };
  }

  for (const to of all) {
    if (!(await mailWanted(m.tenant, to, m.category, workspace))) {
      suppressed.push(to);
      continue;
    }
    const claim = { tenant: m.tenant, email: to, category: m.category, workspace: mailCategory(m.category)?.perWorkspace ? workspace : null };
    const links = unsubscribeLinks(claim);
    const label = mailCategory(m.category)?.label.toLowerCase() ?? m.category;
    const footer = links
      ? `\n\n—\nStop ${label}${claim.workspace ? ` from ${claim.workspace}` : ""}: ${links.page}\n`
      : "";
    await post([to], unsubscribeHeaders(claim), footer);
  }
  const wanted = all.length - suppressed.length;
  return { ok: sent.length === wanted, status, error, sent, suppressed };
}
