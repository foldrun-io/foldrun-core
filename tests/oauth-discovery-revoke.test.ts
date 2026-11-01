// Discovery from an issuer (src/oauth-discovery.ts, RFC 8414 / OIDC) and
// revocation of an oauth2 secret's tokens (revokeOAuth2Value, RFC 7009),
// against real local servers.
//
//   node --test tests/oauth-discovery-revoke.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { metadataUrls, fetchOAuthMetadata, discoverOAuth, issuerProblem } from "../src/oauth-discovery.ts";
import {
  setOAuth2Secret, setSecret, resolveSecrets, materializeSecrets, oauth2ValueAt, revokeOAuth2Value, oauthGrantSharedElsewhere,
} from "../src/secrets.ts";

function serve(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
  }));
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// ------------------------------------------------------------ discovery

test("metadata URLs: path-insertion for RFC 8414 and OIDC, then OIDC's appended spelling (RFC 8414 §3.1, §5)", () => {
  assert.deepEqual(metadataUrls("https://login.example.com"), [
    "https://login.example.com/.well-known/oauth-authorization-server",
    "https://login.example.com/.well-known/openid-configuration",
  ]);
  assert.deepEqual(metadataUrls("https://kc.example.com/realms/acme"), [
    "https://kc.example.com/.well-known/oauth-authorization-server/realms/acme",
    "https://kc.example.com/.well-known/openid-configuration/realms/acme",
    "https://kc.example.com/realms/acme/.well-known/openid-configuration",
  ]);
  assert.match(issuerProblem("http://evil.example") ?? "", /https/);
  assert.match(issuerProblem("https://a.example/?x=1") ?? "", /no query/);
  assert.equal(issuerProblem("https://a.example/tenant"), null);
});

