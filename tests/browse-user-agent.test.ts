// A pinned `web.browse.user_agent:` against the runner image's Chrome. The
// tool's default user agent follows the installed Chrome, so only a pinned
// one can drift — and Chrome in the image is unpinned (a new major every four
// weeks). check and the deploy warn when the majors differ.
//
//   node --test tests/browse-user-agent.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { chromeMajorOf, runnerEngines, userAgentDrift, webWarnings } from "../src/providers.ts";
import { deployWarnings } from "../src/deploy.ts";

const UA153 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

test("FOLDRUN_RUNNER_ENGINES: names, with the version where the manifest had a dotted one", () => {
  assert.deepEqual(runnerEngines("chromium,chrome=154.0.8037.58,chrome-beta=155.0.8100.2,firefox,lightpanda=0.4.1"), {
    chromium: null, chrome: "154.0.8037.58", "chrome-beta": "155.0.8100.2", firefox: null, lightpanda: "0.4.1",
  });
  assert.deepEqual(runnerEngines("chromium,chrome"), { chromium: null, chrome: null }, "a deploy from before versions");
  assert.equal(runnerEngines(""), null);
  assert.equal(runnerEngines(undefined), null);
  assert.deepEqual(runnerEngines("chrome=Google Chrome 154,webkit"), { webkit: null }, "a value that is not a version is not trusted");
});

test("the Chrome major a user agent claims; none for Firefox, Edge's own token aside", () => {
  assert.equal(chromeMajorOf(UA153), 153);
  assert.equal(chromeMajorOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36"), 154);
  assert.equal(chromeMajorOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"), null);
  assert.equal(chromeMajorOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), null);
});

test("userAgentDrift: a different major warns and says both ways out; the same major, or an unknown image, does not", () => {
  const w = userAgentDrift(UA153, "154.0.8037.58", "web.browse.user_agent");
  assert.match(w!, /pins Chrome 153, and the runner image's Chrome is 154/);
  assert.match(w!, /Drop it \(the default user agent follows the installed Chrome\), or raise it to Chrome\/154/);
  assert.equal(userAgentDrift(UA153, "153.0.7999.1", "x"), null);
  assert.equal(userAgentDrift(UA153, null, "x"), null, "an image that did not say warns about nothing");
  assert.equal(userAgentDrift(undefined, "154.0.1.2", "x"), null);
});

test("webWarnings: the agent's pinned UA and each identity's, on a Chrome engine only", () => {
  const front = {
    web: { browse: { engine: "chrome", user_agent: UA153, identities: { desk: { user_agent: UA153 }, fox: { engine: "firefox", user_agent: UA153 } } } },
  };
  const w = webWarnings(front, { chrome: "154.0.8037.58" });
  assert.equal(w.length, 2, w.join("\n"));
  assert.match(w[0], /^web\.browse\.user_agent pins Chrome 153/);
  assert.match(w[1], /^web\.browse\.identities\.desk\.user_agent pins Chrome 153/);
  assert.deepEqual(webWarnings(front), [], "no image version, nothing to compare");
  assert.deepEqual(webWarnings({ web: { browse: { engine: "firefox", user_agent: UA153 } } }, { chrome: "154.0.1.1" }), []);
});

test("the deploy reports them, with the image's Chrome from FOLDRUN_RUNNER_ENGINES", () => {
  const files = [{ path: "agents/reader/agent.md", content: `---\nname: reader\ntools: [web]\nweb:\n  browse:\n    engine: chrome\n    user_agent: "${UA153}"\n---\nRead.\n` }];
  const saved = process.env.FOLDRUN_RUNNER_ENGINES;
  try {
    process.env.FOLDRUN_RUNNER_ENGINES = "chromium,chrome=154.0.8037.58";
    const w = deployWarnings(files);
    assert.equal(w.length, 1);
    assert.equal(w[0].where, "agents/reader/agent.md");
    assert.match(w[0].message, /pins Chrome 153, and the runner image's Chrome is 154/);
    process.env.FOLDRUN_RUNNER_ENGINES = "chromium,chrome";
    assert.deepEqual(deployWarnings(files), []);
  } finally {
    if (saved === undefined) delete process.env.FOLDRUN_RUNNER_ENGINES;
    else process.env.FOLDRUN_RUNNER_ENGINES = saved;
  }
});
