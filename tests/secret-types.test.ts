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
} from "../packages/core/src/secrets.ts";
import { setOAuth2Secret } from "../packages/core/src/secrets.ts";
import { materializeFileSecrets, cleanupFileSecrets } from "../packages/core/src/secret-files.ts";

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
