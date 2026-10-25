// What a person reads when the model supply says no.
//
// Four shapes, from the incident that wrote src/refusal.ts: a window spent
// with overage off, a credential that is simply dead, a provider asking us
// to wait, and a step with nowhere else to go. Fixtures, never the network —
// these are header sets, and a header set is a fact we can write down.
//
//   node --test tests/provider-refusal.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureRefusalHeaders,
  explainRefusal,
  headersFrom,
  refusalFromLine,
  refusalLine,
  resetWhen,
  supplyNote,
  zoneWord,
} from "../src/refusal.ts";

const SYDNEY = "Australia/Sydney";

/** The real response from the incident: 2026-09-16 04:00 UTC is 14:00 in
 *  Sydney, which is where the five-hour window came back. */
const RESET = 1789531200; // 2026-09-16T04:00:00Z
const NOW = new Date(1789516800 * 1000); // 2026-09-16T00:00:00Z — 10:00 Sydney

const OVERAGE_OFF = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-utilization": "0.35",
  "anthropic-ratelimit-unified-5h-reset": String(RESET),
  "anthropic-ratelimit-unified-7d-utilization": "0.55",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
};

test("a 402 with overage disabled names the window, the utilisation and the reset in the step's zone", () => {
  const said = explainRefusal({
    status: 402,
    headers: OVERAGE_OFF,
    timezone: SYDNEY,
    supply: "none",
    now: NOW,
  });
  assert.equal(
    said,
    "the subscription refused this burst — the 5-hour window is 35% used but overage is off (out of credits); " +
      "it resets at 14:00 Sydney — no second supply is configured",
  );
  // The three facts an hour on the box was spent recovering.
  assert.match(said, /5-hour/);
  assert.match(said, /35%/);
  assert.match(said, /14:00 Sydney/);
  // Told in the step's calendar, not the pod's.
  assert.match(
    explainRefusal({ status: 402, headers: OVERAGE_OFF, timezone: "UTC", supply: "none", now: NOW }),
    /04:00 UTC/,
  );
});

test("a 401 with no rate-limit headers says the credential was refused, and says it is not quota", () => {
  const said = explainRefusal({ status: 401, headers: {}, timezone: SYDNEY, supply: "trying" });
  assert.equal(
    said,
    "the credential was refused (HTTP 401) and the response carried no rate-limit headers, " +
      "so this is the key itself — invalid, revoked, or wrong for this endpoint — not a spent window " +
      "— trying the second supply",
  );
  // The two shapes must never read alike. That is the whole point.
  assert.notEqual(said, explainRefusal({ status: 401, headers: OVERAGE_OFF, timezone: SYDNEY, supply: "trying" }));
  // A 401 that DOES carry the headers is the subscription, not the key.
  assert.match(
    explainRefusal({ status: 401, headers: OVERAGE_OFF, timezone: SYDNEY, now: NOW }),
    /^the subscription refused this burst/,
  );
});

test("a 429 with retry-after says how long, and a bare one says there was no number", () => {
  assert.equal(
    explainRefusal({ status: 429, headers: { "retry-after": "30" }, timezone: SYDNEY, supply: "none" }),
    "the provider is rate limiting this step (HTTP 429) and asked us to wait 30s — no second supply is configured",
  );
  assert.match(
    explainRefusal({ status: 429, headers: { "retry-after": "600" }, timezone: SYDNEY }),
    /wait 10m/,
  );
  assert.match(
    explainRefusal({ status: 429, headers: {}, timezone: SYDNEY, supply: "trying" }),
    /named no wait — trying the second supply/,
  );
});

test("where the step can go next is always on the line", () => {
  assert.equal(supplyNote("none"), " — no second supply is configured");
  assert.equal(supplyNote("trying"), " — trying the second supply");
  assert.equal(supplyNote("exhausted"), " — the second supply refused it too");
  // A caller that cannot know — the proxy sees a response, not a flow —
  // says nothing rather than guessing.
  assert.equal(supplyNote(undefined), "");
  for (const status of [401, 402, 429]) {
    assert.match(
      explainRefusal({ status, headers: status === 402 ? OVERAGE_OFF : {}, timezone: SYDNEY, supply: "none", now: NOW }),
      /no second supply is configured$/,
    );
  }
});

test("only the allow-listed headers are ever kept, and a credential never is", () => {
  const kept = captureRefusalHeaders(
    headersFrom({
      ...OVERAGE_OFF,
      "Anthropic-RateLimit-Unified-5h-Status": "rejected", // case does not matter
      authorization: "Bearer sk-ant-secret",
      "x-api-key": "sk-ant-secret",
      "set-cookie": "session=nope",
      "anthropic-organization-id": "org_123",
    }),
  );
  const asText = JSON.stringify(kept);
  assert.ok(!asText.includes("sk-ant-secret"));
  assert.ok(!asText.includes("session"));
  assert.ok(!asText.includes("org_123"));
  assert.equal(kept["anthropic-ratelimit-unified-overage-disabled-reason"], "out_of_credits");
  // Nothing outside the list, however plausibly named.
  assert.equal(kept["anthropic-organization-id"], undefined);
});

test("the mark survives the trip through a trace line", () => {
  const line = refusalLine({ status: 402, headers: OVERAGE_OFF, timezone: SYDNEY, now: NOW });
  assert.equal(refusalFromLine(`translator: ${line}`), explainRefusal({ status: 402, headers: OVERAGE_OFF, timezone: SYDNEY, now: NOW }));
  assert.equal(refusalFromLine("egress: POST api.anthropic.com/v1/messages → 402 (360ms)"), null);
});

test("a garbled header costs a clause, never the sentence", () => {
  assert.equal(resetWhen("not-a-number", SYDNEY, NOW), null);
  assert.equal(resetWhen(undefined, SYDNEY, NOW), null);
  assert.equal(resetWhen(String(RESET), "Mars/Olympus", NOW), null);
  // A reset on another day says which day.
  assert.match(resetWhen(String(RESET + 86_400), SYDNEY, NOW)!, /14:00 Sydney on /);
  assert.equal(zoneWord("Australia/Sydney"), "Sydney");
  assert.equal(zoneWord("America/New_York"), "New York");
  assert.equal(zoneWord("+10:00"), "UTC+10:00");
  // Utilisation sent as a percentage rather than a fraction.
  assert.match(
    explainRefusal({
      status: 402,
      headers: { ...OVERAGE_OFF, "anthropic-ratelimit-unified-5h-utilization": "35" },
      timezone: SYDNEY,
      now: NOW,
    }),
    /35% used/,
  );
  // Headers that say a window is in trouble but name no reset still say so.
  assert.match(
    explainRefusal({
      status: 402,
      headers: { "anthropic-ratelimit-unified-7d-status": "rejected" },
      timezone: SYDNEY,
      supply: "none",
      now: NOW,
    }),
    /the 7-day window is spent — no second supply is configured/,
  );
});
