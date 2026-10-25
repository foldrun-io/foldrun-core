// `network:` — which sites a step's sandbox may reach.
//
// The rule the egress proxy holds per request, and the cascade that builds
// it: a level nearest-wins, `allow` adding up, the trusted list unless
// dropped, and the default that keeps an agent reading the open web open.
//
//   node --test tests/network.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TRUSTED_SITES,
  egressCaSh,
  networkAllows,
  networkLine,
  networkEnforceWanted,
  hostsInTrail,
  networkProblems,
  normalHost,
  proxyEnv,
  readNetwork,
  resolveNetwork,
  siteCovers,
} from "../src/network.ts";

test("a wildcard covers its subdomains and the bare domain; a plain site only itself", () => {
  assert.ok(siteCovers("*.example.com", "a.example.com"));
  assert.ok(siteCovers("*.example.com", "a.b.example.com"));
  assert.ok(siteCovers("*.example.com", "example.com"));
  assert.ok(!siteCovers("*.example.com", "badexample.com"));
  assert.ok(siteCovers("api.example.com", "API.Example.com:443"));
  assert.ok(!siteCovers("api.example.com", "x.api.example.com"));
  assert.equal(normalHost("Example.COM."), "example.com");
});

test("the three ways to write it are read; nonsense is a problem, never a guess", () => {
  assert.deepEqual(readNetwork("open").setting, { level: "open", allow: [] });
  assert.deepEqual(readNetwork(["api.example.com", "*.Example.org"]).setting, { allow: ["api.example.com", "*.example.org"] });
  assert.deepEqual(readNetwork("a.com, b.com").setting, { allow: ["a.com", "b.com"] });
  assert.deepEqual(readNetwork({ level: "trusted", allow: ["a.com"], defaults: false }).setting, {
    level: "trusted",
    allow: ["a.com"],
    defaults: false,
  });
  // A word that is not a level is a typo, not a domain called "closed".
  assert.match(networkProblems("closed")[0], /open, trusted, none/);
  assert.match(networkProblems(["https://a.com/x"])[0], /no scheme or path: a\.com/);
  assert.match(networkProblems(["a.com:8443"])[0], /no port/);
  assert.match(networkProblems({ level: "wide" })[0], /network\.level/);
  assert.match(networkProblems({ allows: ["a.com"] })[0], /network\.allows is not a key/);
  assert.deepEqual(networkProblems(undefined), []);
});

test("unset: an agent that reads the web is open, every other trusted", () => {
  const web = resolveNetwork({ readsWeb: true });
  assert.equal(web.level, "open");
  assert.deepEqual(web.hosts, []);
  assert.ok(networkAllows(web, "anything.example"));

  const plain = resolveNetwork({ readsWeb: false, implied: ["api.dataforseo.com"] });
  assert.equal(plain.level, "trusted");
  assert.ok(networkAllows(plain, "pypi.org"));
  assert.ok(networkAllows(plain, "deb.debian.org"), "the runner's own package mirror");
  assert.ok(networkAllows(plain, "bucket.s3.amazonaws.com"), "the trusted list's wildcards");
  assert.ok(networkAllows(plain, "api.dataforseo.com"), "what the step declares");
  assert.ok(!networkAllows(plain, "evil.example"));
  assert.equal(plain.hosts.length, new Set(plain.hosts).size);
});

test("the level is nearest-wins; allow adds up across all three levels", () => {
  const p = resolveNetwork({
    account: ["acct.example.com"],
    workspace: { level: "open" },
    agent: { level: "trusted", allow: ["agent.example.com"] },
    readsWeb: true,
  });
  assert.equal(p.level, "trusted");
  assert.equal(p.from, "agent");
  assert.ok(networkAllows(p, "acct.example.com"));
  assert.ok(networkAllows(p, "agent.example.com"));
  assert.deepEqual(p.added, ["agent.example.com", "acct.example.com"]);

  // A workspace that opens every agent, and an agent that says nothing.
  const open = resolveNetwork({ workspace: "open", readsWeb: false });
  assert.equal(open.level, "open");
  assert.equal(open.from, "workspace");
});

test("defaults: false drops the trusted list; none keeps only what the step declares", () => {
  const bare = resolveNetwork({ agent: { level: "trusted", allow: ["a.com"], defaults: false }, readsWeb: false });
  assert.ok(networkAllows(bare, "a.com"));
  assert.ok(!networkAllows(bare, "pypi.org"));

  const none = resolveNetwork({ agent: "none", readsWeb: true, implied: ["api.resend.com"] });
  assert.equal(none.level, "none");
  assert.deepEqual(none.hosts, ["api.resend.com"]);
  assert.ok(!networkAllows(none, "pypi.org"));
});

