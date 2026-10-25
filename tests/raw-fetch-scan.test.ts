// No bare fetch() to a URL a tenant chose (FOL-85). On a platform this code
// runs on the web and worker tiers, which reach what a sandbox cannot — the
// cluster's services, the pod's own loopback — so a tenant's URL goes through
// fetchUntrusted (untrusted-fetch.ts → platform.fetchUntrusted), which refuses
// private and cluster addresses, checks every redirect hop and caps the
// answer. A bare fetch() skips all of it; the tool test and the host-side
// model translator both did.
//
// So every raw request in src/ is counted, per file, against the list below.
// A new one fails here until it either goes through fetchUntrusted or is
// added with the reason its URL is not the tenant's. A count that drops
// fails too, so the list never outlives what it excuses.
//
//   node --test tests/raw-fetch-scan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");

/** A call, not a method of something else (`platform.fetchUntrusted(`,
 *  `hop_.fetch(`), nor a longer name (`fetchImpl(`). */
const RAW = /(^|[^.\w$])(fetch|undiciFetch)\(|\bhttps?\.(request|get)\(/g;

const ALLOWED: Record<string, { count: number; why: string }> = {
  "platform.ts": { count: 1, why: "the laptop's own fetchUntrusted: single-tenant, its LAN on purpose; a platform replaces it" },
  "translator.ts": { count: 1, why: "the step's egress-proxy path only — the proxy guards the address; without a proxy it is fetchUntrusted" },
  "api-tools.ts": { count: 1, why: "an http tool's call inside the step, through the lease's egress proxy on a platform" },
  "run-container.ts": { count: 3, why: "the in-pod driver's /identity call to the egress proxy, and two curl install snippets — sandbox, not host" },
  "storage.ts": { count: 2, why: "S3: FOLDRUN_S3_ENDPOINT and the AWS container-credential endpoint, both operator env" },
  "mail.ts": { count: 1, why: "Resend, a fixed host (api.resend.com)" },
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

function rawCalls(file: string): number {
  let n = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue; // prose about fetch(), not a call
    n += [...line.matchAll(RAW)].length;
  }
  return n;
}

test("every raw fetch in src/ is one the list explains — a tenant's URL goes through fetchUntrusted", () => {
  const found: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const n = rawCalls(file);
    if (n) found[path.relative(SRC, file)] = n;
  }
  for (const [file, n] of Object.entries(found)) {
    assert.ok(ALLOWED[file], `${file}: ${n} raw fetch() — use fetchUntrusted (untrusted-fetch.ts), or add it to ALLOWED with why its URL is not a tenant's`);
    assert.equal(n, ALLOWED[file].count, `${file}: ${n} raw fetch() where ${ALLOWED[file].count} are explained — ${ALLOWED[file].why}`);
  }
  for (const file of Object.keys(ALLOWED)) assert.ok(found[file], `${file} is in ALLOWED but has no raw fetch() any more — take it out`);
});

test("the scan sees a call and ignores a method or a longer name", () => {
  const count = (s: string) => [...s.matchAll(RAW)].length;
  assert.equal(count("const r = await fetch(url)"), 1);
  assert.equal(count("x = (await undiciFetch(u, i))"), 1);
  assert.equal(count("https.request(opts)"), 1);
  assert.equal(count("platform.fetchUntrusted(u); hop_.fetch(u); fetchImpl(u); await fetchUntrusted(u)"), 0);
});
