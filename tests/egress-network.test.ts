// FOL-215: walling a Docker step to the egress proxy — the pieces that need no engine.
//
//   node --test tests/egress-network.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { egressDoorOf, relayNameFor, relayProgram, assertIsolatingEngine } from "../src/run-container.ts";
import { isProxyEnvName, reservedEnvName } from "../src/env-names.ts";

test("the door comes from the lease's proxy URL, and only the compose install's host can be walled to", () => {
  assert.deepEqual(egressDoorOf("http://foldrun:tok@host.docker.internal:8090"), { host: "host.docker.internal", port: 8090 });
  assert.deepEqual(egressDoorOf("http://foldrun:tok@HOST.DOCKER.INTERNAL"), { host: "host.docker.internal", port: 80 });
  const why = (u: string | null) => {
    const d = egressDoorOf(u);
    assert.ok("why" in d, JSON.stringify(d));
    return d.why;
  };
  assert.match(why(null), /no egress proxy/);
  assert.match(why("http://foldrun:t@172.17.0.1:8090"), /only host\.docker\.internal/);
  assert.match(why("http://foldrun:t@egress.foldrun.svc:8090"), /only host\.docker\.internal/, "another name: the relay could resolve its own alias");
  assert.match(why("not a url"), /does not parse/);
});

test("one relay per upstream, so a moved proxy gets a new relay and the old one drains", () => {
  const a = relayNameFor({ host: "host.docker.internal", port: 8090 });
  assert.match(a, /^foldrun-egress-relay-[0-9a-f]{10}$/);
  assert.equal(relayNameFor({ host: "host.docker.internal", port: 8090 }), a);
  assert.notEqual(relayNameFor({ host: "host.docker.internal", port: 8091 }), a);
});

test("the relay program parses, resolves once, caps connections and idles out", () => {
  const src = relayProgram({ host: "host.docker.internal", port: 8090 }, { total: 7, perSource: 3, idleMs: 1234 });
  const parsed = spawnSync(process.execPath, ["-e", `new Function(${JSON.stringify(src)})`], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  for (const part of ['d.lookup("host.docker.internal"', "all>=7", "m>=3", "setTimeout(1234", "listen(8090)", "n.connect(8090,ip)"]) assert.ok(src.includes(part), part);
});

test("a secret may not take the name of a proxy variable the platform sets", () => {
  for (const n of ["HTTPS_PROXY", "http_proxy", "NO_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY", "FOLDRUN_EGRESS", "FOLDRUN_EGRESS_CA"]) {
    assert.ok(isProxyEnvName(n), n);
    assert.match(reservedEnvName(n) ?? "", /egress proxy/, n);
  }
  assert.equal(isProxyEnvName("MY_PROXY_TOKEN"), false);
});

test("a held step needs Docker 28 or later, and an unknown version is refused", () => {
  assert.throws(() => assertIsolatingEngine(() => "27.5.1"), /Docker 28 or later \(this engine: 27\.5\.1\)/);
  assert.throws(() => assertIsolatingEngine(() => "26.1.5"), /Docker 28/);
  assert.throws(() => assertIsolatingEngine(() => null), /version unknown/);
  assert.throws(() => assertIsolatingEngine(() => "dev"), /Docker 28/);
  for (const bad of ["28.", "29.dev", "28", "v29.5.2", "28.0-", "28.0+", "28.0~"]) assert.throws(() => assertIsolatingEngine(() => bad), /Docker 28/, bad);
  for (const ok of ["29.5.2", "28.0.1", "28.3.0+dfsg1", "29.0.0-rc.1"]) assert.doesNotThrow(() => assertIsolatingEngine(() => ok), ok);
  // Asked every time: an engine that is older on the next step is refused then.
  assert.throws(() => assertIsolatingEngine(() => "27.5.1"), /27\.5\.1/);
});
