// The consent flow, end to end against a mock provider: start hands out an
// authorize URL carrying a single-use state; the callback trades the code
// for tokens and the vault ends up holding the right kind of secret.
//
//   node --test tests/oauth-connect.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startOAuthConnect, completeOAuthConnect } from "../packages/core/src/oauth-connect.ts";
import { listSecrets, resolveSecrets } from "../packages/core/src/secrets.ts";

function withVault(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-connect-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (err) {
    done();
    throw err;
  }
}

/** A token endpoint that validates the code exchange and can answer with or
 *  without a refresh token. */
function provider(withRefresh: boolean): Promise<{ tokenUrl: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "good-code" && form.get("client_secret") === "shh") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(withRefresh
          ? { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }
          : { access_token: "gh-token" }));
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ tokenUrl: `http://127.0.0.1:${port}/token`, close: () => server.close() });
    });
  });
}

const CONFIG = (tokenUrl: string) => ({
  authorize_url: "https://provider.test/authorize",
  token_url: tokenUrl,
  client_id: "cid",
  client_secret: "shh",
  scopes: "ads.read offline",
  authorize_extra: { access_type: "offline" },
});

const REDIRECT = "http://127.0.0.1:3900/api/oauth/callback";

test("start builds the authorize URL with everything the provider needs", () =>
  withVault(() => {
    const { url, nonce } = startOAuthConnect("acme", "ADS_TOKEN", CONFIG("https://x/token"), REDIRECT, "desk");
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://provider.test/authorize");
    assert.equal(parsed.searchParams.get("client_id"), "cid");
    assert.equal(parsed.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("scope"), "ads.read offline");
    assert.equal(parsed.searchParams.get("access_type"), "offline");
    assert.equal(parsed.searchParams.get("state"), nonce);
  }));

test("the full round trip lands an auto-refreshing secret in the right scope", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT, "desk");
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "oauth2");
      const row = listSecrets("acme", "desk").find((s) => s.name === "ADS_TOKEN");
      assert.equal(row?.kind, "oauth2");
      assert.equal(row?.scope, "workspace");
      const { env } = resolveSecrets("acme", ["ADS_TOKEN"], "desk");
      assert.match(env.ADS_TOKEN, /rt-1/, "the refresh token from the exchange is in the recipe");
    } finally {
      p.close();
    }
  }));

test("a provider without refresh tokens yields a static secret, honestly", () =>
  withVault(async () => {
    const p = await provider(false);
    try {
      const { nonce } = startOAuthConnect("acme", "GH_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "static");
      const { env } = resolveSecrets("acme", ["GH_TOKEN"]);
      assert.equal(env.GH_TOKEN, "gh-token");
      assert.equal(listSecrets("acme").find((s) => s.name === "GH_TOKEN")?.kind, undefined);
    } finally {
      p.close();
    }
  }));

test("a state is single-use, and an unknown one is refused", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      await completeOAuthConnect(nonce, "good-code", REDIRECT);
      await assert.rejects(completeOAuthConnect(nonce, "good-code", REDIRECT), /expired or was already used/);
      await assert.rejects(completeOAuthConnect("a".repeat(48), "good-code", REDIRECT), /expired or was already used/);
      await assert.rejects(completeOAuthConnect("../escape", "good-code", REDIRECT), /malformed/);
    } finally {
      p.close();
    }
  }));

test("a refused exchange reports the provider's reason and stores nothing", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      const { nonce } = startOAuthConnect("acme", "ADS_TOKEN", CONFIG(p.tokenUrl), REDIRECT);
      await assert.rejects(completeOAuthConnect(nonce, "wrong-code", REDIRECT), /invalid_grant/);
      assert.equal(listSecrets("acme").length, 0);
    } finally {
      p.close();
    }
  }));

// ---------------------------------------------------------------- clients

import {
  saveOAuthClient,
  listOAuthClients,
  getOAuthClient,
  deleteOAuthClient,
} from "../packages/core/src/oauth-clients.ts";

test("a saved client round-trips, lists without its secret, and runs the flow", () =>
  withVault(async () => {
    const p = await provider(true);
    try {
      saveOAuthClient("acme", "google-ads", CONFIG(p.tokenUrl));
      const rows = listOAuthClients("acme");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].client_id, "cid");
      assert.ok(!("client_secret" in rows[0]), "the secret never comes back through a list");

      const config = getOAuthClient("acme", "google-ads")!;
      assert.equal(config.client_secret, "shh", "decrypted for the flow, and only there");

      // The whole point of saving: run consent from the stored client.
      const { nonce } = startOAuthConnect("acme", "ADS_TOKEN", config, REDIRECT, "desk");
      const result = await completeOAuthConnect(nonce, "good-code", REDIRECT);
      assert.equal(result.stored, "oauth2");

      assert.ok(deleteOAuthClient("acme", "google-ads"));
      assert.equal(listOAuthClients("acme").length, 0);
      assert.equal(getOAuthClient("acme", "google-ads"), null);
    } finally {
      p.close();
    }
  }));

test("a client is validated on save, not at connect time", () =>
  withVault(() => {
    assert.throws(
      () => saveOAuthClient("acme", "bad", { ...CONFIG("https://x/t"), client_id: "" }),
      /needs client_id/,
    );
    assert.throws(
      () => saveOAuthClient("acme", "Bad Name", CONFIG("https://x/t")),
      /kebab-case/,
    );
  }));