test("an unreadable level says nothing, so the level above decides", () => {
  const p = resolveNetwork({ agent: "closed", workspace: "none", readsWeb: false });
  assert.equal(p.level, "none");
  assert.equal(p.from, "workspace");
});

test("the trusted list is Anthropic's published Trusted list plus Debian's mirrors", () => {
  for (const site of ["api.anthropic.com", "github.com", "registry.npmjs.org", "pypi.org", "*.googleapis.com", "*.modelcontextprotocol.io", "deb.debian.org"]) {
    assert.ok(TRUSTED_SITES.includes(site), site);
  }
  assert.equal(TRUSTED_SITES.length, new Set(TRUSTED_SITES).size, "no site twice");
});

test("the trace says the level, where it came from, and whether it is enforced", () => {
  const p = resolveNetwork({ readsWeb: false, agent: ["a.com"] });
  assert.match(networkLine(p, true), /^network: trusted \(default\) — the trusted list \(\d+ sites\); added: a\.com$/);
  assert.match(networkLine(p, false), /report only/);
  assert.match(networkLine(resolveNetwork({ readsWeb: true }), null), /open .* any public site — not enforced here/);
});

test("the proxy variables come in both spellings and keep the cluster off the proxy", () => {
  const env = proxyEnv("http://foldrun:tok@foldrun-egress.foldrun.svc.cluster.local:8090");
  assert.equal(env.HTTPS_PROXY, env.https_proxy);
  assert.equal(env.HTTP_PROXY, env.http_proxy);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.NODE_OPTIONS, "--disable-warning=UNDICI-EHPA", "the proxy's experimental warning is not a tool error");
  for (const name of [".cluster.local", ".svc", "localhost", "foldrun-egress.foldrun.svc.cluster.local"]) {
    assert.ok(env.NO_PROXY.split(",").includes(name), name);
  }
});

test("the sandbox's start writes the CA and points TLS clients at a bundle with it", { skip: process.platform === "win32" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-ca-"));
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const system = path.join(dir, "system.crt");
  fs.writeFileSync(system, "-----BEGIN CERTIFICATE-----\nSYSTEM\n-----END CERTIFICATE-----\n");
  const out = execFileSync("sh", ["-c", `${egressCaSh(dir, system)}\necho "$SSL_CERT_FILE|$NODE_EXTRA_CA_CERTS|$REQUESTS_CA_BUNDLE"`], {
    env: { ...process.env, FOLDRUN_EGRESS_CA: Buffer.from(pem).toString("base64") },
    encoding: "utf8",
  }).trim();
  assert.equal(out, `${dir}/ca-bundle.pem|${dir}/egress-ca.pem|${dir}/ca-bundle.pem`);
  assert.equal(fs.readFileSync(path.join(dir, "egress-ca.pem"), "utf8"), pem);
  const bundle = fs.readFileSync(path.join(dir, "ca-bundle.pem"), "utf8");
  assert.ok(bundle.startsWith("-----BEGIN CERTIFICATE-----\nSYSTEM") && bundle.endsWith(pem), "the system's CAs, then the egress CA");
  // No system bundle to add to: only Node is told, nothing else is broken.
  const bare = execFileSync("sh", ["-c", `${egressCaSh(dir, path.join(dir, "no-such-bundle"))}\necho "[$SSL_CERT_FILE]|$NODE_EXTRA_CA_CERTS"`], {
    env: { PATH: process.env.PATH, FOLDRUN_EGRESS_CA: Buffer.from(pem).toString("base64") },
    encoding: "utf8",
  }).trim();
  assert.equal(bare, `[]|${dir}/egress-ca.pem`);
  // No CA, nothing touched.
  const none = execFileSync("sh", ["-c", `${egressCaSh(dir)}\necho "[$SSL_CERT_FILE]"`], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  }).trim();
  assert.equal(none, "[]");
});