test("an RFC 8414 server: endpoints, Basic picked when the body is not listed, iss parameter, revocation/device/PAR kept", async () => {
  let base = "";
  const s = await serve((req, _b, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`, device_authorization_endpoint: `${base}/device`,
        pushed_authorization_request_endpoint: `${base}/par`, require_pushed_authorization_requests: true,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "private_key_jwt", "none"],
        code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
      });
    }
    json(res, 404, {});
  });
  base = s.url;
  try {
    const c = await discoverOAuth(base, fetch, { hasSecret: true });
    assert.equal(c.authorize_url, `${base}/authorize`);
    assert.equal(c.token_url, `${base}/token`);
    assert.equal(c.revocation_url, `${base}/revoke`);
    assert.equal(c.device_url, `${base}/device`);
    assert.equal(c.par_url, `${base}/par`);
    assert.equal(c.par_required, true);
    assert.equal(c.iss_parameter, true);
    assert.equal(c.token_auth, "client_secret_basic");
    assert.equal(c.metadata_url, `${base}/.well-known/oauth-authorization-server`);
    // A choice the caller made wins; a public app is none (absent).
    assert.equal((await discoverOAuth(base, fetch, { hasSecret: true, tokenAuth: "client_secret_post" })).token_auth, "client_secret_post");
    assert.equal((await discoverOAuth(base, fetch, { hasSecret: false })).token_auth, undefined);
  } finally {
    s.close();
  }
});

test("an OIDC-only server with a path issuer is found at the appended spelling; the body listed means no token_auth", async () => {
  let issuer = "";
  const s = await serve((req, _b, res) => {
    if (req.url === "/realms/acme/.well-known/openid-configuration") {
      return json(res, 200, { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] });
    }
    json(res, 404, {});
  });
  issuer = `${s.url}/realms/acme`;
  try {
    const c = await discoverOAuth(issuer, fetch, { hasSecret: true });
    assert.equal(c.token_url, `${issuer}/token`);
    assert.equal(c.token_auth, undefined, "client_secret_post listed: the form body, as every secret did");
    assert.equal(c.iss_parameter, false);
    assert.equal(c.revocation_url, undefined);
  } finally {
    s.close();
  }
});

test("refused: a document naming another issuer, http endpoints, PKCE without S256, no metadata at all", async () => {
  let base = "";
  let doc: Record<string, unknown> = {};
  const s = await serve((req, _b, res) => (req.url === "/.well-known/oauth-authorization-server" ? json(res, 200, doc) : json(res, 404, {})));
  base = s.url;
  try {
    doc = { issuer: "https://attacker.example", token_endpoint: `${base}/token`, authorization_endpoint: `${base}/a` };
    await assert.rejects(fetchOAuthMetadata(base, fetch), /names the issuer "https:\/\/attacker\.example".*RFC 8414 §3\.3/);
    doc = { issuer: base, token_endpoint: "http://elsewhere.example/token", authorization_endpoint: `${base}/a` };
    await assert.rejects(discoverOAuth(base, fetch, { hasSecret: true }), /token_endpoint is not an https URL/);
    doc = { issuer: base, token_endpoint: `${base}/t`, authorization_endpoint: `${base}/a`, code_challenge_methods_supported: ["plain"] };
    await assert.rejects(discoverOAuth(base, fetch, { hasSecret: true }), /does not support PKCE S256/);
    assert.equal((await discoverOAuth(base, fetch, { hasSecret: true, pkce: false })).token_url, `${base}/t`, "unless PKCE is off");
    doc = { issuer: base, token_endpoint: `${base}/t` };
    await assert.rejects(discoverOAuth(base, fetch, { hasSecret: true }), /no authorization_endpoint/);
    assert.equal((await discoverOAuth(base, fetch, { hasSecret: true, needsAuthorize: false })).token_url, `${base}/t`);
  } finally {
    s.close();
  }
  await assert.rejects(fetchOAuthMetadata(`${base}/gone`, fetch), /no OAuth metadata for .*tried/);
});

// ------------------------------------------------------------ revocation

function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-revoke-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  return body().finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

/** A provider with a token and a revocation endpoint (Basic only), recording what was revoked. */
async function provider(opts: { refuse?: boolean } = {}) {
  const revoked: { token: string; hint: string | null }[] = [];
  const s = await serve((req, body, res) => {
    const form = new URLSearchParams(body);
    const basicOk = req.headers.authorization === `Basic ${Buffer.from("cid:shh").toString("base64")}`;
    if (req.url === "/token") return json(res, 200, { access_token: "at-live", expires_in: 3600 });
    if (req.url === "/revoke") {
      if (!basicOk) return json(res, 401, { error: "invalid_client" });
      if (opts.refuse) return json(res, 400, { error: "unsupported_token_type", error_description: "nope" });
      revoked.push({ token: form.get("token")!, hint: form.get("token_type_hint") });
      res.writeHead(200);
      return res.end();
    }
    json(res, 404, {});
  });
  return { ...s, revoked };
}

test("revoking: the refresh token, then the cached access token, client authenticated by its token_auth", () =>
  withVault(async () => {
    const p = await provider();
    try {
      const recipe = { token_url: `${p.url}/token`, client_id: "cid", client_secret: "shh", refresh_token: "rt-1", token_auth: "client_secret_basic" as const, revocation_url: `${p.url}/revoke` };
      setOAuth2Secret("acme", "NOTION", recipe, "desk");
      const ctx = { tenant: "acme", workspace: "desk" };
      assert.equal((await materializeSecrets(resolveSecrets("acme", ["NOTION"], "desk").env, ctx)).NOTION, "at-live");
      const value = oauth2ValueAt("acme", "NOTION", "desk")!;
      const r = await revokeOAuth2Value(value, { tenant: "acme", name: "NOTION", workspace: "desk", fetcher: fetch });
      assert.deepEqual(r, { revoked: ["refresh_token", "access_token"] });
      assert.deepEqual(p.revoked, [{ token: "rt-1", hint: "refresh_token" }, { token: "at-live", hint: "access_token" }]);
    } finally {
      p.close();
    }
  }));

test("revoking: skipped with no endpoint, for a grant another secret holds, and for the same grant kept; a refusal is reported", () =>
  withVault(async () => {
    const p = await provider({ refuse: true });
    try {
      const base = { token_url: `${p.url}/token`, client_id: "cid", client_secret: "shh", token_auth: "client_secret_basic" as const };
      setOAuth2Secret("acme", "PLAIN", { ...base, refresh_token: "rt-p" });
      assert.deepEqual(await revokeOAuth2Value(oauth2ValueAt("acme", "PLAIN")!, { tenant: "acme", name: "PLAIN" }), { skipped: "no-revocation-url", revoked: [] });

      setOAuth2Secret("acme", "GRANT_A", { ...base, refresh_token: "rt-shared", revocation_url: `${p.url}/revoke` });
      setOAuth2Secret("acme", "A_COPY", { ...base, refresh_token: "rt-shared", revocation_url: `${p.url}/revoke` }, "desk");
      assert.equal(oauthGrantSharedElsewhere("acme", "GRANT_A", undefined, "rt-shared"), true);
      assert.equal(oauthGrantSharedElsewhere("acme", "GRANT_A", undefined, "rt-other"), false);
      assert.deepEqual(await revokeOAuth2Value(oauth2ValueAt("acme", "GRANT_A")!, { tenant: "acme", name: "GRANT_A" }), { skipped: "shared-grant", revoked: [] });
      assert.deepEqual(await revokeOAuth2Value(oauth2ValueAt("acme", "GRANT_A")!, { replacement: base }), { skipped: "same-app", revoked: [] });
      // Another grant from the same app counts as shared: Google revokes per app.
      setOAuth2Secret("acme", "SAME_APP", { ...base, refresh_token: "rt-other", revocation_url: `${p.url}/revoke` });
      assert.equal(oauthGrantSharedElsewhere("acme", "SAME_APP", undefined, "rt-other", base), true);

      setOAuth2Secret("acme", "GRANT_B", { ...base, token_url: `${p.url}/token-b`, refresh_token: "rt-b", revocation_url: `${p.url}/revoke` });
      const r = await revokeOAuth2Value(oauth2ValueAt("acme", "GRANT_B")!, { tenant: "acme", name: "GRANT_B", fetcher: fetch });
      assert.deepEqual(r.revoked, []);
      assert.match(r.error ?? "", /refused to revoke the refresh token \(400: nope\)/);
    } finally {
      p.close();
    }
  }));

test("oauth2ValueAt reads exactly one scope — a workspace never falls back to the account's copy", () =>
  withVault(async () => {
    setOAuth2Secret("acme", "ONLY_ACCOUNT", { token_url: "https://p.example/t", client_id: "c", client_secret: "s", refresh_token: "r" });
    setSecret("acme", "PLAIN_VALUE", "v");
    assert.ok(oauth2ValueAt("acme", "ONLY_ACCOUNT"));
    assert.equal(oauth2ValueAt("acme", "ONLY_ACCOUNT", "desk"), null);
    assert.equal(oauth2ValueAt("acme", "PLAIN_VALUE"), null, "not an oauth2 secret");
    assert.throws(() => setOAuth2Secret("acme", "X", { token_url: "https://p.example/t", client_id: "c", client_secret: "s", refresh_token: "r", revocation_url: "http://p.example/r" }), /revocation_url must be https/);
  }));

test("loopback is judged on the parsed host: userinfo that looks like localhost is refused (Codex review)", async () => {
  const { isSecureUrl } = await import("../src/oauth-discovery.ts");
  assert.equal(isSecureUrl("http://localhost:80@evil.example/token"), false);
  assert.equal(isSecureUrl("http://127.0.0.1:9@evil.example"), false);
  assert.equal(isSecureUrl("https://user:pw@login.example.com"), false, "no credentials in an endpoint");
  assert.equal(isSecureUrl("http://127.0.0.1:8080/token"), true);
  assert.equal(isSecureUrl("http://[::1]:8080/token"), true);
  assert.equal(isSecureUrl("https://login.example.com/token"), true);
  assert.match(issuerProblem("http://localhost:80@evil.example") ?? "", /https/);
  assert.throws(() => setOAuth2Secret("acme", "X", { token_url: "http://localhost:80@evil.example/t", client_id: "c", client_secret: "s", refresh_token: "r" }), /https/);
});

test("revoking carries on to the access token after the refresh token is refused, and reports the refusal", () =>
  withVault(async () => {
    const seen: string[] = [];
    const s = await serve((req, body, res) => {
      if (req.url === "/token") return json(res, 200, { access_token: "at-x", expires_in: 3600 });
      const hint = new URLSearchParams(body).get("token_type_hint")!;
      seen.push(hint);
      if (hint === "refresh_token") return json(res, 400, { error: "unsupported_token_type" });
      res.writeHead(200);
      res.end();
    });
    try {
      setOAuth2Secret("acme", "PARTIAL", { token_url: `${s.url}/token`, client_id: "c", client_secret: "s", refresh_token: "rt", revocation_url: `${s.url}/revoke` });
      await materializeSecrets(resolveSecrets("acme", ["PARTIAL"]).env, { tenant: "acme" });
      const r = await revokeOAuth2Value(oauth2ValueAt("acme", "PARTIAL")!, { tenant: "acme", name: "PARTIAL", fetcher: fetch });
      assert.deepEqual(seen, ["refresh_token", "access_token"]);
      assert.deepEqual(r.revoked, ["access_token"]);
      assert.match(r.error ?? "", /refused to revoke the refresh token \(400: unsupported_token_type\)/);
    } finally {
      s.close();
    }
  }));

test("discovery refuses a server that takes none of foldrun's ways in, before any consent (Codex review)", async () => {
  const { pickTokenAuth } = await import("../src/oauth-discovery.ts");
  assert.throws(() => pickTokenAuth(["private_key_jwt", "client_secret_jwt"], { hasSecret: true }), /takes none of the ways/);
  assert.deepEqual(pickTokenAuth(["client_secret_basic"], { hasSecret: false }), {}, "Keycloak lists no `none` and takes public clients");
  assert.deepEqual(pickTokenAuth(["private_key_jwt"], { hasSecret: true, tokenAuth: "client_secret_post" }), { token_auth: "client_secret_post" }, "a choice the caller made is kept");
  assert.deepEqual(pickTokenAuth(["none", "client_secret_basic"], { hasSecret: false }), {});
  assert.deepEqual(pickTokenAuth(undefined, { hasSecret: true }), { token_auth: "client_secret_basic" }, "RFC 8414's default");
});

test("the default revocation transport follows no redirect: a 302 to a login page is a failure, not a revocation (Codex review)", () =>
  withVault(async () => {
    const s = await serve((req, _b, res) => {
      if (req.url === "/revoke") { res.writeHead(302, { location: "/login" }); return res.end(); }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    });
    try {
      setOAuth2Secret("acme", "REDIRECTS", { token_url: `${s.url}/token`, client_id: "c", client_secret: "s", refresh_token: "rt", revocation_url: `${s.url}/revoke` });
      const r = await revokeOAuth2Value(oauth2ValueAt("acme", "REDIRECTS")!, { tenant: "acme", name: "REDIRECTS" });
      assert.deepEqual(r.revoked, []);
      assert.match(r.error ?? "", /refused to revoke the refresh token \(302/);
    } finally {
      s.close();
    }
  }));
