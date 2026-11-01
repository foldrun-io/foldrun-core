// private_key_jwt (src/oauth-assertion.ts, RFC 7523): assertions foldrun
// signs verify with the public key and carry the right claims; the verifier
// the MCP server uses refuses every way an assertion can be wrong; and an
// oauth2 secret refreshes against a token endpoint that accepts nothing but
// a valid assertion.
//
//   node --test tests/oauth-assertion.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  generateClientKey, publicJwkOf, signClientAssertion, verifyClientAssertion, assertionKeyProblem, jwkThumbprint, ASSERTION_TYPE,
} from "../src/oauth-assertion.ts";
import { oauthTokenRequest, tokenAuthProblem, parseTokenAuth } from "../src/oauth-token.ts";
import { setOAuth2Secret, resolveSecrets, materializeSecrets } from "../src/secrets.ts";

const AUD = "https://login.example.com/token";
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
const headerOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString("utf8"));

for (const alg of ["ES256", "RS256", "EdDSA"] as const) {
  test(`${alg}: a generated key signs an assertion its public JWK verifies, with iss = sub = client_id, aud, jti, exp ≤ 5 min`, () => {
    const { privateKey, publicJwk } = generateClientKey(alg);
    assert.equal(publicJwk.alg, alg);
    assert.equal(publicJwk.use, "sig");
    assert.equal(publicJwk.d, undefined, "the public JWK holds no private part");
    const jwt = signClientAssertion({ client_id: "cid", client_assertion_key: privateKey }, AUD);
    const h = headerOf(jwt);
    const c = claimsOf(jwt);
    assert.equal(h.alg, alg);
    assert.equal(h.kid, publicJwk.kid, "kid is the JWK thumbprint (RFC 7638)");
    assert.equal(c.iss, "cid");
    assert.equal(c.sub, "cid");
    assert.equal(c.aud, AUD);
    assert.ok(c.exp - c.iat <= 300 && c.exp > c.iat);
    const v = verifyClientAssertion(jwt, { clientId: "cid", audiences: [AUD], keys: [publicJwk] });
    assert.equal(v.jti, c.jti);
    assert.notEqual(claimsOf(signClientAssertion({ client_id: "cid", client_assertion_key: privateKey }, AUD)).jti, c.jti, "a new jti every time");
  });
}

