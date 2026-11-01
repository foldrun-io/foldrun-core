// Device authorization (RFC 8628): connect an account from somewhere with no
// browser of its own — a terminal over ssh, a server. foldrun asks the
// provider for a device code, a person opens the provider's page on any
// device and types the short user code, and foldrun polls the token endpoint
// until they have said yes (or no, or the code ran out). The grant that
// comes back is stored like any other: an oauth2 secret.
//
// One request each, so a caller can poll its own way: the CLI in a loop,
// the platform once per dashboard poll.

import crypto from "node:crypto";
import { oauthTokenRequest, readTokenResponse, type TokenClient, type TokenResponse } from "./oauth-token.ts";

export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** The page with the code already in it, when the provider gives one. */
  verification_uri_complete?: string;
  /** Seconds the codes live. */
  expires_in: number;
  /** Seconds to wait between polls (default 5, RFC 8628 §3.2). */
  interval: number;
  /** PKCE for the device grant: sent with every poll. Keycloak requires it
   *  of an S256 client; a server that does not know it ignores both halves
   *  (found by the conformance suite). Secret: never shown to the person. */
  code_verifier: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** RFC 8628 §3.1–3.2: ask for a device code and a user code. */
export async function startDeviceAuthorization(
  client: TokenClient & { device_url: string; token_url: string; issuer?: string },
  scopes: string,
  fetcher: Fetcher,
  extra: Record<string, string> = {},
): Promise<DeviceStart> {
  // The client authenticates as at the token endpoint (§3.1); a signed
  // assertion's aud is the issuer when known, else the token URL.
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const request = oauthTokenRequest(client, { ...extra, ...(scopes.trim() ? { scope: scopes.trim() } : {}), code_challenge: challenge, code_challenge_method: "S256" }, { clientIdInBody: true, audience: client.issuer ?? client.token_url });
  const res = await fetcher(client.device_url, { method: "POST", headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const why = (body.error_description ?? body.error ?? "no device code in the reply") as string;
    throw new Error(`the provider refused the device authorization (${res.status}): ${why}`);
  }
  // Some providers (Google's older endpoint) say verification_url.
  const uri = (body.verification_uri ?? body.verification_url) as unknown;
  if (typeof uri !== "string" || !/^https?:\/\//.test(uri)) throw new Error("the provider gave no verification_uri to send the person to");
  const num = (v: unknown, d: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: uri,
    ...(typeof body.verification_uri_complete === "string" ? { verification_uri_complete: body.verification_uri_complete } : {}),
    expires_in: num(body.expires_in, 600),
    interval: num(body.interval, 5),
    code_verifier: verifier,
  };
}

/** What one poll came to (RFC 8628 §3.5). */
export type DevicePoll =
  | { status: "approved"; token: TokenResponse }
  | { status: "pending" }
  /** The provider asked for a longer wait: add 5 seconds to the interval. */
  | { status: "slow_down" }
  | { status: "denied"; reason: string }
  | { status: "expired"; reason: string };

/** One token request with the device code. */
export async function pollDeviceToken(
  client: TokenClient & { token_url: string },
  deviceCode: string,
  fetcher: Fetcher,
  codeVerifier?: string,
): Promise<DevicePoll> {
  const request = oauthTokenRequest(client, { grant_type: DEVICE_GRANT, device_code: deviceCode, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }, { audience: client.token_url });
  const res = await fetcher(client.token_url, { method: "POST", headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(15_000) });
  // A body cut off mid-read throws here, so the caller retries it as the
  // transport failure it is — never read as an empty refusal (Codex review).
  const token = readTokenResponse(await res.text(), res.headers.get("content-type") ?? "");
  if (res.ok && token.access_token) return { status: "approved", token };
  switch (token.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down" };
    case "access_denied": return { status: "denied", reason: token.error_description ?? "the person said no" };
    case "expired_token": return { status: "expired", reason: token.error_description ?? "the code ran out before anyone approved it" };
    default:
      throw new Error(`the provider refused the device token request (${res.status}): ${token.error_description ?? token.error ?? "no token in the reply"}`);
  }
}

/** A failure of the wire, not of the provider: fetch's TypeError, an abort
 *  or a timeout. */
function isTransient(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const name = (err as { name?: unknown })?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Poll until approved, denied or expired, honouring interval and slow_down. */
export async function waitForDeviceToken(
  client: TokenClient & { token_url: string },
  start: DeviceStart,
  fetcher: Fetcher,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenResponse> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + start.expires_in * 1000;
  let interval = start.interval;
  // A client that cannot make the request (no key, a bad alg) says so now,
  // not after ten minutes of retries.
  oauthTokenRequest(client, { grant_type: DEVICE_GRANT, device_code: start.device_code }, { audience: client.token_url });
  for (;;) {
    await sleep(interval * 1000);
    if (now() > deadline) throw new Error("the code ran out before anyone approved it — run it again");
    let r: DevicePoll;
    try {
      r = await pollDeviceToken(client, start.device_code, fetcher, start.code_verifier);
    } catch (err) {
      // Only a transport failure — a timeout, a dropped connection — is
      // retried, less often (RFC 8628 §3.5); anything else is final. The
      // backoff never polls faster than the interval the provider set.
      if (!isTransient(err)) throw err;
      interval = interval >= 60 ? interval : Math.min(interval * 2, 60);
      continue;
    }
    if (r.status === "approved") return r.token;
    if (r.status === "slow_down") interval += 5;
    else if (r.status === "denied") throw new Error(`the provider says no: ${r.reason}`);
    else if (r.status === "expired") throw new Error(`${r.reason} — run it again`);
  }
}
