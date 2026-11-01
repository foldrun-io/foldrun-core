// Signed client assertions (private_key_jwt, RFC 7523 §2.2 and §3; OIDC Core
// §9): a client proves itself at a token endpoint by signing a short JWT with
// its private key instead of sending a secret. What Microsoft Entra
// certificate credentials, Okta and FAPI providers ask for — and what the MCP
// server (foldrun-web server/mcp-oauth.ts) accepts from apps that publish a
// JWKS. Both halves are here so the client and the server read one rule.
//
// The assertion: header { alg, typ: "JWT", kid?, x5t?, x5t#S256? }, claims
// { iss = sub = client_id, aud = the endpoint, jti = random, iat, exp ≤ 5 min }.

import crypto from "node:crypto";

/** A JSON Web Key, as node's crypto reads and writes it. */
export interface Jwk { kty?: string; crv?: string; x?: string; y?: string; n?: string; e?: string; d?: string; kid?: string; alg?: string; use?: string; [k: string]: unknown }

export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** The algorithms foldrun signs and accepts. Never `none`, never HMAC. */
export const ASSERTION_ALGS = ["ES256", "ES384", "RS256", "PS256", "EdDSA"] as const;
export type AssertionAlg = (typeof ASSERTION_ALGS)[number];
/** The longest an assertion may live (proposal: ≤ 5 minutes). */
export const ASSERTION_MAX_SECONDS = 300;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The alg a key signs with when none is said: from its type. */
export function algForKey(key: crypto.KeyObject): AssertionAlg {
  const t = key.asymmetricKeyType;
  if (t === "ec") {
    const crv = key.asymmetricKeyDetails?.namedCurve;
    if (crv === "prime256v1" || crv === "P-256") return "ES256";
    if (crv === "secp384r1" || crv === "P-384") return "ES384";
    throw new Error(`an EC key on ${crv} cannot sign a client assertion — use P-256 or P-384`);
  }
  if (t === "rsa") return "RS256";
  // An RSA-PSS-only key cannot be exported as a JWK (no kid, no public JWK
  // for the provider): refused here, not at the first token exchange. A
  // plain RSA key signs PS256 when client_assertion_alg says so.
  if (t === "rsa-pss") throw new Error("an RSA-PSS-only key is not supported — use a plain RSA key with client_assertion_alg PS256");
  if (t === "ed25519") return "EdDSA";
  throw new Error(`a ${t} key cannot sign a client assertion — use EC P-256, RSA or Ed25519`);
}

