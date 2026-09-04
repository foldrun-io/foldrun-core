// OAuth2 secrets: the refresh recipe goes in encrypted, a live access token
// comes out at materialisation — exercised against a real local token
// endpoint, because the exchange, the cache and the error paths are exactly
// where a mock of a mock would lie.
//
//   node --test tests/oauth2.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  setOAuth2Secret,
  resolveSecrets,
  materializeSecrets,
  listSecrets,
  setSecret,
} from "../packages/core/src/secrets.ts";

function withVault(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-oauth-"));
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
    if (out && typeof (out as Promise<void>).then === "function") {
      return (out as Promise<void>).finally(done);
    }
    done();
  } catch (err) {
    done();
    throw err;
  }
}

/** A token endpoint that counts its calls and refuses bad refresh tokens. */
function tokenServer(): Promise<{ url: string; calls: () => number; close: () => void }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      count++;
      const form = new URLSearchParams(body);
      if (form.get("refresh_token") === "good-refresh" && form.get("client_secret") === "shh") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `live-${count}`, expires_in: 3600 }));
      } else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked." }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/token`, calls: () => count, close: () => server.close() });
    });
  });
}

// The https requirement is bypassed in tests via the config shape — so test
// the requirement first, then use http against localhost via setSecret's
// underlying storage by writing the config through the same code path with
// an https-looking wrapper. Simpler: relax is not offered; craft configs
// through setOAuth2Secret only for the https test, and store test configs
// with a direct helper below.
import { getSecret } from "../packages/core/src/secrets.ts";

function storeTestOAuth(tenant: string, name: string, config: object, workspace?: string) {
  // What setOAuth2Secret writes, minus its https guard — tests talk to
  // 127.0.0.1 over http, and a local socket is not a wire.
  setSecret(tenant, name, "@oauth2 " + JSON.stringify(config), workspace, "oauth2");
}

test("an oauth2 secret without https is refused before it is stored", () =>
  withVault(() => {
    assert.throws(
      () =>
        setOAuth2Secret("acme", "ADS_TOKEN", {
          token_url: "http://example.com/token",
          client_id: "x",
          client_secret: "y",
          refresh_token: "z",
        }),
      /https/,
    );
  }));

test("materialising swaps the recipe for a live token; static values pass through", () =>
  withVault(async () => {
    const server = await tokenServer();
    try {
      storeTestOAuth("acme", "ADS_TOKEN", {
        token_url: server.url,
        client_id: "cid",
        client_secret: "shh",
        refresh_token: "good-refresh",
      });
      setSecret("acme", "PLAIN_KEY", "static-value");

      const { env } = resolveSecrets("acme", ["ADS_TOKEN", "PLAIN_KEY"]);
      assert.match(env.ADS_TOKEN, /^@oauth2 /, "resolution alone must not leak an exchange");

      const live = await materializeSecrets(env);
      assert.equal(live.ADS_TOKEN, "live-1");
      assert.equal(live.PLAIN_KEY, "static-value");
    } finally {
      server.close();
    }
  }));

test("tokens are cached until near expiry — twenty steps, one exchange", () =>
  withVault(async () => {
    const server = await tokenServer();
    try {
      storeTestOAuth("acme", "ADS_TOKEN", {
        token_url: server.url,
        client_id: "cid-cache",
        client_secret: "shh",
        refresh_token: "good-refresh",
      });
      const { env } = resolveSecrets("acme", ["ADS_TOKEN"]);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => materializeSecrets(env)),
      );
      assert.ok(results.every((r) => r.ADS_TOKEN === results[0].ADS_TOKEN));
      assert.equal(server.calls(), 1, "the fan-out shared one exchange");
    } finally {
      server.close();
    }
  }));

test("a failed refresh names the secret and carries the provider's reason", () =>
  withVault(async () => {
    const server = await tokenServer();
    try {
      storeTestOAuth("acme", "DEAD_TOKEN", {
        token_url: server.url,
        client_id: "cid",
        client_secret: "shh",
        refresh_token: "revoked",
      });
      const { env } = resolveSecrets("acme", ["DEAD_TOKEN"]);
      await assert.rejects(materializeSecrets(env), /DEAD_TOKEN.*Token has been revoked/s);
    } finally {
      server.close();
    }
  }));

test("the list marks auto-refreshing secrets without decrypting them", () =>
  withVault(() => {
    storeTestOAuth("acme", "ADS_TOKEN", { token_url: "x", client_id: "a", client_secret: "b", refresh_token: "c" });
    setSecret("acme", "PLAIN_KEY", "v");
    const rows = listSecrets("acme");
    assert.equal(rows.find((r) => r.name === "ADS_TOKEN")?.kind, "oauth2");
    assert.equal(rows.find((r) => r.name === "PLAIN_KEY")?.kind, undefined);
  }));
