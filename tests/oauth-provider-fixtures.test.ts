// Provider quirks, as recorded token-endpoint answers replayed through the
// real refresh (materializeSecrets) and code-exchange reader — one fixture
// per quirk the OAuth proposal lists. The shapes are the providers' own
// documented answers (values made up): a provider that changes its answer
// breaks a fixture here before it breaks a desk.
//
//   node --test tests/oauth-provider-fixtures.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { setOAuth2Secret, resolveSecrets, materializeSecrets, getSecret } from "../src/secrets.ts";
import { readTokenResponse, type TokenAuth } from "../src/oauth-token.ts";

interface Fixture {
  provider: string;
  quirk: string;
  token_auth?: TokenAuth;
  /** What the provider answers a refresh with. */
  status?: number;
  contentType: string;
  body: string;
  /** What foldrun must make of it. */
  expect: { token?: string; rotated?: string; error?: RegExp };
}

const FIXTURES: Fixture[] = [
  {
    provider: "Google", quirk: "refresh answers without a new refresh token; scope is a string of URLs",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ access_token: "ya29.a0-google", expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords", token_type: "Bearer" }),
    expect: { token: "ya29.a0-google" },
  },
  {
    provider: "Microsoft", quirk: "rotates the refresh token on every refresh; ext_expires_in beside expires_in",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ token_type: "Bearer", scope: "https://graph.microsoft.com/.default", expires_in: 4810, ext_expires_in: 4810, access_token: "eyJ0eXAi-ms", refresh_token: "ms-rotated-fake" }),
    expect: { token: "eyJ0eXAi-ms", rotated: "ms-rotated-fake" },
  },
  {
    provider: "GitHub", quirk: "form-encoded unless asked for JSON; refuses with a 200 and an error field",
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    body: "access_token=ghu_github&expires_in=28800&refresh_token=ghr_rotated&refresh_token_expires_in=15811200&scope=&token_type=bearer",
    expect: { token: "ghu_github", rotated: "ghr_rotated" },
  },
  {
    provider: "GitHub (refused)", quirk: "a refusal comes back as a 200 with error=…",
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    body: "error=bad_refresh_token&error_description=The+refresh+token+passed+is+incorrect+or+expired.&error_uri=https%3A%2F%2Fdocs.github.com",
    expect: { error: /The refresh token passed is incorrect or expired/ },
  },
  {
    provider: "Slack", quirk: "user-token rotation: the token is nested in authed_user, expires_in a number",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ ok: true, app_id: "A0KRD7HC3", authed_user: { id: "U1234", scope: "search:read", token_type: "user", access_token: "xoxe.xoxp-slack", refresh_token: "xoxe-1-rotated", expires_in: 43200 }, team: { id: "T9TK3CUKW", name: "Acme" } }),
    expect: { token: "xoxe.xoxp-slack", rotated: "xoxe-1-rotated" },
  },
  {
    provider: "Slack (refused)", quirk: "ok:false with a 200",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ ok: false, error: "invalid_refresh_token" }),
    expect: { error: /invalid_refresh_token/ },
  },
  {
    provider: "Notion", quirk: "Basic only; no expires_in; workspace fields beside the token",
    token_auth: "client_secret_basic",
    contentType: "application/json",
    body: JSON.stringify({ access_token: "ntn_notion", token_type: "bearer", refresh_token: "nrt_rotated", bot_id: "b-1", workspace_name: "Acme", workspace_id: "w-1", owner: { type: "user" } }),
    expect: { token: "ntn_notion", rotated: "nrt_rotated" },
  },
  {
    provider: "Atlassian", quirk: "rotating refresh tokens: every refresh returns a new one",
    contentType: "application/json",
    body: JSON.stringify({ access_token: "eyJ-atlassian", refresh_token: "atl-rotated", expires_in: 3600, scope: "read:jira-work offline_access", token_type: "Bearer" }),
    expect: { token: "eyJ-atlassian", rotated: "atl-rotated" },
  },
  {
    provider: "Xero", quirk: "rotating refresh tokens; Basic accepted",
    token_auth: "client_secret_basic",
    contentType: "application/json",
    body: JSON.stringify({ id_token: "eyJ-id", access_token: "eyJ-xero", expires_in: 1800, token_type: "Bearer", refresh_token: "xero-rotated", scope: "openid accounting.transactions offline_access" }),
    expect: { token: "eyJ-xero", rotated: "xero-rotated" },
  },
  {
    provider: "Salesforce", quirk: "no expires_in; instance_url the agent needs; issued_at as a string",
    contentType: "application/json;charset=UTF-8",
    body: JSON.stringify({ access_token: "00D-salesforce", signature: "sig=", scope: "refresh_token api", instance_url: "https://acme.my.salesforce.com", id: "https://login.salesforce.com/id/00D/005", token_type: "Bearer", issued_at: "1730000000000" }),
    expect: { token: "00D-salesforce" },
  },
  {
    provider: "A provider with expires_in as a string", quirk: "\"expires_in\": \"3600\"",
    contentType: "application/json",
    body: JSON.stringify({ access_token: "str-expiry", expires_in: "3600", token_type: "bearer" }),
    expect: { token: "str-expiry" },
  },
];

