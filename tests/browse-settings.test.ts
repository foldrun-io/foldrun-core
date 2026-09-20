// `web_browse:` carries two things in one key: the browser's identity and,
// optionally, the vendor that renders the page. These are the rules that keep
// the two from standing on each other.
import test from "node:test";
import assert from "node:assert/strict";
import { readBrowseSettings, resolveSearch, webProblems } from "../src/providers.ts";

test("a bare name still means a vendor, and carries no settings", () => {
  const read = readBrowseSettings("browserbase");
  assert.deepEqual(read.settings, {});
  assert.equal(read.rest, "browserbase");
  assert.equal(resolveSearch(read.rest, "browse").provider, "browserbase");
});

test("a block of settings alone means our own browser, configured", () => {
  const read = readBrowseSettings({ engine: "firefox", user_agent: "UA/1.0", timezone: "Australia/Sydney" });
  assert.deepEqual(read.settings, { engine: "firefox", user_agent: "UA/1.0", timezone: "Australia/Sydney" });
  assert.equal(read.rest, undefined, "nothing left for the vendor resolver");
  assert.equal(resolveSearch(read.rest, "browse").provider, null, "unset means the account's own browser");
});

test("settings and a vendor travel in the same block; via: is name:", () => {
  const read = readBrowseSettings({ engine: "webkit", via: "browserbase" });
  assert.deepEqual(read.settings, { engine: "webkit" });
  assert.equal(resolveSearch(read.rest, "browse").provider, "browserbase");
});

test("an engine that does not exist is refused by name, not silently ignored", () => {
  const read = readBrowseSettings({ engine: "opera" });
  assert.match(read.error!, /web_browse\.engine: opera/);
  assert.match(read.error!, /chrome, firefox, safari/, "named the way the room talks, not by engine");
  assert.deepEqual(webProblems({ web_browse: { engine: "opera" } }), [read.error]);
});

// A file should read the way people speak: chrome and safari, not chromium
// and webkit. Underneath they are still the engines Playwright knows, and the
// old spellings keep working so nothing written before this breaks.
test("chrome and safari are what a person writes; the engine is what runs", () => {
  assert.equal(readBrowseSettings({ engine: "chrome" }).settings.engine, "chromium");
  assert.equal(readBrowseSettings({ engine: "safari" }).settings.engine, "webkit");
  assert.equal(readBrowseSettings({ engine: "firefox" }).settings.engine, "firefox");
});

test("the engine names still work, so no agent written before this breaks", () => {
  assert.equal(readBrowseSettings({ engine: "chromium" }).settings.engine, "chromium");
  assert.equal(readBrowseSettings({ engine: "webkit" }).settings.engine, "webkit");
  assert.equal(readBrowseSettings({ engine: "Chrome" }).settings.engine, "chromium", "case is not a trap");
});

test("a setting that is not text is refused", () => {
  assert.match(readBrowseSettings({ user_agent: ["a", "b"] }).error!, /must be text, not a list/);
});

test("check still reports a vendor that cannot work, block or not", () => {
  assert.match(webProblems({ web_browse: { via: "nosuchvendor" } })[0], /no remote browser by that name/);
  assert.deepEqual(webProblems({ web_browse: { engine: "firefox" } }), [], "a good block is not a problem");
});

test("cookies are named in the file, never written into it", () => {
  const good = readBrowseSettings({ cookies: "MEDIUM_COOKIES", cookie_domain: ".medium.com" });
  assert.deepEqual(good.settings, { cookies: "MEDIUM_COOKIES", cookie_domain: ".medium.com" });
  assert.equal(good.error, undefined);
  // The mistake this refuses: the header line pasted where the name goes.
  const bad = readBrowseSettings({ cookies: "sid=1:abc; uid=123" });
  assert.match(bad.error!, /must be the NAME of a vault secret/);
  assert.match(bad.error!, /foldrun secrets set NAME/);
  assert.deepEqual(webProblems({ web_browse: { cookies: "sid=1:abc" } }), [bad.error]);
});

test("a cookie default must name the site it belongs to", () => {
  // Without a domain the cookies would ride on whatever host a call opened,
  // which is an agent handing one site another site's session.
  const loose = readBrowseSettings({ cookies: "MEDIUM_COOKIES" });
  assert.match(loose.error!, /needs web_browse\.cookie_domain beside it/);
  assert.deepEqual(webProblems({ web_browse: { cookies: "MEDIUM_COOKIES" } }), [loose.error]);
  assert.deepEqual(webProblems({ web_browse: { cookies: "MEDIUM_COOKIES", cookie_domain: ".medium.com" } }), []);
});

// Storage is the sibling of cookies, for the sites whose login is not a
// cookie: Firebase writes its record to IndexedDB, MSAL can keep tokens in
// sessionStorage, and a cookie jar alone opens those pages signed out.
test("storage names a secret and carries the origin it belongs to", () => {
  const read = readBrowseSettings({
    storage: "INDIEHACKERS_STORAGE",
    storage_origin: "https://www.indiehackers.com",
  });
  assert.deepEqual(read.settings, {
    storage: "INDIEHACKERS_STORAGE",
    storage_origin: "https://www.indiehackers.com",
  });
  assert.equal(read.error, undefined);
});

test("the storage itself pasted into the file is refused, like cookies", () => {
  const read = readBrowseSettings({ storage: '{"localStorage":{"token":"x"}}', storage_origin: "https://x.com" });
  assert.match(read.error!, /must be the NAME of a vault secret/);
});

test("storage without an origin is refused: storage is walled off per origin", () => {
  const read = readBrowseSettings({ storage: "APP_STORAGE" });
  assert.match(read.error!, /needs web_browse\.storage_origin beside it/);
});

test("a cookie domain is not an origin", () => {
  const read = readBrowseSettings({ storage: "APP_STORAGE", storage_origin: ".example.com" });
  assert.match(read.error!, /must be an origin, scheme and host/);
});
