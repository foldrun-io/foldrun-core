// The one token-request builder and the tolerant response reader
// (src/oauth-token.ts), and an oauth2 secret refreshing through them against
// real local token endpoints: one that takes the client secret only as HTTP
// Basic, one that takes it only in the body (RFC 6749 §2.3.1 lets a server
// do either).
//
//   node --test tests/oauth-token.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  oauthTokenRequest,
  readTokenResponse,
  tokenAuthProblem,
  parseTokenAuth,
} from "../src/oauth-token.ts";
import { setOAuth2Secret, setSecret, resolveSecrets, materializeSecrets } from "../src/secrets.ts";

// ------------------------------------------------------------ the builder

test("client_secret_post (and absent with a secret) puts id and secret in the body", () => {
  for (const token_auth of ["client_secret_post", undefined] as const) {
    const r = oauthTokenRequest({ client_id: "cid", client_secret: "shh", token_auth }, { grant_type: "refresh_token", refresh_token: "rt" });
    const form = new URLSearchParams(r.body);
    assert.equal(form.get("client_id"), "cid");
    assert.equal(form.get("client_secret"), "shh");
    assert.equal(form.get("refresh_token"), "rt");
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers.accept, "application/json", "GitHub answers form-encoded unless asked");
  }
});

test("client_secret_basic form-urlencodes id and secret before base64 (RFC 6749 §2.3.1), body carries neither", () => {
  const r = oauthTokenRequest({ client_id: "my app", client_secret: "p:ss%w+rd", token_auth: "client_secret_basic" }, { grant_type: "authorization_code", code: "c" });
  const form = new URLSearchParams(r.body);
  assert.equal(form.get("client_id"), null, "one authentication method per request");
  assert.equal(form.get("client_secret"), null);
  assert.equal(form.get("code"), "c");
  const decoded = Buffer.from(r.headers.authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
  // Not "my app:p:ss%w+rd": the raw pair breaks on ':' and '%'.
  assert.equal(decoded, "my+app:p%3Ass%25w%2Brd");
  const [id, secret] = decoded.split(":").map((s) => decodeURIComponent(s.replace(/\+/g, " ")));
  assert.deepEqual([id, secret], ["my app", "p:ss%w+rd"]);
});

test("clientIdInBody: Basic still puts client_id in the form (a PAR request)", () => {
  const r = oauthTokenRequest({ client_id: "cid", client_secret: "shh", token_auth: "client_secret_basic" }, { state: "s" }, { clientIdInBody: true });
  assert.equal(new URLSearchParams(r.body).get("client_id"), "cid");
  assert.equal(new URLSearchParams(r.body).has("client_secret"), false);
  assert.match(r.headers.authorization ?? "", /^Basic /);
});

test("none (and absent with no secret) sends the client id alone", () => {
  for (const r of [
    oauthTokenRequest({ client_id: "pub", token_auth: "none" }, { grant_type: "refresh_token", refresh_token: "rt" }),
    oauthTokenRequest({ client_id: "pub", client_secret: "" }, { grant_type: "refresh_token", refresh_token: "rt" }),
  ]) {
    const form = new URLSearchParams(r.body);
    assert.equal(form.get("client_id"), "pub");
    assert.equal(form.has("client_secret"), false);
    assert.equal(r.headers.authorization, undefined);
  }
});

test("a grant's params cannot set the client's identity — an `extra` naming client_secret is dropped", () => {
  const r = oauthTokenRequest({ client_id: "cid", client_secret: "shh", token_auth: "client_secret_basic" }, { grant_type: "client_credentials", client_secret: "leak", client_id: "other", scope: "a b" });
  const form = new URLSearchParams(r.body);
  assert.equal(form.has("client_secret"), false);
  assert.equal(form.has("client_id"), false);
  assert.equal(form.get("scope"), "a b");
});

test("token_auth that cannot work is refused, with the reason", () => {
  assert.match(tokenAuthProblem({ token_auth: "client_secret_basic" }) ?? "", /needs a client_secret/);
  assert.match(tokenAuthProblem({ token_auth: "client_secret_post", client_secret: " " }) ?? "", /public app is token_auth none/);
  assert.match(tokenAuthProblem({ token_auth: "none", client_secret: "shh" }) ?? "", /sends no client_secret/);
  assert.match(tokenAuthProblem({ token_auth: "private_key_jwt", client_secret: "shh" }) ?? "", /must be one of/);
  assert.equal(tokenAuthProblem({ client_secret: "" }), null, "absent is always the old behaviour");
  assert.throws(() => oauthTokenRequest({ client_id: "c", token_auth: "client_secret_basic" }, {}), /needs a client_secret/);
});

test("--token-auth spellings: basic, post, none and the RFC names", () => {
  assert.equal(parseTokenAuth("basic"), "client_secret_basic");
  assert.equal(parseTokenAuth("POST"), "client_secret_post");
  assert.equal(parseTokenAuth("none"), "none");
  assert.equal(parseTokenAuth("client_secret_basic"), "client_secret_basic");
  assert.equal(parseTokenAuth("jwt"), null);
});

// ------------------------------------------------------------ the reader

test("reads a plain JSON answer, keeping the plain fields beside the token (Salesforce instance_url)", () => {
  const r = readTokenResponse(JSON.stringify({
    access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600,
    instance_url: "https://acme.my.salesforce.com", id_token: "jwt", issued_at: "1730000000",
  }), "application/json");
  assert.equal(r.access_token, "at");
  assert.equal(r.refresh_token, "rt");
  assert.equal(r.expires_in, 3600);
  assert.equal(r.fields.instance_url, "https://acme.my.salesforce.com");
  assert.equal(r.fields.issued_at, "1730000000");
  for (const secret of ["access_token", "refresh_token", "id_token"]) assert.equal(r.fields[secret], undefined, `${secret} is never a field`);
});

test("expires_in as a string is a number; a missing token_type is fine", () => {
  const r = readTokenResponse('{"access_token":"at","expires_in":"7200"}');
  assert.equal(r.expires_in, 7200);
  assert.equal(r.token_type, undefined);
  assert.equal(readTokenResponse('{"access_token":"at","expires_in":"soon"}').expires_in, undefined);
});

test("a form-encoded answer (GitHub without Accept) reads the same", () => {
  const r = readTokenResponse("access_token=gho_abc&scope=repo%2Cgist&token_type=bearer", "application/x-www-form-urlencoded; charset=utf-8");
  assert.equal(r.access_token, "gho_abc");
  assert.equal(r.scope, "repo,gist");
  assert.equal(r.token_type, "bearer");
  // GitHub refuses with a 200 and an error field.
  const refused = readTokenResponse("error=bad_verification_code&error_description=The+code+passed+is+incorrect", "application/x-www-form-urlencoded");
  assert.equal(refused.error, "bad_verification_code");
  assert.equal(refused.error_description, "The code passed is incorrect");
  assert.equal(refused.access_token, undefined);
});

test("Slack: a user token alone is read from authed_user, with its refresh token and expiry", () => {
  const r = readTokenResponse(JSON.stringify({
    ok: true, app_id: "A1", team: { id: "T1", name: "Acme" },
    authed_user: { id: "U1", scope: "search:read", access_token: "xoxp-1", token_type: "user", refresh_token: "xoxe-1", expires_in: 43200 },
  }));
  assert.equal(r.access_token, "xoxp-1");
  assert.equal(r.refresh_token, "xoxe-1");
  assert.equal(r.expires_in, 43200);
  assert.equal(r.scope, "search:read");
  assert.equal(r.token_type, "user");
  assert.equal(r.fields.app_id, "A1");
});

test("Slack: a bot token at the top level wins over the nested user token", () => {
  const r = readTokenResponse(JSON.stringify({ ok: true, access_token: "xoxb-1", token_type: "bot", authed_user: { access_token: "xoxp-1" } }));
  assert.equal(r.access_token, "xoxb-1");
});

test("Slack's ok:false refusal is an error even with a 200", () => {
  const r = readTokenResponse(JSON.stringify({ ok: false, error: "invalid_code" }));
  assert.equal(r.error, "invalid_code");
  assert.equal(r.access_token, undefined);
  assert.equal(readTokenResponse('{"ok":false}').error, "refused");
});

test("an empty or unreadable body reads as nothing, never throws", () => {
  for (const body of ["", "<html>502</html>", "{not json", "[1,2]"]) {
    const r = readTokenResponse(body, "text/html");
    assert.equal(r.access_token, undefined, body);
    assert.deepEqual(r.fields, {});
  }
});

// ------------------------------------------------------------ refresh, end to end

function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-oauth-token-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  return body().finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

/**
 * A token endpoint that accepts the client ("cid" / "s:cr%t") one way only:
 * `basic` refuses a body secret and wants the Basic header; `body` refuses
 * the header. It answers like the providers that do it: Notion with no
 * expires_in, the body one with expires_in as a string.
 */
function strictServer(accepts: "basic" | "body"): Promise<{ url: string; seen: { auth?: string; form: URLSearchParams }[]; close: () => void }> {
  const seen: { auth?: string; form: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const form = new URLSearchParams(raw);
      seen.push({ auth: req.headers.authorization, form });
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":").map((s) => decodeURIComponent(s.replace(/\+/g, " ")))
        : null;
      const ok = accepts === "basic"
        ? basic?.[0] === "cid" && basic?.[1] === "s:cr%t" && !form.has("client_secret")
        : !req.headers.authorization && form.get("client_id") === "cid" && form.get("client_secret") === "s:cr%t";
      if (!ok || form.get("refresh_token") !== "rt") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client", error_description: `this server takes the secret as ${accepts}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(accepts === "basic"
        ? { access_token: `basic-${seen.length}`, token_type: "bearer", workspace_name: "Acme" }
        : { access_token: `body-${seen.length}`, expires_in: "3600" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}/token`, seen, close: () => server.close() });
  }));
}

test("a Basic-only token endpoint: client_secret_basic refreshes, the body is refused", () =>
  withVault(async () => {
    const t = await strictServer("basic");
    try {
      setOAuth2Secret("acme", "NOTION", { token_url: t.url, client_id: "cid", client_secret: "s:cr%t", refresh_token: "rt", token_auth: "client_secret_basic" });
      const live = await materializeSecrets(resolveSecrets("acme", ["NOTION"]).env);
      assert.equal(live.NOTION, "basic-1", "no expires_in is fine");

      setOAuth2Secret("acme", "NOTION_OLD", { token_url: t.url, client_id: "cid", client_secret: "s:cr%t", refresh_token: "rt" });
      await assert.rejects(materializeSecrets(resolveSecrets("acme", ["NOTION_OLD"]).env), /NOTION_OLD.*takes the secret as basic/s);
    } finally {
      t.close();
    }
  }));

test("a body-only token endpoint: an existing secret (no token_auth) refreshes unchanged; Basic is refused", () =>
  withVault(async () => {
    const t = await strictServer("body");
    try {
      // Stored the way every secret before 1 Nov 2026 was: no token_auth.
      setSecret("acme", "LEGACY", "@oauth2 " + JSON.stringify({ token_url: t.url, client_id: "cid", client_secret: "s:cr%t", refresh_token: "rt" }), undefined, "oauth2");
      const live = await materializeSecrets(resolveSecrets("acme", ["LEGACY"]).env);
      assert.equal(live.LEGACY, "body-1", "expires_in as a string is read");

      setOAuth2Secret("acme", "WRONG", { token_url: t.url, client_id: "cid", client_secret: "s:cr%t", refresh_token: "rt", token_auth: "client_secret_basic" });
      await assert.rejects(materializeSecrets(resolveSecrets("acme", ["WRONG"]).env), /takes the secret as body/);
    } finally {
      t.close();
    }
  }));

test("setOAuth2Secret refuses a token_auth that cannot work", () =>
  withVault(async () => {
    assert.throws(
      () => setOAuth2Secret("acme", "X", { token_url: "https://a.example/token", client_id: "c", refresh_token: "r", token_auth: "client_secret_basic" }),
      /client_secret_basic needs a client_secret/,
    );
    assert.throws(
      () => setOAuth2Secret("acme", "X", { token_url: "https://a.example/token", client_id: "c", client_secret: "s", refresh_token: "r", token_auth: "bogus" as never }),
      /must be one of/,
    );
  }));
