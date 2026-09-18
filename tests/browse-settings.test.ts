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
  const read = readBrowseSettings({ engine: "safari" });
  assert.match(read.error!, /web_browse\.engine: safari/);
  assert.match(read.error!, /chromium, firefox, webkit/);
  assert.deepEqual(webProblems({ web_browse: { engine: "safari" } }), [read.error]);
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
