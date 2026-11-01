// DPoP (RFC 9449): sender-constrained tokens. A connection made with DPoP
// holds a key of its own; every request to the token endpoint, and every call
// that uses the access token, carries a fresh proof signed with it — so a
// token copied off the wire is useless without the key. Bluesky/atproto and
// Okta's DPoP mode require it.
//
// The proof: header { typ: "dpop+jwt", alg, jwk: the public key }, claims
// { jti, htm, htu (no query or fragment), iat, ath? (SHA-256 of the access
// token, on resource calls), nonce? (when the server asked for one) }.
//
// Where the proofs are made: core's refresh and the platform's code exchange
// (token requests), and the egress proxy (resource calls) — a DPoP-bound
// connection is used through a site binding, where the proxy can sign each
// request; the sandbox never holds the key.

import crypto from "node:crypto";
import { algForKey, readPrivateKey, ASSERTION_ALGS, type AssertionAlg, type Jwk } from "./oauth-assertion.ts";

/** A new DPoP key for a connection (EC P-256, ES256): the private PEM. */
export function generateDpopKey(): string {
  return crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

/** The htu of a request: its URL with no query or fragment (RFC 9449 §4.2). */
export function dpopHtu(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** The ath of an access token: base64url of its SHA-256 (RFC 9449 §4.2). */
export function dpopAth(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("base64url");
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** A DPoP proof for one request. */
export function dpopProof(key: string, req: { htm: string; htu: string; ath?: string; nonce?: string }, nowMs = Date.now()): string {
  const k = readPrivateKey(key);
  const alg: AssertionAlg = algForKey(k);
  if (!(ASSERTION_ALGS as readonly string[]).includes(alg) || alg === "PS256") throw new Error("a DPoP key must be EC P-256/P-384, RSA or Ed25519");
  const pub = crypto.createPublicKey(k).export({ format: "jwk" }) as Jwk;
  const header = { typ: "dpop+jwt", alg, jwk: pub };
  const claims = {
    jti: b64url(crypto.randomBytes(18)),
    htm: req.htm.toUpperCase(),
    htu: dpopHtu(req.htu),
    iat: Math.floor(nowMs / 1000),
    ...(req.ath ? { ath: req.ath } : {}),
    ...(req.nonce ? { nonce: req.nonce } : {}),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const data = Buffer.from(input);
  const sig =
    alg === "ES256" ? crypto.sign("sha256", data, { key: k, dsaEncoding: "ieee-p1363" })
    : alg === "ES384" ? crypto.sign("sha384", data, { key: k, dsaEncoding: "ieee-p1363" })
    : alg === "EdDSA" ? crypto.sign(null, data, k)
    : crypto.sign("sha256", data, k);
  return `${input}.${b64url(sig)}`;
}

/** The JWK thumbprint the server binds a DPoP token to (cnf.jkt). */
export function dpopJkt(key: string): string {
  const pub = crypto.createPublicKey(readPrivateKey(key)).export({ format: "jwk" }) as Jwk;
  const members = pub.kty === "EC" ? { crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y } : pub.kty === "RSA" ? { e: pub.e, kty: pub.kty, n: pub.n } : { crv: pub.crv, kty: pub.kty, x: pub.x };
  return crypto.createHash("sha256").update(JSON.stringify(members)).digest("base64url");
}

// Server-provided nonces (RFC 9449 §8, §9), kept per origin and per DPoP
// key: the last one a server sent to this connection is the one its next
// proof carries — two connections to one server never overwrite each other's
// (a server may issue nonces per client; Codex review).
const nonces = new Map<string, string>();
const nonceKey = (url: string, key: string) => `${new URL(url).origin} ${dpopJkt(key)}`;

/** Remember a DPoP-Nonce a response to this connection carried. */
export function noteDpopNonce(url: string, res: { headers: { get(name: string): string | null } }, key: string): void {
  const n = res.headers.get("dpop-nonce");
  if (n) nonces.set(nonceKey(url, key), n);
}

/** The nonce for this connection's next proof to this URL's server, if any. */
export function dpopNonceFor(url: string, key: string): string | undefined {
  return nonces.get(nonceKey(url, key));
}

/** Whether an answer asks for a (new) nonce: a token endpoint's 400
 *  use_dpop_nonce, or a resource's 401 with it in WWW-Authenticate. */
export function wantsDpopNonce(res: { status: number; headers: { get(name: string): string | null } }, body?: { error?: string }): boolean {
  if (!res.headers.get("dpop-nonce")) return false;
  if (res.status === 400 && body?.error === "use_dpop_nonce") return true;
  return res.status === 401 && /use_dpop_nonce/.test(res.headers.get("www-authenticate") ?? "");
}
