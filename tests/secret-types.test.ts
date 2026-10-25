// The credential types beyond a static value and user-consent OAuth:
// machine-to-machine OAuth, signed service accounts, and file secrets.
//
//   node --test tests/secret-types.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  setSecret,
  setServiceAccountSecret,
  setFileSecret,
  setSshSecret,
  setApiSecret,
  resolveSecrets,
  materializeSecrets,
  listSecrets,
  isFileValue,
  fileContent,
} from "../src/secrets.ts";
import { setOAuth2Secret } from "../src/secrets.ts";
import { materializeFileSecrets, cleanupFileSecrets } from "../src/secret-files.ts";

function withVault(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-types-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (e) {
    done();
    throw e;
  }
}

test("machine-to-machine OAuth: no refresh token, client_credentials exchange", () =>
  withVault(async () => {
    let grant = "";
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        grant = new URLSearchParams(b).get("grant_type") ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "m2m-token", expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      setOAuth2Secret("acme", "API", {
        token_url: `http://127.0.0.1:${port}/token`,
        client_id: "cid", client_secret: "shh",
        grant_type: "client_credentials",
      });
      const { env } = resolveSecrets("acme", ["API"]);
      const live = await materializeSecrets(env);
      assert.equal(live.API, "m2m-token");
      assert.equal(grant, "client_credentials");
    } finally { server.close(); }
  }));

test("service account: a signed JWT is exchanged for a token", () =>
  withVault(async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let sawAssertion = false;
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        const form = new URLSearchParams(b);
        sawAssertion = form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" && !!form.get("assertion");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "sa-token", expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      setServiceAccountSecret("acme", "GCP", {
        token_url: `http://127.0.0.1:${port}/token`,
        issuer: "svc@project.iam.gserviceaccount.com",
        private_key: pem,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      });
      assert.equal(listSecrets("acme").find((s) => s.name === "GCP")?.kind, "service-account");
      const { env } = resolveSecrets("acme", ["GCP"]);
      const live = await materializeSecrets(env);
      assert.equal(live.GCP, "sa-token");
      assert.ok(sawAssertion, "the JWT assertion reached the token endpoint");
    } finally { server.close(); }
  }));

test("service account: a non-PEM key is refused on save", () =>
  withVault(() => {
    assert.throws(
      () => setServiceAccountSecret("acme", "GCP", { token_url: "https://x/t", issuer: "a@b", private_key: "not a key", scope: "s" }),
      /PEM/,
    );
  }));

