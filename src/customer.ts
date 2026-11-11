// An end customer's id (FOL-168, 11 Nov 2026): a partner — one foldrun
// account serving thousands of people of its own — names which of its own
// users a run or a gateway call is for. foldrun then limits and blocks by
// it, so one bad end customer is held alone and the partner's account
// carries on; and the model provider is told the same, as its end-user id,
// so a provider acts on that one user, not the platform's key.
//
// Opaque by contract: the partner maps it to a person, foldrun never does,
// and it must not be personal data (an email, a name). It is not an access
// boundary either: anyone who may start runs in the account may name any
// customer.
//
// To a provider it goes hashed with the account — `fr-` and 32 hex — so two
// partners' `user-1` are never one identity there, and the partner's own id
// never leaves foldrun.

import crypto from "node:crypto";

/** A customer id as a partner writes it: printable, no spaces, 1–128. */
export const CUSTOMER_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

/** Null when the id is fine; otherwise why not. */
export function customerProblem(id: unknown): string | null {
  if (typeof id !== "string") return "customer must be a string";
  if (!CUSTOMER_ID.test(id)) return "customer is 1–128 characters: letters, digits and . _ : @ - (an opaque id, never personal data)";
  return null;
}

/** What a model provider is told for this account's customer: its end-user
 *  id (Anthropic metadata.user_id; OpenAI user / safety_identifier). */
export function providerUserId(tenant: string, customer: string): string {
  return `fr-${crypto.createHash("sha256").update(`${tenant}\u0000${customer}`).digest("hex").slice(0, 32)}`;
}

/** A short, stable key for counters and logs — never the id itself. */
export function customerKey(tenant: string, customer: string): string {
  return crypto.createHash("sha256").update(`customer\u0000${tenant}\u0000${customer}`).digest("hex").slice(0, 24);
}

/**
 * Set the provider's end-user id on a model request body, in whichever shape
 * it is: Anthropic Messages (`metadata.user_id`, other metadata kept),
 * OpenAI Responses (`safety_identifier`), OpenAI Chat Completions (`user`).
 * Returns the body unchanged when it is not JSON or not one of those.
 */
export function withProviderUser(body: Buffer, userId: string, shape: "anthropic" | "responses" | "chat"): Buffer {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  if (shape === "anthropic") {
    const meta = parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? (parsed.metadata as Record<string, unknown>) : {};
    parsed.metadata = { ...meta, user_id: userId };
  } else if (shape === "responses") {
    parsed.safety_identifier = userId;
  } else {
    parsed.user = userId;
  }
  return Buffer.from(JSON.stringify(parsed), "utf8");
}
