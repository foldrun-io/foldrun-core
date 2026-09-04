// The HTTP surface, against a real server.
//
// Every claim here was first checked by hand against a running instance, once,
// and a check made once is a check that stops being true. These are the same
// assertions, kept:
//
//   no key                      → 401
//   a revoked or wrong key      → 401
//   a flow naming a missing agent → 422, with the issue and its line
//   a good deploy               → lands on disk
//   a refused deploy            → the CLI exits 1, so CI fails
//   ?wait=true on a failing run → 500 with the failure
//   ?wait=true on a working one → 200 with the result and the cost
//
// It needs a built dashboard and a port, so it is opt-in and excluded from
// `npm test` (which skips anything named *e2e*):
//
//   npm run api            # everything except the model call
//   FOLDRUN_E2E=1 npm run api   # and the model call too
//
// The last one spends money. Everything above it does not.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "packages/cli/bin/foldrun.mjs");

const enabled = process.env.FOLDRUN_API_E2E === "1";
const opts = { skip: enabled ? false : "set FOLDRUN_API_E2E=1 to run (starts a server)" };
// The one that costs money.
const paid = {
  skip: !enabled
    ? "set FOLDRUN_API_E2E=1 to run"
    : process.env.FOLDRUN_E2E === "1"
      ? false
      : "set FOLDRUN_E2E=1 as well to make a real model call",
};

let server: ChildProcess | null = null;
let base = "";
let token = "";
let data = "";
let source = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/**
 * An API key, written the way the server stores them.
 *
 * Duplicating the record shape rather than importing it: `web/server/auth.ts`
 * resolves through Next's `@/` aliases, which plain node does not honour. The
 * duplication is safe because it cannot rot silently — the first two tests
 * assert that an unauthenticated request is refused and this key is accepted,
 * so a change to how keys are stored fails here loudly.
 */
function writeKey(dataDir: string, tenant = "default"): string {
  const key = `mda_${crypto.randomBytes(24).toString("hex")}`;
  const record = {
    id: crypto.randomBytes(6).toString("hex"),
    hash: crypto.createHash("sha256").update(key).digest("hex"),
    prefix: key.slice(0, 12),
    label: "api-e2e",
    tenant,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "keys.json"), JSON.stringify([record], null, 2), {
    mode: 0o600,
  });
  return key;
}

const api = (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });

const foldrun = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, FOLDRUN_TOKEN: token, FOLDRUN_URL: base },
  });