test("file secret: content stored, materialised to a 0600 path, blocked from env", () =>
  withVault(() => {
    setFileSecret("acme", "SSH_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
    assert.equal(listSecrets("acme").find((s) => s.name === "SSH_KEY")?.kind, "file");
    const { env } = resolveSecrets("acme", ["SSH_KEY"]);
    assert.ok(isFileValue(env.SSH_KEY), "still a @file marker before materialisation");
    assert.match(fileContent(env.SSH_KEY), /BEGIN OPENSSH/);

    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      const { env: mat, dir } = materializeFileSecrets(agentDir, env);
      assert.ok(fs.existsSync(mat.SSH_KEY), "the env var now points at a real file");
      assert.match(fs.readFileSync(mat.SSH_KEY, "utf8"), /BEGIN OPENSSH/);
      assert.equal(fs.statSync(mat.SSH_KEY).mode & 0o777, 0o600, "0600, or ssh refuses it");
      cleanupFileSecrets(dir);
      assert.ok(!fs.existsSync(mat.SSH_KEY), "gone after cleanup");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("two steps of one agent get their own secret-files directory; one finishing leaves the other's", () =>
  withVault(() => {
    setFileSecret("acme", "SSH_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
    const { env } = resolveSecrets("acme", ["SSH_KEY"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      // A fan-out: both copies run in the same agent directory at once.
      const a = materializeFileSecrets(agentDir, env);
      const b = materializeFileSecrets(agentDir, env);
      assert.notEqual(a.dir, b.dir);
      assert.notEqual(a.env.SSH_KEY, b.env.SSH_KEY);
      assert.equal(fs.statSync(a.dir!).mode & 0o777, 0o700);
      cleanupFileSecrets(a.dir);
      assert.ok(!fs.existsSync(a.env.SSH_KEY));
      assert.ok(fs.existsSync(b.env.SSH_KEY), "the first to finish no longer deletes the other's key");
      cleanupFileSecrets(b.dir);
      assert.ok(!fs.existsSync(path.join(agentDir, ".secret-files")), "the last one out removes the parent");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("ssh connection with a key: wrapper script + key file + component vars", () =>
  withVault(() => {
    setSshSecret("acme", "PROD_VM", {
      host: "10.0.4.20", port: 2222, user: "deploy",
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    });
    assert.equal(listSecrets("acme").find((s) => s.name === "PROD_VM")?.kind, "ssh");
    const { env } = resolveSecrets("acme", ["PROD_VM"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      const { env: mat } = materializeFileSecrets(agentDir, env);
      const wrapper = fs.readFileSync(mat.PROD_VM, "utf8");
      assert.equal(fs.statSync(mat.PROD_VM).mode & 0o777, 0o700, "wrapper is executable");
      assert.match(wrapper, /exec ssh -i /);
      assert.match(wrapper, /-p 2222/);
      assert.match(wrapper, /'deploy@10\.0\.4\.20' "\$@"/);
      assert.equal(fs.statSync(mat.PROD_VM_KEY).mode & 0o777, 0o600, "key file is 0600");
      assert.match(fs.readFileSync(mat.PROD_VM_KEY, "utf8"), /BEGIN OPENSSH.*\n$/s);
      assert.equal(mat.PROD_VM_HOST, "10.0.4.20");
      assert.equal(mat.PROD_VM_PORT, "2222");
      assert.equal(mat.PROD_VM_USER, "deploy");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("ssh connection with a password: sshpass -f wrapper, password never in env", () =>
  withVault(() => {
    setSshSecret("acme", "OLD_BOX", { host: "box.internal", user: "root", password: "s3cret!" });
    const { env } = resolveSecrets("acme", ["OLD_BOX"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      const { env: mat } = materializeFileSecrets(agentDir, env);
      const wrapper = fs.readFileSync(mat.OLD_BOX, "utf8");
      assert.match(wrapper, /exec sshpass -f /);
      assert.match(wrapper, /-p 22 /);
      assert.match(wrapper, /'root@box\.internal' "\$@"/);
      assert.ok(!wrapper.includes("s3cret!"), "password lives in the 0600 file, not the script");
      assert.ok(!Object.values(mat).includes("s3cret!"), "password is not in any env value");
      const pw = path.join(path.dirname(mat.OLD_BOX), "old_box.pw");
      assert.equal(fs.readFileSync(pw, "utf8"), "s3cret!");
      assert.equal(fs.statSync(pw).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("ssh validation: needs exactly one auth, a clean host, a sane port", () =>
  withVault(() => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----";
    assert.throws(() => setSshSecret("acme", "A", { host: "h", user: "u" }), /private key or a password/);
    assert.throws(() => setSshSecret("acme", "A", { host: "h", user: "u", private_key: key, password: "p" }), /not both/);
    assert.throws(() => setSshSecret("acme", "A", { host: "h x", user: "u", password: "p" }), /host/);
    assert.throws(() => setSshSecret("acme", "A", { host: "h", user: "u", port: 99999, password: "p" }), /port/);
    assert.throws(() => setSshSecret("acme", "A", { host: "h", user: "u", private_key: "not a key" }), /PEM/);
  }));

test("api connection: curl wrapper with headers baked in, base URL prefixes paths", () =>
  withVault(() => {
    setApiSecret("acme", "CF", {
      base_url: "https://api.cloudflare.com/client/v4/",
      headers: { "X-Auth-Email": "a@b.c", "X-Auth-Key": "cf-key-123" },
    });
    assert.equal(listSecrets("acme").find((s) => s.name === "CF")?.kind, "api");
    const { env } = resolveSecrets("acme", ["CF"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      const { env: mat } = materializeFileSecrets(agentDir, env);
      const wrapper = fs.readFileSync(mat.CF, "utf8");
      assert.equal(fs.statSync(mat.CF).mode & 0o777, 0o700);
      assert.match(wrapper, /-H 'X-Auth-Email: a@b\.c'/);
      assert.match(wrapper, /-H 'X-Auth-Key: cf-key-123'/);
      assert.match(wrapper, /'https:\/\/api\.cloudflare\.com\/client\/v4'"\$1"/, "trailing slash trimmed, path prefixed");
      assert.equal(mat.CF_URL, "https://api.cloudflare.com/client/v4");
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("api validation: header names and newline injection are checked", () =>
  withVault(() => {
    assert.throws(() => setApiSecret("acme", "A", { headers: {} }), /at least one header/);
    assert.throws(() => setApiSecret("acme", "A", { headers: { "bad header": "v" } }), /header name/);
    assert.throws(() => setApiSecret("acme", "A", { headers: { "X-K": "v\nInjected: yes" } }), /newlines/);
    assert.throws(() => setApiSecret("acme", "A", { base_url: "ftp://x", headers: { "X-K": "v" } }), /http/);
  }));

test("materialising files leaves non-file secrets untouched", () =>
  withVault(() => {
    setSecret("acme", "PLAIN", "value");
    setFileSecret("acme", "CERT", "cert-bytes");
    const { env } = resolveSecrets("acme", ["PLAIN", "CERT"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    try {
      const { env: mat } = materializeFileSecrets(agentDir, env);
      assert.equal(mat.PLAIN, "value");
      assert.match(mat.CERT, new RegExp(agentDir.replace(/[.\\]/g, "\\$&")));
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }));

test("token caches are per credential: two accounts with the same secret name and issuer/client id never share a token", () =>
  withVault(async () => {
    fs.mkdirSync(path.join(process.env.FOLDRUN_DATA!, "beta/workspaces/desk"), { recursive: true });
    const keyA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyB = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    let calls = 0;
    // Answers with whose credential it saw: the key that verifies the JWT,
    // or the client secret of a client_credentials request.
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        calls++;
        const form = new URLSearchParams(b);
        let who = "unknown";
        const assertion = form.get("assertion");
        if (assertion) {
          const [h, p, sig] = assertion.split(".");
          for (const [label, k] of [["A", keyA], ["B", keyB]] as const) {
            if (crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(k.publicKey, Buffer.from(sig, "base64url"))) who = label;
          }
        } else who = form.get("client_secret") ?? "none";
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: `token-${who}`, expires_in: 3600 }));
        }, 30); // slow enough for two concurrent asks to overlap
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    const sa = (k: typeof keyA) => ({ token_url: url, issuer: "same@project.iam.gserviceaccount.com", private_key: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), scope: "s" });
    try {
      setServiceAccountSecret("acme", "GCP", sa(keyA));
      setServiceAccountSecret("beta", "GCP", sa(keyB));
      setOAuth2Secret("acme", "M2M", { token_url: url, client_id: "same-id", client_secret: "A", grant_type: "client_credentials" });
      setOAuth2Secret("beta", "M2M", { token_url: url, client_id: "same-id", client_secret: "B", grant_type: "client_credentials" });
      const envA = resolveSecrets("acme", ["GCP", "M2M"]).env;
      const envB = resolveSecrets("beta", ["GCP", "M2M"]).env;
      // Sequential: acme fills the cache first; beta must still prove its own key.
      const a = await materializeSecrets(envA, { tenant: "acme" });
      const b = await materializeSecrets(envB, { tenant: "beta" });
      assert.deepEqual([a.GCP, a.M2M], ["token-A", "token-A"]);
      assert.deepEqual([b.GCP, b.M2M], ["token-B", "token-B"]);
      // A repeat is served from cache, per credential.
      const before = calls;
      assert.equal((await materializeSecrets(envA, { tenant: "acme" })).GCP, "token-A");
      assert.equal(calls, before, "the same credential reuses its own cached token");
    } finally { server.close(); }
  }));

test("token caches are per credential under concurrency too, and without an account named", () =>
  withVault(async () => {
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `token-${new URLSearchParams(b).get("client_secret")}`, expires_in: 3600 }));
      }, 40));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      setOAuth2Secret("acme", "XKEY", { token_url: url, client_id: "cid", client_secret: "C1", grant_type: "client_credentials" });
      const env1 = resolveSecrets("acme", ["XKEY"]).env;
      setOAuth2Secret("acme", "XKEY", { token_url: url, client_id: "cid", client_secret: "C2", grant_type: "client_credentials" });
      const env2 = resolveSecrets("acme", ["XKEY"]).env;
      // Two different credentials under one name, asked at the same moment:
      // neither joins the other's in-flight exchange.
      const [one, two] = await Promise.all([materializeSecrets(env1), materializeSecrets(env2)]);
      assert.equal(one.XKEY, "token-C1");
      assert.equal(two.XKEY, "token-C2");
    } finally { server.close(); }
  }));

test("a rotated refresh token is saved where the old one was; a public client refreshes with no secret", () =>
  withVault(async () => {
    const { replaceOAuth2RefreshToken } = await import("../src/secrets.ts");
    let seen: URLSearchParams | null = null;
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen = new URLSearchParams(b);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", refresh_token: `next-${seen.get("refresh_token")}`, expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      setOAuth2Secret("acme", "PUBLIC_APP", { token_url: url, client_id: "pub", refresh_token: "rt-1" }, "desk");
      const env = resolveSecrets("acme", ["PUBLIC_APP"], "desk").env;
      assert.equal((await materializeSecrets(env, { tenant: "acme", workspace: "desk" })).PUBLIC_APP, "at");
      assert.equal(seen!.get("client_secret"), null, "a public client sends no secret");
      const stored = resolveSecrets("acme", ["PUBLIC_APP"], "desk").env.PUBLIC_APP;
      assert.match(stored, /"refresh_token":"next-rt-1"/, "the rotated token replaced the old one in the workspace vault");
      // Compare-and-set: a copy that no longer holds the value used is left alone.
      assert.equal(replaceOAuth2RefreshToken("acme", "PUBLIC_APP", "desk", env.PUBLIC_APP, "stale"), false);
      assert.match(resolveSecrets("acme", ["PUBLIC_APP"], "desk").env.PUBLIC_APP, /next-rt-1/);
    } finally { server.close(); }
    assert.throws(() => setOAuth2Secret("acme", "M2M_NOSECRET", { token_url: url, client_id: "c", grant_type: "client_credentials" }), /client_secret for client_credentials/);
  }));

test("rotation reaches every copy that shared the refresh, and the next run is served from cache", () =>
  withVault(async () => {
    let calls = 0;
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        calls++;
        const rt = new URLSearchParams(b).get("refresh_token");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `at-for-${rt}`, refresh_token: `${rt}-rotated`, expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      const same = { token_url: url, client_id: "cid", client_secret: "s", refresh_token: "shared-rt" };
      setOAuth2Secret("acme", "COPY_ONE", same, "desk");
      setOAuth2Secret("acme", "COPY_TWO", same, "desk");
      const env = resolveSecrets("acme", ["COPY_ONE", "COPY_TWO"], "desk").env;
      const live = await materializeSecrets(env, { tenant: "acme", workspace: "desk" });
      assert.equal(live.COPY_ONE, "at-for-shared-rt");
      assert.equal(live.COPY_TWO, "at-for-shared-rt");
      assert.equal(calls, 1, "one refresh served both copies");
      const after = resolveSecrets("acme", ["COPY_ONE", "COPY_TWO"], "desk").env;
      assert.match(after.COPY_ONE, /shared-rt-rotated/);
      assert.match(after.COPY_TWO, /shared-rt-rotated/, "the copy that joined the refresh took the rotated token too");
      const again = await materializeSecrets(after, { tenant: "acme", workspace: "desk" });
      assert.equal(again.COPY_ONE, "at-for-shared-rt");
      assert.equal(calls, 1, "the rotated config is served from cache — no second refresh");
    } finally { server.close(); }
  }));

test("service account with a subject: the assertion's sub is the user it acts as; without, the account", () =>
  withVault(async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const subs: string[] = [];
    const server = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => {
        const claims = JSON.parse(Buffer.from(new URLSearchParams(b).get("assertion")!.split(".")[1], "base64url").toString());
        subs.push(claims.sub);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `as-${claims.sub}`, expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    try {
      const base = { token_url: url, issuer: "bot@p.iam.gserviceaccount.com", private_key: pem, scope: "s" };
      setServiceAccountSecret("acme", "AS_ITSELF", base);
      setServiceAccountSecret("acme", "AS_ANA", { ...base, subject: " ana@acme.test " });
      setServiceAccountSecret("acme", "AS_BOB", { ...base, subject: "bob@acme.test" });
      const live = await materializeSecrets(resolveSecrets("acme", ["AS_ITSELF", "AS_ANA", "AS_BOB"]).env, { tenant: "acme" });
      assert.deepEqual([live.AS_ITSELF, live.AS_ANA, live.AS_BOB], ["as-bot@p.iam.gserviceaccount.com", "as-ana@acme.test", "as-bob@acme.test"], "each subject its own token, never another's from cache");
      assert.throws(() => setServiceAccountSecret("acme", "BAD", { ...base, subject: "two words" }), /one identifier/);
    } finally { server.close(); }
  }));

test("Basic from a username and password: header built, validated, and every part masked in traces", async () => {
  const { basicAuthorization, setApiSecret: set } = await import("../src/secrets.ts");
  const { redactionsFor } = await import("../src/capture.ts");
  assert.equal(basicAuthorization("aladdin", "open sesame"), "Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ=="); // RFC 7617 §2
  assert.throws(() => basicAuthorization("a:b", "p"), /cannot contain a colon/);
  assert.throws(() => basicAuthorization("a", "p\nq"), /control characters/);
  assert.equal(basicAuthorization("u", "pa:ss").length > 0, true, "a colon in the password is fine");
  await withVault(() => {
    assert.throws(() => set("acme", "B1", { base_url: "http://api.example.com", headers: {}, basic: { username: "u", password: "longpassword1" } }), /https base_url/);
    assert.throws(() => set("acme", "B2", { headers: { authorization: "Bearer x" }, basic: { username: "u", password: "p" } }), /not both/);
    set("acme", "BASIC_API", { base_url: "https://api.example.com", headers: {}, basic: { username: "user", password: "longpassword1" } });
    const raw = resolveSecrets("acme", ["BASIC_API"]).env.BASIC_API;
    assert.doesNotMatch(raw, /"basic"/, "kept only as the header it makes");
    const masks = redactionsFor({ BASIC_API: raw }).map(([v]) => v);
    assert.ok(masks.includes("longpassword1"), "the password is masked");
    assert.ok(masks.includes(Buffer.from("user:longpassword1").toString("base64")), "the encoded credential is masked");
    set("acme", "BASIC_ESC", { base_url: "http://localhost", headers: {}, basic: { username: "u", password: 'long\\pass"word1' } });
    const esc = redactionsFor({ BASIC_ESC: resolveSecrets("acme", ["BASIC_ESC"]).env.BASIC_ESC }).map(([v]) => v);
    assert.ok(esc.includes(JSON.stringify('long\\pass"word1').slice(1, -1)), "the JSON-escaped password is masked too");
  });
});

test("client certificates: the key must match; bound to exact hosts only; files only when exported", { skip: spawnSyncOk("openssl") ? false : "no openssl" }, () =>
  withVault(async () => {
    const { execFileSync } = await import("node:child_process");
    const { setClientCertSecret, setSecretSites } = await import("../src/secrets.ts");
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-cc-"));
    const mk = (n: string) => execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${n}.key`, "-out", `${n}.crt`, "-days", "1", "-subj", `/CN=${n}`], { cwd: d, stdio: "pipe" });
    mk("a"); mk("b");
    const r = (f: string) => fs.readFileSync(path.join(d, f), "utf8");
    assert.throws(() => setClientCertSecret("acme", "MISMATCH", { cert: r("a.crt"), key: r("b.key") }), /does not belong to the certificate/);
    setClientCertSecret("acme", "BANK_CERT", { cert: r("a.crt"), key: r("a.key") });
    assert.throws(() => setSecretSites("acme", "BANK_CERT", ["*.bank.test"]), /exact hosts/);
    assert.deepEqual(setSecretSites("acme", "BANK_CERT", ["api.bank.test"]), ["api.bank.test"]);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-cc-agent-"));
    const held = materializeFileSecrets(agentDir, resolveSecrets("acme", ["BANK_CERT"]).env);
    assert.equal(held.env.BANK_CERT, undefined, "not exported: nothing reaches the sandbox");
    setClientCertSecret("acme", "EXPORTED", { cert: r("a.crt"), key: r("a.key"), export: true });
    const out = materializeFileSecrets(agentDir, resolveSecrets("acme", ["EXPORTED"]).env);
    assert.equal(fs.readFileSync(out.env.EXPORTED_CERT, "utf8"), r("a.crt"));
    assert.equal(fs.readFileSync(out.env.EXPORTED_KEY, "utf8"), r("a.key"));
    assert.equal((fs.statSync(out.env.EXPORTED_KEY).mode & 0o777).toString(8), "600");
    cleanupFileSecrets(out.dir);
    cleanupFileSecrets(held.dir);
    // A plain secret bound to a wildcard cannot be turned into a certificate.
    setSecret("acme", "WILD", "x");
    setSecretSites("acme", "WILD", ["*.bank.test"]);
    assert.throws(() => setClientCertSecret("acme", "WILD", { cert: r("a.crt"), key: r("a.key") }), /unbind the wildcard first/);
    // An exported certificate's key lines and passphrase are masked in traces.
    const { redactionsFor } = await import("../src/capture.ts");
    const masks = redactionsFor({ EXPORTED: resolveSecrets("acme", ["EXPORTED"]).env.EXPORTED }).map(([v]) => v);
    const keyLine = r("a.key").split("\n").find((l) => l.length > 40 && !l.startsWith("-----"))!;
    assert.ok(masks.includes(keyLine), "a line of the private key is masked");
  }));

function spawnSyncOk(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["version"]).status === 0;
  } catch {
    return false;
  }
}