test("a secret bound to sites keeps them through a new value, a rewrap, and a list", async () => {
  const { setSecret, setSecretSites, secretSites, listSecrets, setFileSecret, getSecret } = await import("../src/secrets.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sites-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces/desk"), { recursive: true });
    setSecret("acme", "DFS_KEY", "v1-aaaaaaaa");
    assert.deepEqual(setSecretSites("acme", "DFS_KEY", ["API.dataforseo.com", "*.example.org", "api.dataforseo.com"]), ["api.dataforseo.com", "*.example.org"]);
    setSecret("acme", "DFS_KEY", "v2-bbbbbbbb");
    assert.equal(getSecret("acme", "DFS_KEY")?.value, "v2-bbbbbbbb");
    assert.deepEqual(secretSites("acme", ["DFS_KEY", "NOPE"]), { DFS_KEY: ["api.dataforseo.com", "*.example.org"] });
    assert.deepEqual(listSecrets("acme").find((s) => s.name === "DFS_KEY")?.sites, ["api.dataforseo.com", "*.example.org"]);

    // The nearest scope's record decides, as it does for the value.
    setSecret("acme", "DFS_KEY", "ws-cccccccc", "desk");
    assert.deepEqual(secretSites("acme", ["DFS_KEY"], "desk"), {});
    setSecretSites("acme", "DFS_KEY", ["ws.example.com"], "desk");
    assert.deepEqual(secretSites("acme", ["DFS_KEY"], "desk"), { DFS_KEY: ["ws.example.com"] });

    // An empty list unbinds.
    setSecretSites("acme", "DFS_KEY", []);
    assert.deepEqual(secretSites("acme", ["DFS_KEY"]), {});

    assert.throws(() => setSecretSites("acme", "DFS_KEY", ["https://x.com/"]), /not a site/);
    assert.throws(() => setSecretSites("acme", "MISSING", ["x.com"]), /no secret MISSING/);
    setFileSecret("acme", "CERT", "-----BEGIN X-----");
    assert.throws(() => setSecretSites("acme", "CERT", ["x.com"]), /file secret/);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setNetworkSetting rewrites only the network: line, in whatever shape it was", async () => {
  const { setNetworkSetting, networkYaml } = await import("../src/network.ts");
  const file = "---\nname: a\nnetwork:\n  - old.com\n  - \"*.old.org\"\nmodel: fast\n---\n\nBody stays.\n";
  const next = setNetworkSetting(file, { level: "trusted", allow: ["api.x.com", "*.y.org"] });
  assert.equal(next, '---\nname: a\nnetwork: { level: trusted, allow: [api.x.com, "*.y.org"] }\nmodel: fast\n---\n\nBody stays.\n');
  assert.deepEqual(readNetwork((await import("gray-matter")).default(next).data.network).setting, { level: "trusted", allow: ["api.x.com", "*.y.org"] });
  assert.equal(setNetworkSetting(next, null), "---\nname: a\nmodel: fast\n---\n\nBody stays.\n");
  assert.equal(setNetworkSetting("---\nname: a\n---\n", { level: "open" }), "---\nname: a\nnetwork: open\n---\n");
  assert.equal(networkYaml({ allow: ["a.com"] }), "[a.com]");
  assert.equal(networkYaml({ level: "trusted", allow: [], defaults: false }), "{ level: trusted, defaults: false }");
  assert.equal(networkYaml({ allow: [] }), null);
});

test("network_enforce: the account's or the workspace's true is enough; anything but true is no", () => {
  assert.equal(networkEnforceWanted(true, undefined), true);
  assert.equal(networkEnforceWanted(undefined, true), true);
  assert.equal(networkEnforceWanted(true, false), true, "a workspace cannot switch off the account's");
  assert.equal(networkEnforceWanted("true", "yes"), false);
  assert.equal(networkEnforceWanted(undefined, undefined), false);
});

test("hostsInTrail: the sites a step's egress lines name, once each, no ports", () => {
  assert.deepEqual(
    hostsInTrail([
      { type: "info", text: "egress: CONNECT pypi.org:443 × 3 (840ms total)" },
      { type: "info", text: "egress: POST API.Example.com/v1/x → 200 (120ms) [CRM_TOKEN]" },
      { type: "info", text: "egress: CONNECT pypi.org:443 (10ms)" },
      { type: "info", text: "network: trusted (default) — the trusted list" },
      { type: "text", text: "I looked at egress: CONNECT nowhere" },
      { type: "info", text: "egress: CONNECT 10.0.0.5:443 refused — a private or internal address" },
      { type: "info", text: "egress: POST blocked.example refused — not a host this step's secrets were granted to" },
      { type: "info", text: "egress: GET down.example → unreachable: ECONNREFUSED" },
      { type: "info", text: "egress: CONNECT gone.example:443 unreachable — getaddrinfo ENOTFOUND" },
    ]),
    ["api.example.com", "pypi.org"],
  );
});
