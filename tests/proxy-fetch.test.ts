// FOL-222: a remote MCP server inside the walls is reached only through
// their site proxy. A fake proxy here checks the credential, answers plain
// http by its full URL, and refuses a CONNECT to a site not on its list.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { proxyFetch } from "../src/proxy-fetch.ts";
import { connectMcp } from "../src/engine-mcp.ts";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

async function fakeProxy(allowed: string[]) {
  const seen: Array<{ method: string; target: string; auth: string | undefined }> = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ method: req.method!, target: req.url!, auth: req.headers["proxy-authorization"] });
    if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("srt:tok").toString("base64")}`) return void res.writeHead(407).end();
    const url = new URL(req.url!);
    if (!allowed.includes(url.hostname)) return void res.writeHead(403).end("blocked");
    // Forward it to the site (here, a server on this machine).
    const up = http.request({ host: "127.0.0.1", port: Number(url.port), method: req.method, path: url.pathname + url.search, headers: { ...req.headers, "proxy-authorization": "" } }, (r) => {
      res.writeHead(r.statusCode!, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on("connect", (req, socket) => {
    seen.push({ method: "CONNECT", target: req.url!, auth: req.headers["proxy-authorization"] });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  const port = await listen(proxy);
  return { port, seen, close: () => proxy.close() };
}

test("http goes to the proxy by its full URL, with the proxy's credential; the answer streams back", async () => {
  const site = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-seen-auth": String(req.headers.authorization ?? "") });
      res.end(`${req.method} ${req.url} ${body}`);
    });
  });
  const sitePort = await listen(site);
  const p = await fakeProxy(["localhost"]);
  try {
    const f = proxyFetch({ host: "127.0.0.1", port: p.port, user: "srt", token: "tok" });
    const r = await f(`http://localhost:${sitePort}/mcp?x=1`, { method: "POST", body: "hello", headers: { authorization: "Bearer site" } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "POST /mcp?x=1 hello");
    assert.equal(r.headers.get("x-seen-auth"), "Bearer site", "the site's own header reaches it");
    assert.equal(p.seen[0]!.target, `http://localhost:${sitePort}/mcp?x=1`);
    // Not on the list: the proxy refuses, and the refusal is the answer.
    const blocked = await f(`http://127.0.0.1:${sitePort}/mcp`);
    assert.equal(blocked.status, 403);
    // A wrong credential is refused by the proxy too.
    const wrong = await proxyFetch({ host: "127.0.0.1", port: p.port, user: "srt", token: "nope" })(`http://localhost:${sitePort}/`);
    assert.equal(wrong.status, 407);
  } finally {
    p.close();
    site.close();
  }
});

test("https is a CONNECT tunnel: a site the proxy refuses is an error that names the site and how to allow it", async () => {
  const p = await fakeProxy([]);
  try {
    const f = proxyFetch({ host: "127.0.0.1", port: p.port, user: "srt", token: "tok" });
    await assert.rejects(f("https://mcp.example.com/mcp"), /the sandbox's proxy refused mcp\.example\.com \(403[\s\S]*\/permissions sandbox allow mcp\.example\.com/);
    assert.deepEqual(p.seen.map((s) => [s.method, s.target]), [["CONNECT", "mcp.example.com:443"]]);
    assert.equal(p.seen[0]!.auth, `Basic ${Buffer.from("srt:tok").toString("base64")}`);
  } finally {
    p.close();
  }
});

test("no other way out: a URL with a password, or another scheme, is never sent; a proxy that is not there is an error, not a direct connection", async () => {
  const f = proxyFetch({ host: "127.0.0.1", port: 1, user: "srt", token: "tok" });
  await assert.rejects(f("http://u:p@example.com/"), /credentials|user name or password/);
  await assert.rejects(f("file:///etc/passwd"), /only http and https/);
  await assert.rejects(f("http://example.com/"), /ECONNREFUSED/);
});

test("inside the walls an MCP server over HTTP is connected through the walls' fetch; a sandbox without one refuses it", async () => {
  const signal = new AbortController().signal;
  const base = { launch: async () => ({ line: "", env: {} }) };
  await assert.rejects(
    connectMcp({ far: { type: "http", url: "https://ok.example.com/mcp" } }, { env: {}, toolEnv: {}, cwd: process.cwd(), signal, sandbox: base }),
    /needs the sandbox's site proxy/,
  );
  const asked: string[] = [];
  const viaWalls = { ...base, fetch: (async (input: string | URL | Request) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return new Response("refused by the proxy", { status: 403 });
  }) as typeof fetch };
  await assert.rejects(connectMcp({ far: { type: "http", url: "https://ok.example.com/mcp" } }, { env: {}, toolEnv: {}, cwd: process.cwd(), signal, sandbox: viaWalls }));
  assert.ok(asked.some((u) => u.startsWith("https://ok.example.com/mcp")), `the walls' fetch was used: ${asked.join(", ")}`);
  asked.length = 0;
  await assert.rejects(connectMcp({ old: { type: "sse", url: "https://ok.example.com/sse" } }, { env: {}, toolEnv: {}, cwd: process.cwd(), signal, sandbox: viaWalls }));
  assert.ok(asked.some((u) => u.startsWith("https://ok.example.com/sse")), "SSE's stream too");
});

test("a 205 answer is a Response without a body, not a crash; a finished request leaves no listener on the caller's signal (Codex)", async () => {
  const { getEventListeners } = await import("node:events");
  const site = http.createServer((req, res) => {
    if (req.url === "/reset") return void res.writeHead(205).end();
    res.writeHead(200).end("ok");
  });
  const sitePort = await listen(site);
  const p = await fakeProxy(["localhost"]);
  try {
    const f = proxyFetch({ host: "127.0.0.1", port: p.port, user: "srt", token: "tok" });
    const r = await f(`http://localhost:${sitePort}/reset`);
    assert.equal(r.status, 205);
    assert.equal(r.body, null);
    const ac = new AbortController();
    for (let i = 0; i < 5; i++) assert.equal(await (await f(`http://localhost:${sitePort}/`, { signal: ac.signal })).text(), "ok");
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(getEventListeners(ac.signal, "abort").length, 0, "no listener left per request");
  } finally {
    p.close();
    site.close();
  }
});
