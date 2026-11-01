// Device authorization (src/oauth-device.ts, RFC 8628) against a local
// provider that answers pending, then slow_down, then approves — and one that
// is denied, one that expires, one that answers form-encoded with Google's
// old verification_url spelling.
//
//   node --test tests/oauth-device.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startDeviceAuthorization, pollDeviceToken, waitForDeviceToken, DEVICE_GRANT } from "../src/oauth-device.ts";

async function provider(script: string[]): Promise<{ base: string; polls: URLSearchParams[]; starts: { auth?: string; form: URLSearchParams }[]; close: () => void }> {
  const polls: URLSearchParams[] = [];
  const starts: { auth?: string; form: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      if (req.url === "/device") {
        starts.push({ auth: req.headers.authorization, form });
        if (form.get("client_id") === "form-encoded") {
          res.writeHead(200, { "content-type": "application/x-www-form-urlencoded" });
          res.end("device_code=dc&user_code=WDJB-MJHT&verification_url=https%3A%2F%2Fexample.com%2Fdevice&expires_in=1800&interval=5");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ device_code: "dc-1", user_code: "WDJB-MJHT", verification_uri: "https://example.com/device", verification_uri_complete: "https://example.com/device?user_code=WDJB-MJHT", expires_in: 900 }));
        return;
      }
      polls.push(form);
      const step = script[Math.min(polls.length - 1, script.length - 1)];
      res.writeHead(step === "ok" ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(step === "ok" ? { access_token: "at", refresh_token: "rt", expires_in: 3600 } : { error: step }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, polls, starts, close: () => server.close() };
}

test("start: the client asks with its scope and authenticates as at the token URL; the answer is read, interval defaults to 5", async () => {
  const p = await provider(["ok"]);
  try {
    const s = await startDeviceAuthorization({ client_id: "cid", client_secret: "shh", token_auth: "client_secret_basic", device_url: `${p.base}/device`, token_url: `${p.base}/token` }, "openid offline_access", fetch);
    assert.equal(s.user_code, "WDJB-MJHT");
    assert.equal(s.verification_uri_complete, "https://example.com/device?user_code=WDJB-MJHT");
    assert.equal(s.interval, 5);
    assert.equal(s.expires_in, 900);
    assert.match(p.starts[0].auth ?? "", /^Basic /);
    assert.equal(p.starts[0].form.get("client_id"), "cid", "client_id rides in the body too (RFC 8628 §3.1)");
    assert.equal(p.starts[0].form.get("scope"), "openid offline_access");
    assert.equal(p.starts[0].form.get("code_challenge_method"), "S256");
    assert.equal(p.starts[0].form.get("code_challenge"), (await import("node:crypto")).createHash("sha256").update(s.code_verifier).digest("base64url"), "PKCE on the device grant");
    const g = await startDeviceAuthorization({ client_id: "form-encoded", device_url: `${p.base}/device`, token_url: `${p.base}/token` }, "", fetch);
    assert.equal(g.verification_uri, "https://example.com/device", "Google's verification_url is read too");
    assert.equal(g.interval, 5);
  } finally {
    p.close();
  }
});

test("wait: pending, then slow_down (+5 s), then approved — the device grant each time", async () => {
  const p = await provider(["authorization_pending", "slow_down", "authorization_pending", "ok"]);
  const waits: number[] = [];
  try {
    const t = await waitForDeviceToken({ client_id: "cid", token_url: `${p.base}/token` }, { device_code: "dc-1", user_code: "U", verification_uri: "https://x", expires_in: 900, interval: 5, code_verifier: "v".repeat(43) }, fetch, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(t.access_token, "at");
    assert.equal(t.refresh_token, "rt");
    assert.deepEqual(waits, [5000, 5000, 10000, 10000], "slow_down adds 5 seconds for every poll after it");
    for (const f of p.polls) {
      assert.equal(f.get("grant_type"), DEVICE_GRANT);
      assert.equal(f.get("device_code"), "dc-1");
      assert.equal(f.get("code_verifier"), "v".repeat(43));
    }
  } finally {
    p.close();
  }
});

test("a timed-out poll backs off and goes on; the provider's own refusal does not (Codex review)", async () => {
  const p = await provider(["ok"]);
  const waits: number[] = [];
  let calls = 0;
  const flaky = async (u: string, init: RequestInit) => {
    calls++;
    if (calls <= 2) throw new TypeError("fetch failed");
    return fetch(u, init);
  };
  try {
    const t = await waitForDeviceToken({ client_id: "c", token_url: `${p.base}/token` }, { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 900, interval: 5, code_verifier: "v" }, flaky, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(t.access_token, "at");
    assert.deepEqual(waits, [5000, 10000, 20000], "the interval doubles after each timeout");
  } finally {
    p.close();
  }
});

test("a client that cannot make the request fails at once; backoff never drops below the provider's interval (Codex review)", async () => {
  await assert.rejects(waitForDeviceToken({ client_id: "c", token_auth: "client_secret_basic", token_url: "https://p.example/token" }, { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 900, interval: 5, code_verifier: "v" }, fetch, { sleep: async () => { throw new Error("slept"); } }), /needs a client_secret/);
  const p = await provider(["ok"]);
  const waits: number[] = [];
  let calls = 0;
  try {
    await waitForDeviceToken({ client_id: "c", token_url: `${p.base}/token` }, { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 9000, interval: 90, code_verifier: "v" },
      async (u, init) => { if (++calls === 1) throw new TypeError("fetch failed"); return fetch(u, init); }, { sleep: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [90000, 90000], "a 90-second interval stays 90 after a timeout");
  } finally {
    p.close();
  }
});

test("denied and expired are said in words; an unknown error is thrown; the deadline is kept", async () => {
  for (const [code, re] of [["access_denied", /says no/], ["expired_token", /ran out/]] as const) {
    const p = await provider([code]);
    try {
      await assert.rejects(waitForDeviceToken({ client_id: "c", token_url: `${p.base}/token` }, { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 900, interval: 1, code_verifier: "v" }, fetch, { sleep: async () => {} }), re);
    } finally {
      p.close();
    }
  }
  const p = await provider(["invalid_client"]);
  try {
    await assert.rejects(pollDeviceToken({ client_id: "c", token_url: `${p.base}/token` }, "d", fetch), /refused the device token request \(400\): invalid_client/);
    let clock = 0;
    await assert.rejects(waitForDeviceToken({ client_id: "c", token_url: `${p.base}/token` }, { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 10, interval: 5, code_verifier: "v" }, fetch, {
      sleep: async (ms) => { clock += ms * 3; }, now: () => clock,
    }), /ran out before anyone approved it/);
  } finally {
    p.close();
  }
});
