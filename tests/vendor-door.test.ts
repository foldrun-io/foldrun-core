// FOL-145: a vendor browser held to its network: list through foldrun's
// vendor door — the install's switch and vendor list, and the verdict.
//
//   node --test tests/vendor-door.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { browseNetworkLine, browseVerdict, VENDOR_DOOR_HOSTS, vendorDoorFor } from "../src/browse-egress.ts";
import { resolveNetwork } from "../src/network.ts";

const on = { FOLDRUN_VENDOR_EGRESS: "1", FOLDRUN_VENDOR_EGRESS_URL: "https://vendor-egress.dev.foldrun.io:8443/", FOLDRUN_VENDOR_EGRESS_VENDORS: "steel, Browserless" };

test("the door is on only where the install says so, for the vendors it lists", () => {
  assert.deepEqual(vendorDoorFor("steel", on), { vendor: "steel", server: "https://vendor-egress.dev.foldrun.io:8443" });
  assert.deepEqual(vendorDoorFor("browserless", on)?.vendor, "browserless");
  assert.equal(vendorDoorFor("browserbase", on), null, "not listed: not qualified, nothing changes");
  assert.equal(vendorDoorFor("steel", { ...on, FOLDRUN_VENDOR_EGRESS: "0" }), null, "the switch off");
  assert.equal(vendorDoorFor("steel", { ...on, FOLDRUN_VENDOR_EGRESS_URL: "" }), null, "no door address");
  assert.equal(vendorDoorFor("steel", { ...on, FOLDRUN_VENDOR_EGRESS_URL: "https://x/path" }), null, "an address, not a path");
  assert.equal(vendorDoorFor("brightdata", { ...on, FOLDRUN_VENDOR_EGRESS_VENDORS: "brightdata" }), null, "a vendor that always uses its own network, never");
  assert.equal(vendorDoorFor("steel", {}), null, "nothing set: off");
  assert.equal(vendorDoorFor(null, on), null);
});

test("every door vendor has the hosts its key is bound to", () => {
  for (const v of ["browserbase", "steel", "hyperbrowser", "browserless"]) assert.ok(VENDOR_DOOR_HOSTS[v]?.length, v);
  assert.ok(VENDOR_DOOR_HOSTS.steel!.includes("connect.steel.dev"));
});

test("the verdict: a held vendor step with a door is held through it; without one, refused as before", () => {
  const base = { level: "none" as const, enforce: true, confines: true };
  assert.deepEqual(browseVerdict({ ...base, vendor: "steel", door: true }), { kind: "vendor", vendor: "steel" });
  assert.equal(browseVerdict({ ...base, vendor: "steel" }).kind, "refuse");
  assert.equal(browseVerdict({ ...base, vendor: "brightdata", door: true }).kind, "refuse", "a door never admits a vendor that cannot use one");
  assert.equal(browseVerdict({ ...base, level: "open", vendor: "steel", door: true }).kind, "legacy", "an open list holds nothing, door or not");
  assert.equal(browseVerdict({ ...base, vendor: null, door: true }).kind, "hosted");
});

test("the trace says the vendor's browser is held through the door, and what it cannot do", () => {
  const policy = resolveNetwork({ agent: { level: "none", allow: ["example.com"] }, readsWeb: true, implied: [] } as never);
  const line = browseNetworkLine(policy, "steel", { vendorDoor: true });
  assert.match(line, /enforced — through foldrun's vendor door/);
  assert.match(line, /no site a secret is bound to/);
});