test("a PEM key read from a file and a JWK private key both sign; the thumbprint matches RFC 7638's example", () => {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const jwk = JSON.stringify(pair.privateKey.export({ format: "jwk" }));
  const pub = publicJwkOf(pem);
  for (const key of [pem, jwk]) verifyClientAssertion(signClientAssertion({ client_id: "c", client_assertion_key: key }, AUD), { clientId: "c", audiences: [AUD], keys: [pub] });
  // RFC 7638 §3.1's RSA example.
  const example = { kty: "RSA", e: "AQAB", n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw" };
  assert.equal(jwkThumbprint(example), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
});

test("with a certificate, the header carries x5t and x5t#S256 (Microsoft Entra names keys by them)", async () => {
  // A self-signed certificate made for this test: openssl is on every box this runs on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-cert-"));
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-subj", "/CN=foldrun-test", "-days", "1"], { stdio: "ignore" });
    const key = fs.readFileSync(path.join(dir, "k.pem"), "utf8");
    const cert = fs.readFileSync(path.join(dir, "c.pem"), "utf8");
    assert.equal(assertionKeyProblem({ client_assertion_key: key, client_assertion_cert: cert }), null);
    const h = headerOf(signClientAssertion({ client_id: "c", client_assertion_key: key, client_assertion_cert: cert }, AUD));
    const der = new crypto.X509Certificate(cert).raw;
    assert.equal(h["x5t#S256"], crypto.createHash("sha256").update(der).digest("base64url"));
    assert.equal(h.x5t, crypto.createHash("sha1").update(der).digest("base64url"));
    const other = generateClientKey().privateKey;
    assert.match(assertionKeyProblem({ client_assertion_key: other, client_assertion_cert: cert }) ?? "", /not the certificate of/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the verifier refuses: another key, alg none, HS256, wrong aud, wrong iss, expired, too long-lived, no jti", () => {
  const { privateKey, publicJwk } = generateClientKey();
  const other = generateClientKey().publicJwk;
  const ok = signClientAssertion({ client_id: "cid", client_assertion_key: privateKey }, AUD);
  const check = (jwt: string, o: Partial<Parameters<typeof verifyClientAssertion>[1]> = {}) =>
    () => verifyClientAssertion(jwt, { clientId: "cid", audiences: [AUD], keys: [publicJwk], ...o });
  assert.throws(check(ok, { keys: [{ ...other, kid: publicJwk.kid }] }), /signature does not verify/);
  assert.throws(check(ok, { keys: [other] }), /no key with kid/);
  assert.throws(check(ok, { audiences: ["https://elsewhere.example/token"] }), /not this server/);
  assert.throws(check(ok, { clientId: "someone-else" }), /iss and sub must be the client_id/);
  const forge = (header: object, claims: object, sig = "") =>
    `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;
  const base = claimsOf(ok);
  assert.throws(check(forge({ alg: "none" }, base)), /alg "none" is not accepted/);
  assert.throws(check(forge({ alg: "HS256", kid: publicJwk.kid }, base, "x")), /alg "HS256" is not accepted/);
  const resign = (claims: object) => {
    const key = crypto.createPrivateKey(privateKey);
    const input = `${Buffer.from(JSON.stringify({ alg: "ES256", kid: publicJwk.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${input}.${crypto.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const now = Math.floor(Date.now() / 1000);
  assert.throws(check(resign({ ...base, iat: now - 1000, exp: now - 900 })), /expired/);
  assert.throws(check(resign({ ...base, iat: now, exp: now + 3600 })), /longer than 300 seconds/);
  const { jti: _j, ...noJti } = base;
  assert.throws(check(resign(noJti)), /no jti/);
  assert.doesNotThrow(check(resign({ ...base, aud: [AUD, "https://other"] })), "aud may be an array naming us");
});

test("token_auth private_key_jwt: the form carries the assertion and no secret; a key is required, a secret refused", () => {
  const { privateKey, publicJwk } = generateClientKey();
  assert.equal(parseTokenAuth("jwt"), "private_key_jwt");
  assert.match(tokenAuthProblem({ token_auth: "private_key_jwt" }) ?? "", /needs a client_assertion_key/);
  assert.match(tokenAuthProblem({ token_auth: "private_key_jwt", client_assertion_key: privateKey, client_secret: "s" }) ?? "", /sends no client_secret/);
  assert.match(tokenAuthProblem({ token_auth: "private_key_jwt", client_assertion_key: "not a key" }) ?? "", /not a private key/);
  const r = oauthTokenRequest({ client_id: "cid", token_auth: "private_key_jwt", client_assertion_key: privateKey }, { grant_type: "client_credentials", client_assertion: "smuggled" }, { audience: AUD });
  const form = new URLSearchParams(r.body);
  assert.equal(form.get("client_assertion_type"), ASSERTION_TYPE);
  assert.equal(form.get("client_id"), "cid");
  assert.equal(form.has("client_secret"), false);
  assert.equal(r.headers.authorization, undefined);
  verifyClientAssertion(form.get("client_assertion")!, { clientId: "cid", audiences: [AUD], keys: [publicJwk] });
  assert.throws(() => oauthTokenRequest({ client_id: "cid", token_auth: "private_key_jwt", client_assertion_key: privateKey }, {}), /needs the endpoint/);
});

test("an oauth2 secret with private_key_jwt refreshes (and client credentials work) against an endpoint that takes only valid assertions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pkjwt-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  const { privateKey, publicJwk } = generateClientKey();
  const seenJti = new Set<string>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const tokenUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
      try {
        if (form.has("client_secret")) throw new Error("a secret was sent");
        const v = verifyClientAssertion(form.get("client_assertion") ?? "", { clientId: "cid", audiences: [tokenUrl], keys: [publicJwk] });
        if (seenJti.has(v.jti)) throw new Error("replayed");
        seenJti.add(v.jti);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `at-${form.get("grant_type")}`, expires_in: 3600 }));
      } catch (err) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client", error_description: (err as Error).message }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
  try {
    setOAuth2Secret("acme", "PKJWT", { token_url: url, client_id: "cid", refresh_token: "rt", token_auth: "private_key_jwt", client_assertion_key: privateKey }, "desk");
    setOAuth2Secret("acme", "PKJWT_M2M", { token_url: url, client_id: "cid", grant_type: "client_credentials", token_auth: "private_key_jwt", client_assertion_key: privateKey }, "desk");
    const live = await materializeSecrets(resolveSecrets("acme", ["PKJWT", "PKJWT_M2M"], "desk").env, { tenant: "acme", workspace: "desk" });
    assert.equal(live.PKJWT, "at-refresh_token");
    assert.equal(live.PKJWT_M2M, "at-client_credentials");
    assert.equal(seenJti.size, 2, "each request its own assertion");
  } finally {
    server.close();
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an alg that does not fit the key is refused at setup; a private JWK's own kid is kept (Codex review)", () => {
  const ec = generateClientKey("ES256");
  assert.match(assertionKeyProblem({ client_assertion_key: ec.privateKey, client_assertion_alg: "RS256" }) ?? "", /does not fit this key/);
  const rsa = generateClientKey("RS256");
  assert.equal(assertionKeyProblem({ client_assertion_key: rsa.privateKey, client_assertion_alg: "PS256" }), null, "an RSA key signs PS256 too");
  const ps = signClientAssertion({ client_id: "c", client_assertion_key: rsa.privateKey, client_assertion_alg: "PS256" }, AUD);
  verifyClientAssertion(ps, { clientId: "c", audiences: [AUD], keys: [{ ...rsa.publicJwk, alg: "PS256" }] });
  const jwk = JSON.stringify({ ...(crypto.createPrivateKey(ec.privateKey).export({ format: "jwk" }) as object), kid: "registered-at-okta" });
  assert.equal(headerOf(signClientAssertion({ client_id: "c", client_assertion_key: jwk }, AUD)).kid, "registered-at-okta");
  assert.equal(publicJwkOf(jwk).kid, "registered-at-okta");
});

test("RSA-PSS-only keys are refused at setup; a JWK registered with an alg verifies only that alg; aud is compared exactly (Codex review)", () => {
  const pss = crypto.generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.match(assertionKeyProblem({ client_assertion_key: pss }) ?? "", /RSA-PSS-only key is not supported/);
  const rsa = generateClientKey("RS256");
  const rs = signClientAssertion({ client_id: "c", client_assertion_key: rsa.privateKey }, AUD);
  assert.throws(() => verifyClientAssertion(rs, { clientId: "c", audiences: [AUD], keys: [{ ...rsa.publicJwk, alg: "PS256" }] }), /no key/);
  const slash = signClientAssertion({ client_id: "c", client_assertion_key: rsa.privateKey }, `${AUD}/`);
  assert.throws(() => verifyClientAssertion(slash, { clientId: "c", audiences: [AUD], keys: [rsa.publicJwk] }), /not this server/);
});
