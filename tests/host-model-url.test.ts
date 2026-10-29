// A provider's base_url is a URL the tenant wrote, and the host — an eval's
// judge, a dashboard draft — calls it. FOL-85 put OpenAI-format host calls
// through the guard; an Anthropic-format one handed the URL to the Agent SDK,
// which fetched it itself: no https rule, no private-address check, redirects
// followed (FOL-95). Now every host-side provider call goes through a
// translator on loopback whose upstream request is fetchUntrusted, after the
// platform's check of the URL. Steps resolve their provider elsewhere and are
// exactly as they were.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "host-model-url-"));
process.env.FOLDRUN_DATA = data;
delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;

const { platform, registerPlatform, hostUrlProblem, guardsUntrustedUrls } = await import("../src/platform.ts");
const { accountModelEnv, withModelEnv, anthropicPassthrough, ModelKeyError } = await import("../src/model-env.ts");
const { startTranslator, translatorSpecFor } = await import("../src/translator.ts");
const { agentContext } = await import("../src/runner.ts");

/** As a platform does: fetchUntrusted bound to a guard (here, plain fetch
 *  that remembers it was asked), the rest left alone. Undone after. */
async function guarded<T>(fn: (asked: string[]) => Promise<T>, extra: Parameters<typeof registerPlatform>[0] = {}): Promise<T> {
  const before = { fetchUntrusted: platform.fetchUntrusted, checkUntrustedUrl: platform.checkUntrustedUrl };
  const asked: string[] = [];
  registerPlatform({ fetchUntrusted: (url, init) => (asked.push(url), fetch(url, init)), ...extra });
  try {
    return await fn(asked);
  } finally {
    registerPlatform(before);
  }
}

/** A stand-in model endpoint on loopback: records each request, answers what `reply` says. */
async function endpoint(reply: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      reply(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

function workspace(name: string, provider: string) {
  const ws = path.join(data, "acme", "workspaces", name);
  const agent = path.join(ws, "agents", "writer");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(ws, "AGENTS.md"), `---\nname: ${name}\nprovider:\n${provider}\n---\n`);
  fs.writeFileSync(path.join(agent, "agent.md"), "---\nname: writer\ntools: [files]\n---\n\nYou write.\n");
  return { ws, agent };
}

const hostEnv = () => ({ ANTHROPIC_API_KEY: "sk-platform-key" });

test("a laptop guards nothing and refuses nothing: its own http://localhost model is fine", () => {
  assert.equal(guardsUntrustedUrls(), false);
  assert.equal(hostUrlProblem("http://localhost:11434"), null);
});

test("an install that guards untrusted fetches wants https, and FOLDRUN_EGRESS_ALLOW_PRIVATE lifts it", () =>
  guarded(async () => {
    assert.equal(guardsUntrustedUrls(), true);
    assert.match(hostUrlProblem("http://models.example.com/v1") ?? "", /not https/);
    assert.match(hostUrlProblem("not a url") ?? "", /not a URL/);
    assert.equal(hostUrlProblem("https://api.anthropic.com"), null);
    assert.match((await platform.checkUntrustedUrl("http://10.43.0.1")) ?? "", /not https/, "the seam's default is the same rule");
    process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE = "1";
    try {
      assert.equal(hostUrlProblem("http://smoke-model"), null);
    } finally {
      delete process.env.FOLDRUN_EGRESS_ALLOW_PRIVATE;
    }
  }));

test("model settings resolve to a refusal for a non-https base_url, from the workspace's block", () =>
  guarded(async () => {
    workspace("plain", "  base_url: http://foldrun-postgres:5432\n  format: anthropic\n  token: sk-tenant");
    assert.throws(() => accountModelEnv("acme", "plain", hostEnv), (e: unknown) => e instanceof ModelKeyError && e.status === 422 && /base_url refused/.test(e.message));
    // The OpenAI format too: the rule is about the URL, not the wire.
    workspace("plain-openai", "  base_url: http://169.254.169.254/v1\n  format: openai\n  token: sk-tenant");
    assert.throws(() => accountModelEnv("acme", "plain-openai", hostEnv), /base_url refused/);
  }));

test("an Anthropic-format host call goes through the passthrough: the SDK sees loopback, the endpoint the tenant's key", async () => {
  const up = await endpoint((_req, _body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_123" });
    res.write("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");
    res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });
  try {
    workspace("anth", `  base_url: ${up.url}\n  format: anthropic\n  auth: x-api-key\n  token: sk-tenant-key\n  headers:\n    x-org: acme`);
    const m = accountModelEnv("acme", "anth", hostEnv);
    assert.equal(m.translator, null, "no translator in the shape the assistant reads (it refuses one)");
    const sdkSaw = await withModelEnv(m, async (env) => {
      assert.match(env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.notEqual(env.ANTHROPIC_BASE_URL, up.url);
      assert.notEqual(env.ANTHROPIC_API_KEY, "sk-tenant-key", "the real key never enters the SDK's env");
      const body = JSON.stringify({ model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] });
      const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "anthropic-beta": "x-1", "content-type": "application/json" },
        body,
      });
      return { status: res.status, type: res.headers.get("content-type"), id: res.headers.get("request-id"), text: await res.text(), body };
    });
    assert.equal(sdkSaw.status, 200);
    assert.equal(sdkSaw.type, "text/event-stream");
    assert.equal(sdkSaw.id, "req_123");
    assert.equal(sdkSaw.text, "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "the stream byte for byte");
    const [r] = up.seen;
    assert.equal(r.url, "/v1/messages?beta=true");
    assert.equal(r.body, sdkSaw.body, "the request byte for byte");
    assert.equal(r.headers["x-api-key"], "sk-tenant-key");
    assert.equal(r.headers.authorization, undefined);
    assert.equal(r.headers["anthropic-version"], "2023-06-01");
    assert.equal(r.headers["anthropic-beta"], "x-1");
    assert.equal(r.headers["x-org"], "acme");
  } finally {
    await up.close();
  }
});