/** A private key from PEM (PKCS#8 or traditional) or a private JWK (JSON). */
export function readPrivateKey(material: string): crypto.KeyObject {
  const text = material.trim();
  try {
    if (text.startsWith("{")) return crypto.createPrivateKey({ key: JSON.parse(text), format: "jwk" });
    return crypto.createPrivateKey(text);
  } catch (err) {
    throw new Error(`the client assertion key is not a private key (PEM or JWK): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** RFC 7638 thumbprint of a public JWK — the default `kid`. */
export function jwkThumbprint(jwk: Jwk): string {
  const members: Record<string, unknown> =
    jwk.kty === "EC" ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
    : jwk.kty === "RSA" ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
    : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return b64url(crypto.createHash("sha256").update(JSON.stringify(members)).digest());
}

/** The public JWK a provider needs to register for a private key. */
export function publicJwkOf(privateKey: string, opts: { kid?: string; alg?: AssertionAlg } = {}): Jwk & { kid: string; alg: AssertionAlg; use: "sig" } {
  const key = readPrivateKey(privateKey);
  const pub = crypto.createPublicKey(key).export({ format: "jwk" }) as Jwk;
  const alg = opts.alg ?? algForKey(key);
  return { ...pub, kid: opts.kid ?? ownKid(privateKey) ?? jwkThumbprint(pub), alg, use: "sig" };
}

/** A new signing key for an app: the private PEM to keep sealed, and the
 *  public JWK to register with the provider. EC P-256 (ES256) unless asked. */
export function generateClientKey(alg: "ES256" | "RS256" | "EdDSA" = "ES256"): { privateKey: string; publicJwk: ReturnType<typeof publicJwkOf> } {
  const pair =
    alg === "RS256" ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    : alg === "EdDSA" ? crypto.generateKeyPairSync("ed25519")
    : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKey, publicJwk: publicJwkOf(privateKey, { alg }) };
}

/** Whether a key can sign (and its public half verify) an alg. */
function algFits(alg: AssertionAlg, key: crypto.KeyObject): boolean {
  return algForKey(key) === alg || (alg === "PS256" && key.asymmetricKeyType === "rsa");
}

/** The kid a private JWK carries itself (the provider registered it by it). */
function ownKid(material: string): string | undefined {
  const text = material.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const kid = (JSON.parse(text) as { kid?: unknown }).kid;
    return typeof kid === "string" && kid ? kid : undefined;
  } catch {
    return undefined;
  }
}

function signBytes(alg: AssertionAlg, data: Buffer, key: crypto.KeyObject): Buffer {
  switch (alg) {
    case "ES256": return crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
    case "ES384": return crypto.sign("sha384", data, { key, dsaEncoding: "ieee-p1363" });
    case "RS256": return crypto.sign("sha256", data, key);
    case "PS256": return crypto.sign("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
    case "EdDSA": return crypto.sign(null, data, key);
  }
}

function verifyBytes(alg: AssertionAlg, data: Buffer, sig: Buffer, key: crypto.KeyObject): boolean {
  switch (alg) {
    case "ES256": return crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    case "ES384": return crypto.verify("sha384", data, { key, dsaEncoding: "ieee-p1363" }, sig);
    case "RS256": return crypto.verify("sha256", data, key, sig);
    case "PS256": return crypto.verify("sha256", data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    case "EdDSA": return crypto.verify(null, data, key, sig);
  }
}

export interface AssertionSigner {
  client_id: string;
  /** The private key, PEM or JWK. */
  client_assertion_key: string;
  client_assertion_kid?: string;
  client_assertion_alg?: AssertionAlg;
  /** The certificate for the key (PEM), when the provider identifies keys by
   *  it (Microsoft Entra: x5t / x5t#S256 in the header). */
  client_assertion_cert?: string;
}

/** Sign a client assertion for `audience` (the endpoint it is sent to). */
export function signClientAssertion(signer: AssertionSigner, audience: string, nowMs = Date.now()): string {
  const key = readPrivateKey(signer.client_assertion_key);
  const alg = signer.client_assertion_alg ?? algForKey(key);
  if (!(ASSERTION_ALGS as readonly string[]).includes(alg)) throw new Error(`client_assertion_alg must be one of ${ASSERTION_ALGS.join(", ")}`);
  if (!algFits(alg, key)) throw new Error(`client_assertion_alg ${alg} does not fit this key`);
  const header: Record<string, string> = { alg, typ: "JWT" };
  if (signer.client_assertion_cert) {
    const der = new crypto.X509Certificate(signer.client_assertion_cert).raw;
    header["x5t#S256"] = b64url(crypto.createHash("sha256").update(der).digest());
    header.x5t = b64url(crypto.createHash("sha1").update(der).digest());
  }
  header.kid = signer.client_assertion_kid ?? ownKid(signer.client_assertion_key) ?? jwkThumbprint(crypto.createPublicKey(key).export({ format: "jwk" }) as Jwk);
  const iat = Math.floor(nowMs / 1000);
  const claims = { iss: signer.client_id, sub: signer.client_id, aud: audience, jti: b64url(crypto.randomBytes(18)), iat, nbf: iat, exp: iat + 120 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(signBytes(alg, Buffer.from(input), key))}`;
}

/** Why a signer's key material cannot work, or null. */
export function assertionKeyProblem(signer: { client_assertion_key?: string; client_assertion_alg?: unknown; client_assertion_cert?: string }): string | null {
  if (!signer.client_assertion_key?.trim()) return "token_auth private_key_jwt needs a client_assertion_key (a private key, PEM or JWK)";
  let key: crypto.KeyObject;
  try {
    key = readPrivateKey(signer.client_assertion_key);
    algForKey(key);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (signer.client_assertion_alg !== undefined) {
    const alg = String(signer.client_assertion_alg);
    if (!(ASSERTION_ALGS as readonly string[]).includes(alg)) return `client_assertion_alg must be one of ${ASSERTION_ALGS.join(", ")}`;
    // The alg must be one this key signs: an RSA key also signs PS256.
    if (!algFits(alg as AssertionAlg, key)) return `client_assertion_alg ${alg} does not fit this key (a ${key.asymmetricKeyType} key signs ${algForKey(key)})`;
  }
  if (signer.client_assertion_cert) {
    try {
      const cert = new crypto.X509Certificate(signer.client_assertion_cert);
      if (!cert.checkPrivateKey(key)) return "client_assertion_cert is not the certificate of client_assertion_key";
    } catch {
      return "client_assertion_cert is not a PEM certificate";
    }
  }
  return null;
}

// ------------------------------------------------------------ the server's half

export interface VerifiedAssertion {
  jti: string;
  exp: number;
}

/**
 * Check a client assertion presented to `audiences` (the endpoint URL, and
 * the issuer — RFC 7523 §3 and its successor accept either). `keys` is the
 * client's public JWKS. Throws with why; returns the jti and exp for the
 * caller's replay store, which must refuse a jti it has seen before.
 */
export function verifyClientAssertion(
  assertion: string,
  opts: { clientId: string; audiences: string[]; keys: Jwk[]; nowMs?: number; skewSeconds?: number },
): VerifiedAssertion {
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Error("the client assertion is not a JWT");
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: { iss?: unknown; sub?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; nbf?: unknown; jti?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("the client assertion is not a JWT");
  }
  const alg = header.alg as AssertionAlg;
  if (!(ASSERTION_ALGS as readonly string[]).includes(alg)) throw new Error(`the client assertion's alg ${JSON.stringify(header.alg)} is not accepted (${ASSERTION_ALGS.join(", ")})`);
  // A key registered with an alg signs only that alg (RFC 7517 §4.4).
  const candidates = opts.keys.filter((k) => (!header.kid || k.kid === header.kid) && k.use !== "enc" && (!k.alg || k.alg === alg));
  if (!candidates.length) throw new Error(`no key${header.kid ? ` with kid ${header.kid}` : ""} in the client's JWKS`);
  const input = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  const good = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      // The key's type must be the alg's: an RSA key cannot be presented as ES256.
      if (!algFits(alg, key)) return false;
      return verifyBytes(alg, input, sig, key);
    } catch {
      return false;
    }
  });
  if (!good) throw new Error("the client assertion's signature does not verify against the client's keys");
  if (claims.iss !== opts.clientId || claims.sub !== opts.clientId) throw new Error("the client assertion's iss and sub must be the client_id");
  // Plain string comparison (RFC 7519 §4.1.3): a trailing slash is another audience.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && opts.audiences.includes(a))) throw new Error(`the client assertion is for ${JSON.stringify(claims.aud)}, not this server`);
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const skew = opts.skewSeconds ?? 60;
  if (typeof claims.exp !== "number") throw new Error("the client assertion has no exp");
  if (claims.exp + skew < now) throw new Error("the client assertion has expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new Error("the client assertion is not valid yet");
  const issued = typeof claims.iat === "number" ? claims.iat : now;
  if (claims.exp - issued > ASSERTION_MAX_SECONDS || claims.exp - now > ASSERTION_MAX_SECONDS + skew) throw new Error(`the client assertion lives longer than ${ASSERTION_MAX_SECONDS} seconds`);
  if (typeof claims.jti !== "string" || !claims.jti) throw new Error("the client assertion has no jti");
  return { jti: claims.jti, exp: claims.exp };
}