before(async () => {
  if (!enabled) return;

  if (!fs.existsSync(path.join(ROOT, "web/.next"))) {
    throw new Error("the dashboard is not built — run `cd web && npx next build` first");
  }

  data = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-api-"));
  source = path.join(data, "source");
  token = writeKey(path.join(data, "store"));

  const init = spawnSync(process.execPath, [CLI, "init", source, "--from", "templates/hello"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(init.status, 0, `init failed:\n${init.stderr}`);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: path.join(ROOT, "web"),
    env: {
      ...process.env,
      FOLDRUN_DATA: path.join(data, "store"),
      // The scheduler would fire this workspace's flows underneath the tests.
      FOLDRUN_DISABLE_SCHEDULER: "1",
      // Explicitly NOT set: the point is to test the server refusing.
      FOLDRUN_DEV_NO_AUTH: "",
      // A webhook secret we hold, so the Stripe test below can sign a
      // payment event the way Stripe would and watch it credit the ledger.
      STRIPE_WEBHOOK_SECRET: "whsec_e2e_testing",
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`${base}/api/workspaces`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("the server never came up");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

after(() => {
  server?.kill("SIGTERM");
  if (data) fs.rmSync(data, { recursive: true, force: true });
});

// ── the key is the door ──────────────────────────────────────────────────────

// Fail closed. This was once the other way round — no key meant "trust the
// tenant header" — so an instance that reached the internet before someone
// remembered a flag served every workspace to anyone who asked.
test("no key is refused", opts, async () => {
  const res = await fetch(`${base}/api/workspaces`);
  assert.equal(res.status, 401);
});

test("a wrong key is refused, and says why", opts, async () => {
  const res = await fetch(`${base}/api/workspaces`, {
    headers: { authorization: "Bearer mda_definitely-not-a-key" },
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /invalid API key/);
});

test("a real key is accepted", opts, async () => {
  const res = await api("/api/workspaces");
  assert.equal(res.status, 200, "the key this test wrote was not understood by the server");
});

// ── deploying ────────────────────────────────────────────────────────────────

// The gate that makes this worth being an endpoint rather than a file copy:
// everything is declarative, so the whole workspace is checked before any of
// it is live.
test("a flow naming an agent the deploy does not ship is refused", opts, async () => {
  const res = await api("/api/workspaces/hello/deploy", {
    method: "POST",
    body: JSON.stringify({
      files: [
        { path: "AGENTS.md", content: "---\nname: hello\n---\n\nA desk.\n" },
        { path: "agents/writer/agent.md", content: "---\nname: writer\n---\n\nWrite.\n" },
        { path: "flows/publish.md", content: "---\nname: publish\n---\n\n1. [[ghost]] — vanish\n" },
      ],
    }),
  });

  assert.equal(res.status, 422, "a refusal is not a malformed request");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "did not check out");
  const issue = body.issues.find((i: { message: string }) => /ghost/.test(i.message));
  assert.ok(issue, `no issue named the missing agent: ${JSON.stringify(body.issues)}`);
  assert.match(issue.where, /^flows\/publish\.md:\d+$/, "an issue should carry its line");
});

test("a good deploy lands, and the workspace is really there", opts, async () => {
  const out = foldrun("deploy", source, "--to", "hello");
  assert.equal(out.status, 0, `deploy failed:\n${out.stdout}\n${out.stderr}`);

  const ws = path.join(data, "store/default/workspaces/hello");
  assert.ok(fs.existsSync(path.join(ws, "agents/notetaker/agent.md")), "nothing reached the disk");

  // Deployed over HTTP, so it has to be discoverable over HTTP — this route
  // was POST-only until this test asked for it.
  const res = await api("/api/workspaces/hello/agents");
  assert.equal(res.status, 200, "an agent deployed over the API cannot be listed over it");
  const { agents } = await res.json();
  assert.ok(
    agents.some((a: { name: string }) => a.name === "notetaker"),
    `the server does not list what was just deployed: ${JSON.stringify(agents)}`,
  );

  const flows = await api("/api/workspaces/hello/flows");
  assert.equal(flows.status, 200);
  assert.ok((await flows.json()).flows.some((f: { name: string }) => f.name === "note"));
});

// The CLI is the CI form, and CI only notices an exit code.
test("a refused deploy exits non-zero", opts, () => {
  const broken = path.join(data, "broken");
  fs.cpSync(source, broken, { recursive: true });
  fs.writeFileSync(
    path.join(broken, "flows/note.md"),
    "---\nname: note\ntrigger: manual\n---\n\n1. [[ghost]] — vanish\n",
  );

  const out = foldrun("deploy", broken, "--to", "hello");
  assert.equal(out.status, 1, "a broken workspace must fail the build");
  assert.match(out.stdout, /ghost/, "and say what was wrong");

  // and the good one is still live
  const ws = path.join(data, "store/default/workspaces/hello");
  assert.ok(fs.existsSync(path.join(ws, "agents/notetaker/agent.md")));
});

test("a dry run reports without changing anything", opts, async () => {
  const before = fs.readFileSync(
    path.join(data, "store/default/workspaces/hello/AGENTS.md"),
    "utf8",
  );
  const res = await api("/api/workspaces/hello/deploy", {
    method: "POST",
    body: JSON.stringify({
      dryRun: true,
      files: [
        { path: "AGENTS.md", content: "rewritten\n" },
        { path: "agents/writer/agent.md", content: "---\nname: writer\n---\n\nWrite.\n" },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).applied, false);
  assert.equal(
    fs.readFileSync(path.join(data, "store/default/workspaces/hello/AGENTS.md"), "utf8"),
    before,
    "a dry run wrote to disk",
  );
});

// ── calling an agent ─────────────────────────────────────────────────────────

test("without wait, a run returns a receipt", opts, async () => {
  const res = await api("/api/workspaces/hello/agents/notetaker/run", {
    method: "POST",
    body: JSON.stringify({ task: "nothing, this run is abandoned deliberately" }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.json()).runId, /^run-/);
});

// A failure has to arrive as a failure. Returning 200 with a null result would
// make a broken agent indistinguishable from a quiet one.
test("waiting on a run that fails answers 500, with the failure", opts, async () => {
  // Deploy a flow whose agent is not there — no model call, fails immediately.
  const res = await api("/api/workspaces/broken/deploy", {
    method: "POST",
    body: JSON.stringify({
      files: [
        { path: "AGENTS.md", content: "---\nname: broken\n---\n\nA desk.\n" },
        { path: "agents/writer/agent.md", content: "---\nname: writer\n---\n\nWrite.\n" },
        { path: "flows/go.md", content: "---\nname: go\ntrigger: manual\n---\n\n1. [[writer]] — go\n" },
      ],
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  fs.rmSync(path.join(data, "store/default/workspaces/broken/agents/writer"), {
    recursive: true,
    force: true,
  });

  const run = await api("/api/workspaces/broken/flows/go/run?wait=true&timeout=30", {
    method: "POST",
  });
  assert.equal(run.status, 500);
  const body = await run.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, "failed");
  assert.equal(body.steps[0].status, "failed");
});

test("a bad workspace name is refused rather than reaching the filesystem", opts, async () => {
  const res = await api("/api/workspaces/..%2F..%2Fetc/deploy", {
    method: "POST",
    body: JSON.stringify({ files: [{ path: "AGENTS.md", content: "x" }] }),
  });
  assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
});

// ---------------------------------------------------------------- accounts

// One browser-shaped session, threaded through the auth tests in order:
// signup mints it, everything after uses it.
let cookie = "";

test("the first signup is free, and signs you in", opts, async () => {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "founder@example.test", password: "hunter2hunter2", account: "acme-e2e" }),
  });
  assert.equal(res.status, 200, await res.text());
  const set = res.headers.getSetCookie().find((c) => c.startsWith("foldrun_session="));
  assert.ok(set, "signup must set the session cookie");
  cookie = set!.split(";")[0];
});

test("the second signup needs the install to opt in", opts, async () => {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "second@example.test", password: "hunter2hunter2", account: "second-e2e" }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /closed/);
});

test("a wrong password is one generic refusal", opts, async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "founder@example.test", password: "not-the-password" }),
  });
  assert.equal(res.status, 401);
});

test("the session cookie authenticates the API — same funnel as a key", opts, async () => {
  const res = await fetch(`${base}/api/workspaces`, { headers: { cookie } });
  assert.equal(res.status, 200);
});

test("the dashboard bounces strangers to login", opts, async () => {
  const res = await fetch(`${base}/dashboard`, { redirect: "manual" });
  assert.ok([302, 307, 308].includes(res.status), `expected a redirect, got ${res.status}`);
  assert.match(res.headers.get("location") ?? "", /\/login/);
});

test("the dashboard admits a session, whatever tenant the URL claims", opts, async () => {
  // ?tenant=default would be someone else's account — the proxy overwrites
  // it with the session's own before any page reads it.
  const res = await fetch(`${base}/dashboard?tenant=default`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /acme-e2e/);
});

test("billing reads empty, and a top-up moves the balance", opts, async () => {
  const empty = (await (await fetch(`${base}/api/billing`, { headers: { cookie } })).json()) as {
    enabled: boolean;
    balanceUsd: number;
  };
  assert.equal(empty.enabled, false);
  assert.equal(empty.balanceUsd, 0);

  const topped = (await (
    await fetch(`${base}/api/billing`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ usd: 5, note: "e2e" }),
    })
  ).json()) as { balanceUsd: number };
  assert.equal(topped.balanceUsd, 5);
});

