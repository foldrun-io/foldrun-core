// Which credential a step runs on. An in-process step used to get none —
// the host allowlist drops them — so Claude Code ran on the machine's own
// login whatever key was set.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelCredential, credentialLine } from "../src/model-credential.ts";

test("an API key wins, and the login token is blanked so the key is what is used", () => {
  const c = resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-api-x", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-y" });
  assert.equal(c.kind, "api-key");
  assert.equal(c.label, "API key (ANTHROPIC_API_KEY)");
  assert.deepEqual(c.env, { ANTHROPIC_API_KEY: "sk-ant-api-x", CLAUDE_CODE_OAUTH_TOKEN: "" });
});

test("a gateway bearer comes next, with its base URL", () => {
  const c = resolveModelCredential({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw.example", CLAUDE_CODE_OAUTH_TOKEN: "o" });
  assert.equal(c.kind, "auth-token");
  assert.match(c.label, /ANTHROPIC_AUTH_TOKEN\) to https:\/\/gw\.example/);
  assert.deepEqual(c.env, { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
});

test("a Claude login token (claude setup-token) is used when there is no key", () => {
  const c = resolveModelCredential({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-y", ANTHROPIC_API_KEY: "" });
  assert.equal(c.kind, "claude-login");
  assert.equal(c.label, "Claude login token (CLAUDE_CODE_OAUTH_TOKEN)");
  assert.deepEqual(c.env, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-y", ANTHROPIC_API_KEY: "" });
});

test("nothing set is said loudly, never silently the machine's login", () => {
  const c = resolveModelCredential({ ANTHROPIC_API_KEY: "  " });
  assert.equal(c.kind, "none");
  assert.deepEqual(c.env, {});
  const line = credentialLine(c);
  assert.equal(line.type, "error");
  assert.match(line.text, /claude setup-token/);
  assert.equal(credentialLine(resolveModelCredential({ ANTHROPIC_API_KEY: "k" })).text, "model credential: API key (ANTHROPIC_API_KEY)");
});
