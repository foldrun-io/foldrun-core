// Redirects from a tenant-chosen URL are followed one hop at a time, each
// hop back through platform.fetchUntrusted — so the platform's refusal of
// private addresses applies to where a request ends up, not only to where
// it started. A 302 to an IP literal used to be followed inside fetch, past
// the check, and never reached the DNS lookup the connect-time guard is in.
//
//   node --test tests/untrusted-fetch.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPlatform, resetPlatform } from "../src/platform.ts";
import { fetchUntrusted, MAX_REDIRECTS } from "../src/untrusted-fetch.ts";

type Seen = { url: string; method: string; redirect?: string; headers: Record<string, string>; body: unknown };

/** A platform seam that answers from a table, refuses 10.x like the real
 *  one, and records every request it was handed. */
function withSeam(routes: Record<string, () => Response>, body: (seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  registerPlatform({
    async fetchUntrusted(url, init) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      seen.push({ url, method: init?.method ?? "GET", redirect: init?.redirect, headers, body: init?.body });
      if (new URL(url).hostname.startsWith("10.")) throw new Error(`${new URL(url).hostname} is a private or internal address`);
      const route = routes[url];
      return route ? route() : new Response("not found", { status: 404 });
    },
  });
  return body(seen).finally(() => resetPlatform());
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

test("a redirect to a private IP literal goes back through the seam, and is refused there", () =>
  withSeam({ "https://hooks.example.com/x": redirect("http://10.0.0.5/latest/meta-data") }, async (seen) => {
    await assert.rejects(fetchUntrusted("https://hooks.example.com/x"), /10\.0\.0\.5 is a private or internal address/);
    assert.deepEqual(seen.map((s) => s.url), ["https://hooks.example.com/x", "http://10.0.0.5/latest/meta-data"]);
    assert.ok(seen.every((s) => s.redirect === "manual"), "fetch itself never follows one");
  }));

test("an ordinary redirect is still followed, relative locations included", () =>
  withSeam(
    {
      "https://a.example.com/start": redirect("/moved"),
      "https://a.example.com/moved": () => new Response("here", { status: 200 }),
    },
    async () => {
      const res = await fetchUntrusted("https://a.example.com/start");
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "here");
    },
  ));

test(`no more than ${MAX_REDIRECTS} hops`, () =>
  withSeam({ "https://loop.example.com/": redirect("https://loop.example.com/") }, async (seen) => {
    await assert.rejects(fetchUntrusted("https://loop.example.com/"), /more than 5 redirects/);
    assert.equal(seen.length, MAX_REDIRECTS + 1);
  }));

test("a credential-carrying request follows no redirect to another origin", () =>
  withSeam({ "https://auth.example.com/token": redirect("https://evil.example.net/steal", 307) }, async (seen) => {
    await assert.rejects(
      fetchUntrusted("https://auth.example.com/token", { method: "POST", body: "client_secret=s3cret" }, { sameOrigin: true }),
      /redirected to https:\/\/evil\.example\.net — not followed/,
    );
    assert.equal(seen.length, 1, "the secret was sent once, to where it was meant to go");
  }));

test("a hop to another origin keeps only headers that cannot carry a credential", () =>
  withSeam(
    {
      "https://a.example.com/hook": redirect("https://b.example.net/hook", 307),
      "https://b.example.net/hook": () => new Response("ok"),
    },
    async (seen) => {
      await fetchUntrusted("https://a.example.com/hook", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t", "x-api-key": "k", "x-signature": "sig" },
        body: "{}",
      });
      assert.deepEqual(seen[1].headers, { "content-type": "application/json" });
      assert.equal(seen[1].method, "POST", "a 307 repeats the request");
      assert.equal(seen[1].body, "{}");
    },
  ));

test("a 303 is followed as a GET with no body", () =>
  withSeam(
    {
      "https://a.example.com/form": redirect("https://a.example.com/done", 303),
      "https://a.example.com/done": () => new Response("ok"),
    },
    async (seen) => {
      await fetchUntrusted("https://a.example.com/form", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
      assert.equal(seen[1].method, "GET");
      assert.equal(seen[1].body, undefined);
      assert.equal(seen[1].headers["content-type"], undefined);
    },
  ));
