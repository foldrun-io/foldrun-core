// Token exchange as a secret kind (part I, RFC 8693): the subject secret is
// made live, its token traded at the token endpoint for a narrower one, the
// answer cached; a missing subject, or a subject that is itself an exchange,
// is said in words.
//
//   node --test tests/oauth-token-exchange.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setOAuth2Secret, setTokenExchangeSecret, resolveSecrets, materializeSecrets, listSecrets, TOKEN_EXCHANGE_GRANT } from "../src/secrets.ts";

function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tx-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  return body().finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("the subject's live token is traded for a narrower one; the answer is cached; the form carries RFC 8693's fields", () =>
  withVault(async () => {
    const forms: URLSearchParams[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        res.setHeader("content-type", "application/json");
        if (req.url === "/subject-token") { res.end(JSON.stringify({ access_token: "upstream-live", expires_in: 3600 })); return; }
        forms.push(form);
        if (form.get("subject_token") !== "upstream-live") { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
        res.end(JSON.stringify({ access_token: `narrow-${forms.length}`, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      setOAuth2Secret("acme", "UPSTREAM", { token_url: `${base}/subject-token`, client_id: "c", client_secret: "s", grant_type: "client_credentials" }, "desk");
      setTokenExchangeSecret("acme", "DOWNSTREAM", { token_url: `${base}/token`, client_id: "tx", client_secret: "tx-shh", token_auth: "client_secret_basic", subject_secret: "UPSTREAM", audience: "billing-api", scope: "invoices:read" }, "desk");
      assert.equal(listSecrets("acme", "desk").find((s) => s.name === "DOWNSTREAM")?.kind, "token-exchange");
      const env = resolveSecrets("acme", ["UPSTREAM", "DOWNSTREAM"], "desk").env;
      const live = await materializeSecrets(env, { tenant: "acme", workspace: "desk" });
      assert.equal(live.DOWNSTREAM, "narrow-1");
      assert.equal(live.UPSTREAM, "upstream-live");
      const f = forms[0];
      assert.equal(f.get("grant_type"), TOKEN_EXCHANGE_GRANT);
      assert.equal(f.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
      assert.equal(f.get("audience"), "billing-api");
      assert.equal(f.get("scope"), "invoices:read");
      assert.equal(f.has("client_secret"), false, "Basic: the secret is in the header");
      await materializeSecrets(env, { tenant: "acme", workspace: "desk" });
      assert.equal(forms.length, 1, "cached until it expires");
      // Declared alone, the subject is found in the vault at the same scope.
      const alone = await materializeSecrets(resolveSecrets("acme", ["DOWNSTREAM"], "desk").env, { tenant: "acme", workspace: "desk" });
      assert.equal(alone.DOWNSTREAM, "narrow-1");
    } finally {
      server.close();
    }
  }));

test("refused: a missing subject, a subject that is itself an exchange, its own subject, an http token URL", () =>
  withVault(async () => {
    setTokenExchangeSecret("acme", "TX", { token_url: "https://auth.example/token", client_id: "c", client_secret: "s", subject_secret: "NOT_THERE" });
    await assert.rejects(materializeSecrets(resolveSecrets("acme", ["TX"]).env), /its subject NOT_THERE is not set/);
    setTokenExchangeSecret("acme", "TX2", { token_url: "https://auth.example/token", client_id: "c", client_secret: "s", subject_secret: "TX" });
    await assert.rejects(materializeSecrets(resolveSecrets("acme", ["TX2"]).env, { tenant: "acme" }), /is itself a token exchange/);
    const { setFileSecret } = await import("../src/secrets.ts");
    setFileSecret("acme", "A_FILE", "-----BEGIN PRIVATE KEY-----secret");
    setTokenExchangeSecret("acme", "TX3", { token_url: "https://auth.example/token", client_id: "c", client_secret: "s", subject_secret: "A_FILE" });
    await assert.rejects(materializeSecrets(resolveSecrets("acme", ["TX3", "A_FILE"]).env, { tenant: "acme" }), /is a file secret — the subject must be a token/);
    const { setSecret: plain, setSecretSites } = await import("../src/secrets.ts");
    plain("acme", "BOUND_SUBJECT", "bound-token");
    setSecretSites("acme", "BOUND_SUBJECT", ["api.example.com"]);
    setTokenExchangeSecret("acme", "TX4", { token_url: "https://auth.other.example/token", client_id: "c", client_secret: "s", subject_secret: "BOUND_SUBJECT" });
    await assert.rejects(materializeSecrets(resolveSecrets("acme", ["TX4"]).env, { tenant: "acme" }), /bound to api\.example\.com — the exchange's token URL \(auth\.other\.example\) is not one of them/);
    assert.throws(() => setTokenExchangeSecret("acme", "SELF", { token_url: "https://a.example/t", client_id: "c", subject_secret: "SELF" }), /its own subject/);
    assert.throws(() => setTokenExchangeSecret("acme", "X", { token_url: "http://a.example/t", client_id: "c", subject_secret: "SUBJECT" }), /https/);
  }));
