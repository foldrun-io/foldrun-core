// FOL-215 against a real container engine: a held step's own network has no route out and no
// address of the host, the egress relay answers for the proxy's name, and steps cannot reach each
// other. Not in `npm test` (it needs Docker 28+); run it where Docker is:
//
//   node --test tests/egress-network-e2e.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const docker = (args: string[], timeout = 120_000) => spawnSync("docker", args, { encoding: "utf8", timeout });
const up = docker(["info", "--format", "{{.ServerVersion}}"], 15_000).status === 0;
const opts = { skip: up ? false : "no Docker here", timeout: 300_000 };
const tag = crypto.randomBytes(3).toString("hex");
process.env.FOLDRUN_EGRESS_RELAY = `fol215-relay-${tag}`;
const PORT = 18000 + (parseInt(tag, 16) % 1000);
const HOSTPORT = PORT + 1000;
const IMAGE = "node:22-trixie-slim"; // the runner image's base (NODE_BASE): the relay runs on its node
const boxes: string[] = [];

/** What a container on `net` can reach, each line "name OPEN|blocked". */
function probe(net: string, extra = ""): Record<string, string> {
  const sh = `
r(){ if "$@" >/dev/null 2>&1; then echo "$N OPEN"; else echo "$N blocked"; fi; }
N=egress r sh -c 'wget -q -T 5 -O - http://host.docker.internal:${PORT}/ | grep -q EGRESS-OK'
N=internet r wget -q -T 4 -O /dev/null http://1.1.1.1/
N=dns r nslookup -timeout=3 example.com
N=relay-other-port r nc -z -w3 host.docker.internal 22
N=host-listener r sh -c 'g=$(ip route | awk "/scope link/ {print \\$1; exit}" | sed "s#\\.[0-9]*/.*#.1#"); nc -z -w3 $g ${HOSTPORT}'
${extra}`;
  const out = docker(["run", "--rm", "--network", net, "alpine", "sh", "-c", sh]).stdout;
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split(" ")));
}

test("a held step's network: the proxy through the relay, nothing else; steps apart; removed after", opts, async (t) => {
  t.after(() => {
    for (const b of boxes) docker(["rm", "-f", b]);
    for (const r of docker(["ps", "-aq", "--filter", `name=fol215-relay-${tag}`]).stdout.split("\n").filter(Boolean)) docker(["rm", "-f", r]);
  });
  const { stepNetwork, relayNameFor } = await import("../src/run-container.ts");
  // A stand-in egress proxy, published on the host as the compose install publishes its own,
  // and a service listening on the host itself (all interfaces) that a step must not reach.
  boxes.push(`fol215-egress-${tag}`, `fol215-hostsvc-${tag}`);
  assert.equal(docker(["run", "-d", "--name", boxes[0], "-p", `${PORT}:8000`, IMAGE, "node", "-e", `require("http").createServer((q,s)=>s.end("EGRESS-OK")).listen(8000)`]).status, 0);
  assert.equal(docker(["run", "-d", "--name", boxes[1], "--network", "host", "alpine", "sh", "-c", `nc -lk -p ${HOSTPORT} -e echo hi`]).status, 0);
  await new Promise((r) => setTimeout(r, 1_500));
  // Positive control: on an ordinary internal bridge the host answers on that bridge's own
  // first address (its gateway) — what an isolated gateway must take away.
  const plain = `fol215-plain-${tag}`;
  docker(["network", "create", "--internal", plain]);
  t.after(() => docker(["network", "rm", plain]));
  const control = probe(plain);
  assert.equal(control["host-listener"], "OPEN", "control: the host answers on a plain internal bridge's gateway");
  assert.equal(control.internet, "blocked");

  const door = { host: "host.docker.internal", port: PORT };
  const a = stepNetwork(door, IMAGE, `run-a-${tag}`);
  const b = stepNetwork(door, IMAGE, `run-b-${tag}`);
  assert.notEqual(a.name, b.name, "one network per step");
  assert.equal(docker(["network", "inspect", a.name, "--format", `{{.Internal}}|{{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}}`]).stdout.trim(), "true|isolated");
  await new Promise((r) => setTimeout(r, 1_500));

  // A step on A, listening; the same check from a second container on A proves it answers.
  const listener = `fol215-a-${tag}`;
  boxes.push(listener);
  assert.equal(docker(["run", "-d", "--name", listener, "--network", a.name, "alpine", "sh", "-c", "nc -lk -p 7000 -e echo hi"]).status, 0);
  const ipA = docker(["inspect", listener, "--format", `{{(index .NetworkSettings.Networks "${a.name}").IPAddress}}`]).stdout.trim();
  assert.ok(ipA);
  const seenA = probe(a.name, `N=same-network r nc -z -w3 ${ipA} 7000`);
  assert.deepEqual(seenA, { egress: "OPEN", internet: "blocked", dns: "blocked", "relay-other-port": "blocked", "host-listener": "blocked", "same-network": "OPEN" });
  const seenB = probe(b.name, `N=other-step r nc -z -w3 ${ipA} 7000`);
  assert.deepEqual(seenB, { egress: "OPEN", internet: "blocked", dns: "blocked", "relay-other-port": "blocked", "host-listener": "blocked", "other-step": "blocked" });

  // A moved proxy gets its own relay; B, on the old one, keeps working.
  const c = stepNetwork({ host: "host.docker.internal", port: PORT + 1 }, IMAGE, undefined);
  assert.notEqual(relayNameFor({ host: "host.docker.internal", port: PORT + 1 }), relayNameFor(door));
  assert.equal(probe(b.name).egress, "OPEN", "the old relay still serves B");
  // A name taken by something else is refused, not removed.
  docker(["rm", "-f", relayNameFor({ host: "host.docker.internal", port: PORT + 2 })]);
  boxes.push(relayNameFor({ host: "host.docker.internal", port: PORT + 2 }));
  docker(["run", "-d", "--name", boxes.at(-1)!, "alpine", "sleep", "300"]);
  assert.throws(() => stepNetwork({ host: "host.docker.internal", port: PORT + 2 }, IMAGE, undefined), /not foldrun's egress relay/);
  assert.equal(docker(["inspect", boxes.at(-1)!, "--format", "{{.State.Running}}"]).stdout.trim(), "true", "the stranger is left alone");

  docker(["rm", "-f", listener]);
  for (const n of [a, b, c]) n.remove();
  for (const n of [a, b, c]) assert.notEqual(docker(["network", "inspect", n.name]).status, 0, `${n.name} removed`);
});
