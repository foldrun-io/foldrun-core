// Sender-constrained tokens (part H): DPoP proofs (src/oauth-dpop.ts, RFC
// 9449) — their header and claims, and a refresh against a token endpoint
// that demands a proof and then a nonce — and mutual-TLS client auth (RFC
// 8705): a refresh presenting the client certificate to an https token
// endpoint that asks for one.
//
//   node --test tests/oauth-dpop-mtls.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { generateDpopKey, dpopProof, dpopAth, dpopHtu, dpopJkt } from "../src/oauth-dpop.ts";
import { setOAuth2Secret, resolveSecrets, materializeSecrets } from "../src/secrets.ts";
import { tokenAuthProblem, oauthTokenRequest, parseTokenAuth } from "../src/oauth-token.ts";

const part = (jwt: string, i: number) => JSON.parse(Buffer.from(jwt.split(".")[i], "base64url").toString("utf8"));

/** Check a DPoP proof as a server would: signature by the embedded jwk, typ, htm, htu, ath. */
function checkProof(proof: string, want: { htm: string; htu: string; ath?: string; nonce?: string }) {
  const h = part(proof, 0);
  const c = part(proof, 1);
  assert.equal(h.typ, "dpop+jwt");
  assert.equal(h.jwk.d, undefined, "the public key only");
  const key = crypto.createPublicKey({ key: h.jwk, format: "jwk" });
  const [a, b, sig] = proof.split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(`${a}.${b}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")), "signed by the embedded key");
  assert.equal(c.htm, want.htm);
  assert.equal(c.htu, want.htu);
  assert.ok(c.jti && Math.abs(c.iat - Date.now() / 1000) < 60);
  if (want.ath) assert.equal(c.ath, want.ath);
  if (want.nonce) assert.equal(c.nonce, want.nonce);
  return { h, c };
}

function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-dpop-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  return body().finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("a DPoP proof: typ dpop+jwt, the public jwk, htm, htu without query or fragment, ath for a resource call, nonce when given", () => {
  const key = generateDpopKey();
  const p = dpopProof(key, { htm: "get", htu: "https://api.example.com/v1/me?x=1#f", ath: dpopAth("at-1"), nonce: "n-1" });
  const { h } = checkProof(p, { htm: "GET", htu: "https://api.example.com/v1/me", ath: crypto.createHash("sha256").update("at-1").digest("base64url"), nonce: "n-1" });
  assert.equal(dpopHtu("https://a.example/p?q#f"), "https://a.example/p");
  const jkt = crypto.createHash("sha256").update(JSON.stringify({ crv: h.jwk.crv, kty: h.jwk.kty, x: h.jwk.x, y: h.jwk.y })).digest("base64url");
  assert.equal(dpopJkt(key), jkt, "the thumbprint a server binds the token to (cnf.jkt)");
  assert.notEqual(part(dpopProof(key, { htm: "GET", htu: "https://a.example/" }), 1).jti, part(p, 1).jti);
});

test("refresh with DPoP: the token endpoint asks for a nonce once, the proof carries it, the token comes back DPoP-bound", () =>
  withVault(async () => {
    const key = generateDpopKey();
    const proofs: string[] = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const proof = req.headers.dpop as string | undefined;
        res.setHeader("content-type", "application/json");
        if (!proof) { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_dpop_proof" })); return; }
        proofs.push(proof);
        const c = part(proof, 1);
        if (c.nonce !== "server-nonce-1") { res.statusCode = 400; res.setHeader("dpop-nonce", "server-nonce-1"); res.end(JSON.stringify({ error: "use_dpop_nonce" })); return; }
        res.end(JSON.stringify({ access_token: "dpop-bound", token_type: "DPoP", expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      setOAuth2Secret("acme", "DPOP", { token_url: url, client_id: "c", client_secret: "s", refresh_token: "rt", dpop_key: key }, "desk");
      const live = await materializeSecrets(resolveSecrets("acme", ["DPOP"], "desk").env, { tenant: "acme", workspace: "desk" });
      assert.equal(live.DPOP, "dpop-bound");
      assert.equal(proofs.length, 2, "one without a nonce, refused; one with it");
      checkProof(proofs[1], { htm: "POST", htu: url, nonce: "server-nonce-1" });
    } finally {
      server.close();
    }
  }));

test("tls_client_auth (RFC 8705): the refresh presents the client certificate to an https token endpoint; no secret is sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-mtls-"));
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const ossl = (...a: string[]) => execFileSync("openssl", a, { stdio: "ignore" });
    ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "server.key"), "-out", path.join(dir, "server.crt"), "-subj", "/CN=127.0.0.1", "-days", "1");
    ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(dir, "client.key"), "-out", path.join(dir, "client.crt"), "-subj", "/CN=foldrun-client", "-days", "1");
    const clientCert = fs.readFileSync(path.join(dir, "client.crt"), "utf8");
    const clientKey = fs.readFileSync(path.join(dir, "client.key"), "utf8");
    const seen: { cn?: string; form: URLSearchParams }[] = [];
    const server = https.createServer({ key: fs.readFileSync(path.join(dir, "server.key")), cert: fs.readFileSync(path.join(dir, "server.crt")), requestCert: true, rejectUnauthorized: false }, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const peer = (req.socket as import("node:tls").TLSSocket).getPeerCertificate();
        seen.push({ cn: peer?.subject?.CN, form: new URLSearchParams(body) });
        res.setHeader("content-type", "application/json");
        if (peer?.subject?.CN !== "foldrun-client") { res.statusCode = 401; res.end(JSON.stringify({ error: "invalid_client" })); return; }
        res.end(JSON.stringify({ access_token: "cert-bound", expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    // The test server's certificate is self-signed.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      assert.equal(parseTokenAuth("mtls"), "tls_client_auth");
      assert.match(tokenAuthProblem({ token_auth: "tls_client_auth" }) ?? "", /needs tls_client_cert/);
      assert.match(tokenAuthProblem({ token_auth: "tls_client_auth", tls_client_cert: clientCert, tls_client_key: clientKey, client_secret: "s" }) ?? "", /sends no client_secret/);
      assert.equal(new URLSearchParams(oauthTokenRequest({ client_id: "c", token_auth: "tls_client_auth", tls_client_cert: clientCert, tls_client_key: clientKey }, { grant_type: "client_credentials" }).body).get("client_id"), "c");
      await withVault(async () => {
        setOAuth2Secret("acme", "MTLS", { token_url: url, client_id: "c", grant_type: "client_credentials", token_auth: "tls_client_auth", tls_client_cert: clientCert, tls_client_key: clientKey }, "desk");
        const live = await materializeSecrets(resolveSecrets("acme", ["MTLS"], "desk").env, { tenant: "acme", workspace: "desk" });
        assert.equal(live.MTLS, "cert-bound");
      });
      assert.equal(seen[0].cn, "foldrun-client", "the client certificate was presented");
      assert.equal(seen[0].form.has("client_secret"), false);
    } finally {
      server.close();
    }
  } finally {
    if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
