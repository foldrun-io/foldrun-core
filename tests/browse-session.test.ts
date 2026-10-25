// `web.browse.vendor_session:` — what a vendor's own session is asked for, checked
// against what that vendor's docs say it offers. A setting it has no option
// for is an error naming the vendors that do; nothing is quietly dropped.
//
//   node --test tests/browse-session.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readBrowseSettings, readBrowseSession, browseSessionProblems, webProblems, webWarnings, BROWSER_APIS } from "../src/providers.ts";

const problems = (block: Record<string, unknown>, vendor: string | null) => browseSessionProblems(readBrowseSettings(block).settings, vendor);

test("the block's shape: durations, locations, a secret for your own proxy", () => {
  assert.deepEqual(readBrowseSession({ timeout: "30m", proxy: { country: "au", city: "Sydney" }, block: "ads, cookies", captcha: "false" }).session, {
    timeout: 1800, proxy: { country: "AU", city: "Sydney" }, block: ["ads", "cookies"], captcha: false,
  });
  assert.equal(readBrowseSession({ timeout: 90 }).session?.timeout, 90);
  assert.match(readBrowseSession({ timeout: "soon" }).error!, /a duration, like 90s/);
  assert.match(readBrowseSession({ proxy: { own: "http://u:p@h:1" } }).error!, /the NAME, never the URL/);
  assert.match(readBrowseSession({ proxy: { own: "MY_PROXY", country: "AU" } }).error!, /drop country/);
  assert.match(readBrowseSession({ proxy: { country: "AUS" } }).error!, /two-letter code/);
  assert.match(readBrowseSession({ proxy: { country: "AU", state: "NS" } }).error!, /state is for the US only/);
  assert.match(readBrowseSession({ block: ["popups"] }).error!, /ads, trackers, cookies — not popups/);
  assert.match(readBrowseSession({ keep: "Client Portal" }).error!, /short name in lower case/);
  assert.match(readBrowseSession({ speed: "fast" }).error!, /vendor_session\.speed: is not a session setting/);
  assert.match(readBrowseSettings({ vendor_session: "yes" }).error!, /web\.browse\.vendor_session is a block/);
  assert.match(readBrowseSettings({ session: "yes" }).error!, /web\.browse\.session is a block/, "the old key's errors name the key as written");
});

test("everything a vendor offers passes; a session with no vendor is refused", () => {
  const all = { vendor_session: { proxy: { country: "US", state: "CA", city: "Los Angeles" }, captcha: true, stealth: true, region: "us-east-1", timeout: "1h", keep: "portal", record: true, block: ["ads"], options: { x: 1 } } };
  assert.deepEqual(problems(all, "browserbase"), []);
  assert.match(problems({ vendor_session: { captcha: true } }, null)[0], /the account's own — name one with via:/);
});

test("an option the vendor has not got names the vendors that have it", () => {
  assert.match(problems({ vendor_session: { region: "us-east" } }, "steel")[0], /region: Steel has no such option\. These do: browserbase, hyperbrowser, browserless/);
  assert.match(problems({ vendor_session: { keep: "x" } }, "browserless")[0], /keep: Browserless has no such option\. These do: browserbase, steel, hyperbrowser/);
  assert.match(problems({ vendor_session: { captcha: true } }, "zenrows")[0], /captcha: ZenRows Scraping Browser has no such option/);
  assert.match(problems({ vendor_session: { block: ["trackers"] } }, "browserbase")[0], /cannot block trackers\. These can: hyperbrowser/);
  assert.match(problems({ vendor_session: { proxy: { state: "CA" } } }, "brightdata")[0], /proxy\.state: .* These do: browserbase, steel, hyperbrowser/);
  assert.match(problems({ vendor_session: { options: { a: 1 } } }, "brightdata")[0], /takes no options/);
});

test("ranges and names from the vendor's docs", () => {
  assert.match(problems({ vendor_session: { region: "mars" } }, "browserbase")[0], /regions are us-west-2, us-east-1, eu-central-1, ap-southeast-1 — not mars/);
  assert.match(problems({ vendor_session: { timeout: "20m" } }, "zenrows")[0], /takes 60s to 900s, not 1200s/);
  assert.match(problems({ vendor_session: { timeout: "10s" } }, "browserbase")[0], /takes 60s to 21600s/);
});

test("a vendor's own rules for a location: Browserbase needs the country, Hyperbrowser a state or a city", () => {
  assert.match(problems({ vendor_session: { proxy: { city: "Sydney" } } }, "browserbase")[0], /needs a country/);
  assert.match(problems({ vendor_session: { proxy: { country: "US", state: "NY", city: "Albany" } } }, "hyperbrowser")[0], /a state or a city, not both/);
  assert.deepEqual(problems({ vendor_session: { proxy: { country: "US", state: "NY", city: "Albany" } } }, "steel"), []);
});

test("an always-on proxy cannot be switched off; true is fine", () => {
  assert.match(problems({ vendor_session: { proxy: false } }, "brightdata")[0], /always goes through its own proxy network/);
  assert.deepEqual(problems({ vendor_session: { proxy: true } }, "zenrows"), []);
});

test("ZenRows refuses a changed user agent or device, whether or not a session block is written", () => {
  assert.match(problems({ user_agent: "UA/1" }, "zenrows")[0], /web\.browse\.user_agent: ZenRows Scraping Browser does not let a session change it/);
  assert.match(problems({ device: "Pixel 7" }, "zenrows")[0], /device/);
  assert.deepEqual(problems({ user_agent: "UA/1" }, "browserbase"), []);
});

test("a saved login uses the vendor's own browser as it stands, so identity settings beside it are refused", () => {
  const p = problems({ vendor_session: { keep: "portal" }, locale: "en-AU", user_agent: "UA" }, "steel");
  assert.equal(p.length, 2);
  assert.match(p[0], /with vendor_session\.keep the vendor's saved browser is used as it stands/);
});

test("check sees it through the web: block, worded that way", () => {
  assert.match(webProblems({ web: { browse: { via: "steel", vendor_session: { region: "us-east" } } } })[0], /^web\.browse\.vendor_session\.region: Steel has no such option/);
  assert.deepEqual(webProblems({ web: { browse: { via: "hyperbrowser", vendor_session: { region: "europe-west", block: ["cookies"] } } } }), []);
});

test("every vendor but a bare DevTools address says what its session takes", () => {
  for (const b of BROWSER_APIS) if (b.name !== "cdp") assert.ok(b.session, b.name);
});

test("session: is the old name of vendor_session: — still read, warned about, and never both", () => {
  const old = readBrowseSettings({ via: "steel", session: { captcha: true } });
  assert.deepEqual(old.settings.vendor_session, { captcha: true }, "the old key fills the same setting");
  assert.deepEqual(problems({ session: { region: "us-east" } }, "steel").length, 1, "and is checked the same way");
  assert.match(readBrowseSettings({ vendor_session: { captcha: true }, session: { captcha: true } }).error!, /keep vendor_session: only/);
  const w = webWarnings({ web: { browse: { via: "steel", session: { captcha: true } } } });
  assert.equal(w.length, 1);
  assert.match(w[0], /^web\.browse\.session: is now vendor_session:/);
  assert.match(w[0], /a call's session= \(a named saved login\)/);
  assert.deepEqual(webWarnings({ web: { browse: { via: "steel", vendor_session: { captcha: true } } } }), []);
});