test("a team grows by invite link and refuses to lose its last member", opts, async () => {
  const one = (await (await fetch(`${base}/api/team`, { headers: { cookie } })).json()) as {
    members: { id: string; email: string }[];
  };
  assert.equal(one.members.length, 1);

  const invite = (await (
    await fetch(`${base}/api/team`, { method: "POST", headers: { cookie } })
  ).json()) as { path: string };
  assert.match(invite.path, /^\/signup\?invite=/);

  // The invited signup joins the existing account — no open-signup flag, no
  // account field, whatever the body claims.
  const token = decodeURIComponent(invite.path.split("invite=")[1]);
  const joined = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "teammate@example.test",
      password: "hunter2hunter2",
      account: "ignored-entirely",
      invite: token,
    }),
  });
  const joinedBody = await joined.text();
  assert.equal(joined.status, 200, joinedBody);
  assert.equal((JSON.parse(joinedBody) as { tenant: string }).tenant, "acme-e2e");

  const two = (await (await fetch(`${base}/api/team`, { headers: { cookie } })).json()) as {
    members: { id: string; email: string }[];
  };
  assert.equal(two.members.length, 2);

  // Remove the teammate; then the last member must be irremovable.
  const teammate = two.members.find((m) => m.email === "teammate@example.test")!;
  const removed = await fetch(`${base}/api/team/members/${teammate.id}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(removed.status, 200);
  const self = one.members[0];
  const refused = await fetch(`${base}/api/team/members/${self.id}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(refused.status, 400);
});