function withVault(body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-fixtures-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
  return body().finally(() => {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

/** Replays fixture i at /i/token, recording how the client signed in. */
async function replay(): Promise<{ url: string; seen: Map<number, { auth?: string; form: URLSearchParams }>; close: () => void }> {
  const seen = new Map<number, { auth?: string; form: URLSearchParams }>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const i = Number(req.url?.split("/")[1]);
      const f = FIXTURES[i];
      seen.set(i, { auth: req.headers.authorization, form: new URLSearchParams(body) });
      res.writeHead(f?.status ?? 200, { "content-type": f?.contentType ?? "text/plain" });
      res.end(f?.body ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

for (const [i, f] of FIXTURES.entries()) {
  test(`${f.provider}: ${f.quirk}`, () =>
    withVault(async () => {
      const r = await replay();
      try {
        const name = `FIX_${i}`;
        setOAuth2Secret("acme", name, { token_url: `${r.url}/${i}/token`, client_id: "cid", client_secret: "shh", refresh_token: "rt-start", ...(f.token_auth ? { token_auth: f.token_auth } : {}) }, "desk");
        const ctx = { tenant: "acme", workspace: "desk" };
        const env = resolveSecrets("acme", [name], "desk").env;
        if (f.expect.error) {
          await assert.rejects(materializeSecrets(env, ctx), f.expect.error);
          return;
        }
        const live = await materializeSecrets(env, ctx);
        assert.equal(live[name], f.expect.token);
        const sent = r.seen.get(i)!;
        if (f.token_auth === "client_secret_basic") {
          assert.match(sent.auth ?? "", /^Basic /);
          assert.equal(sent.form.has("client_secret"), false);
        } else {
          assert.equal(sent.form.get("client_secret"), "shh");
        }
        const stored = JSON.parse(getSecret("acme", name, "desk")!.value.slice("@oauth2 ".length)) as { refresh_token: string };
        assert.equal(stored.refresh_token, f.expect.rotated ?? "rt-start", f.expect.rotated ? "the rotated refresh token replaced the old one" : "kept");
      } finally {
        r.close();
      }
    }));
}

test("the code exchange's reader keeps the plain fields an agent needs (Salesforce instance_url, Notion workspace) and never a token", () => {
  const sf = readTokenResponse(FIXTURES.find((f) => f.provider === "Salesforce")!.body, "application/json");
  assert.equal(sf.fields.instance_url, "https://acme.my.salesforce.com");
  assert.equal(sf.expires_in, undefined, "no expires_in: the refresh treats it as an hour");
  const notion = readTokenResponse(FIXTURES.find((f) => f.provider === "Notion")!.body, "application/json");
  assert.equal(notion.fields.workspace_name, "Acme");
  assert.equal(notion.fields.owner, undefined, "objects are not fields");
  const xero = readTokenResponse(FIXTURES.find((f) => f.provider === "Xero")!.body, "application/json");
  assert.equal(xero.fields.id_token, undefined, "an id_token is a credential, never a field");
});