test("through the guard: the platform's check refuses before anything is sent, and every byte goes through fetchUntrusted", async () => {
  const up = await endpoint((_req, _body, res) => res.end("{}"));
  try {
    const m = { env: anthropicEnv(up.url), supply: "provider" as const };
    await guarded(
      async () => {
        await assert.rejects(withModelEnv(m, async () => "called"), (e: unknown) => e instanceof ModelKeyError && e.status === 422 && /internal/.test(e.message));
      },
      { checkUntrustedUrl: async () => "127.0.0.1 is a private or internal address" },
    );
    assert.equal(up.seen.length, 0, "nothing reached the endpoint");
    // Allowed by the check: the call is made, and made by fetchUntrusted.
    await guarded(
      async (asked) => {
        await withModelEnv(m, async (env) => {
          await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { "x-api-key": env.ANTHROPIC_API_KEY! }, body: "{}" });
        });
        assert.deepEqual(asked, [`${up.url}/v1/messages`]);
      },
      { checkUntrustedUrl: async () => null },
    );
  } finally {
    await up.close();
  }
});

test("the passthrough never takes the key to another origin, and a bearer key rides as one", async () => {
  const other = await endpoint((_req, _body, res) => res.end("{}"));
  const up = await endpoint((_req, _body, res) => {
    res.writeHead(307, { location: `${other.url}/v1/messages` });
    res.end();
  });
  try {
    const t = await startTranslator(anthropicPassthrough({ ANTHROPIC_BASE_URL: up.url, ANTHROPIC_AUTH_TOKEN: "sk-bearer", ANTHROPIC_API_KEY: "" })!);
    try {
      const res = await fetch(`${t.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": t.key }, body: "{}" });
      assert.notEqual(res.status, 200);
      await res.text();
    } finally {
      await t.close();
    }
    assert.equal(up.seen[0].headers.authorization, "Bearer sk-bearer");
    assert.equal(up.seen[0].headers["x-api-key"], undefined);
    assert.equal(other.seen.length, 0, "the redirect to another origin was not followed");
  } finally {
    await up.close();
    await other.close();
  }
});

test("a provider's own credential header wins, in any case, and is sent once (Codex review)", async () => {
  const up = await endpoint((_req, _body, res) => res.end("{}"));
  try {
    const call = async (env: Record<string, string>) => {
      const t = await startTranslator(anthropicPassthrough({ ANTHROPIC_BASE_URL: up.url, ...env })!);
      try {
        await (await fetch(`${t.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": t.key }, body: "{}" })).text();
      } finally {
        await t.close();
      }
    };
    // No key slot: the gateway's own Authorization, as written, alone.
    await call({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer gw-123" });
    assert.equal(up.seen[0].headers.authorization, "Bearer gw-123", "not replaced, not joined with an empty bearer");
    // A key AND an Authorization header: the header the provider wrote wins.
    await call({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "sk-token", ANTHROPIC_CUSTOM_HEADERS: "authorization: Bearer gw-456" });
    assert.equal(up.seen[1].headers.authorization, "Bearer gw-456");
    // Different headers live side by side.
    await call({ ANTHROPIC_API_KEY: "sk-key", ANTHROPIC_CUSTOM_HEADERS: "X-Org: acme" });
    assert.equal(up.seen[2].headers["x-api-key"], "sk-key");
    assert.equal(up.seen[2].headers["x-org"], "acme");
  } finally {
    await up.close();
  }
});

test("the platform's own credential goes as it always did: no passthrough, no check", () =>
  guarded(
    async () => {
      const env = { ANTHROPIC_API_KEY: "sk-platform-key" };
      const seen = await withModelEnv({ env, supply: "platform" }, async (e) => e);
      assert.deepEqual(seen, env);
    },
    { checkUntrustedUrl: async () => "should not be asked" },
  ));

test("steps are unchanged: a step's provider is not checked, not proxied on the host, and gets no passthrough", () =>
  guarded(async () => {
    const { agent } = workspace("step", "  base_url: http://models.internal:8080\n  format: anthropic\n  token: sk-step");
    // Under the same guard that refuses this URL for a judge or a draft…
    assert.throws(() => accountModelEnv("acme", "step", hostEnv), /base_url refused/);
    // …a step resolves it exactly as before: the SDK in the sandbox is
    // pointed at it (through the egress proxy there), with no translator.
    const ctx = agentContext(agent, "acme", [], {}, null, true) as { providerEnv: Record<string, string>; translator: unknown };
    assert.equal(ctx.providerEnv.ANTHROPIC_BASE_URL, "http://models.internal:8080");
    assert.equal(ctx.providerEnv.ANTHROPIC_AUTH_TOKEN, "sk-step");
    assert.equal(ctx.translator, null);
    // And the step's translator for an Anthropic block is still none at all;
    // an OpenAI block's is the chat wire, as it was.
    assert.equal(translatorSpecFor({ format: "anthropic", baseUrl: "http://x", token: "t", headers: {} }), null);
    const chat = translatorSpecFor({ format: "openai", baseUrl: "http://x", token: "t", headers: {} });
    assert.equal(chat?.wire, "chat");
    assert.equal(chat?.upstreamAuth, undefined);
  }));

function anthropicEnv(url: string) {
  return { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "sk-tenant-key", ANTHROPIC_AUTH_TOKEN: "" };
}