test("rotating a webhook changes its URL, twice changes it twice", opts, async () => {
  const first = (await (
    await api("/api/workspaces/hello/hooks/note/rotate", { method: "POST" })
  ).json()) as { path: string };
  const second = (await (
    await api("/api/workspaces/hello/hooks/note/rotate", { method: "POST" })
  ).json()) as { path: string };
  assert.match(first.path, /token=/);
  assert.notEqual(first.path, second.path);
});

test("a signed Stripe payment credits the ledger exactly once", opts, async () => {
  const balance = async () =>
    ((await (await fetch(`${base}/api/billing`, { headers: { cookie } })).json()) as {
      balanceUsd: number;
    }).balanceUsd;

  const event = JSON.stringify({
    id: "evt_e2e_1",
    type: "checkout.session.completed",
    data: {
      object: {
        metadata: { tenant: "acme-e2e" },
        amount_total: 700,
        payment_status: "paid",
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac("sha256", "whsec_e2e_testing").update(`${t}.${event}`).digest("hex");
  const deliver = () =>
    fetch(`${base}/api/billing/stripe`, {
      method: "POST",
      headers: { "stripe-signature": `t=${t},v1=${mac}` },
      body: event,
    });

  const before = await balance();
  assert.equal((await deliver()).status, 200);
  assert.equal(await balance(), before + 7, "the payment landed");
  assert.equal((await deliver()).status, 200, "a Stripe retry is acknowledged");
  assert.equal(await balance(), before + 7, "and credits nothing twice");

  // An unsigned copy of the same event is money nobody paid.
  const forged = await fetch(`${base}/api/billing/stripe`, { method: "POST", body: event });
  assert.equal(forged.status, 401);
  assert.equal(await balance(), before + 7);
});

// ---------------------------------------------------------------- triggers

test("the scheduler's manual tick answers", opts, async () => {
  const res = await api("/api/schedule", { method: "POST" });
  assert.equal(res.status, 200);
});

test("a webhook with a wrong token is refused before anything runs", opts, async () => {
  const res = await fetch(`${base}/api/hooks/default/hello/anything?token=${"0".repeat(32)}`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 401);
});

// The whole point, and the only test here that spends money.
test("waiting on a working agent answers with the result and the cost", paid, async () => {
  const res = await api("/api/workspaces/hello/agents/notetaker/run?wait=true&timeout=180", {
    method: "POST",
    body: JSON.stringify({
      task: "In one short sentence, what is 2+2? Do not write any files.",
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.status, "completed");
  assert.ok(body.result && body.result.trim().length > 0, "a completed run returned no answer");
  assert.match(body.result, /four|4/i);
  assert.ok(typeof body.costUsd === "number", "a caller should be told what the call cost");
});
