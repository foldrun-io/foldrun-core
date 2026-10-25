// FOL-58: `deploy_block:` in AGENTS.md turns the scanner's findings into a
// refused deploy. none (the default) only warns; secrets refuses a key
// written into a file; security refuses every scanner warning. The
// workspace's own setting wins over the account's.
//
//   node --test tests/deploy-block.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-deploy-block-"));
const { planDeploy, deployBlockMode, deployBlockers } = await import("../src/deploy.ts");
const { accountDir } = await import("../src/store.ts");

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rand = (n: number) => "7" + [...crypto.randomBytes(n - 2)].map((b) => alphabet[b % alphabet.length]).join("") + "Q";
const KEY = ["sk", "ant", "api03", rand(40)].join("-");

const files = (agentsMd = "---\nname: desk\n---\n") => [
  { path: "AGENTS.md", content: agentsMd },
  { path: "agents/writer/agent.md", content: `---\nname: writer\ndescription: writes\n---\n\nCall the API with ${KEY}.\n` },
  { path: "agents/reader/agent.md", content: "---\nname: reader\ndescription: reads\ntools: [web]\nmcpServers:\n  x:\n    command: npx\n    args: [some-mcp-server]\n---\n\nRead.\n" },
];

const setAccount = (tenant: string, block: string | null) => {
  fs.mkdirSync(accountDir(tenant), { recursive: true });
  fs.writeFileSync(path.join(accountDir(tenant), "AGENTS.md"), `---\nname: ${tenant}\n${block ? `deploy_block: ${block}\n` : ""}---\n`);
};

test("none, the default: the key is a warning and the deploy goes ahead", () => {
  setAccount("a1", null);
  const plan = planDeploy("a1", "desk", files());
  assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues));
  assert.ok(plan.warnings.some((w) => /secret\/hardcoded/.test(w.message)));
});

test("secrets: a key written in is refused; other findings still only warn", () => {
  setAccount("a2", "secrets");
  const plan = planDeploy("a2", "desk", files());
  assert.ok(plan.issues.some((i) => i.where.startsWith("agents/writer/agent.md") && /\[secret\/hardcoded\] — refused: deploy_block: secrets/.test(i.message)));
  assert.ok(!plan.issues.some((i) => /supply-chain/.test(i.message)), "an unpinned MCP server is not a secret");
});

test("security: every scanner warning refuses; a reasoned ignore still accepts one", () => {
  const blockers = deployBlockers(files(), "security");
  assert.ok(blockers.some((b) => /secret\/hardcoded/.test(b.message)));
  assert.ok(blockers.some((b) => /supply-chain\/unpinned-mcp/.test(b.message)), JSON.stringify(blockers));
  const ignored = files().map((f) => (f.path === "agents/writer/agent.md" ? { ...f, content: f.content.replace("Call the API", "<!-- foldrun-ignore secret/hardcoded: test fixture, revoked -->\nCall the API") } : f));
  assert.ok(!deployBlockers(ignored, "secrets").length, "the ignore is honoured");
});

test("the workspace's AGENTS.md wins over the account's; a value it cannot read falls through", () => {
  assert.equal(deployBlockMode(files("---\nname: desk\ndeploy_block: security\n---\n"), { deploy_block: "none" }), "security");
  assert.equal(deployBlockMode(files("---\nname: desk\ndeploy_block: none\n---\n"), { deploy_block: "secrets" }), "none");
  assert.equal(deployBlockMode(files("---\nname: desk\ndeploy_block: strict\n---\n"), { deploy_block: "secrets" }), "secrets");
  assert.equal(deployBlockMode(files(), {}), "none");
  const legacy = files().filter((f) => f.path !== "AGENTS.md").concat([{ path: "project.md", content: "---\nname: desk\ndeploy_block: secrets\n---\n" }]);
  assert.equal(deployBlockMode(legacy, {}), "secrets", "the older project.md is read too");
});

test("the account's network: is read, so a policy above the workspace is not a false refusal (Codex review)", () => {
  const trifecta = [
    { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
    { path: "agents/browser/agent.md", content: "---\nname: browser\ndescription: reads the web\ntools: [web, bash]\nsecrets: [CRM_TOKEN]\n---\n\nRead.\n" },
  ];
  const open = deployBlockers(trifecta, "security");
  const closed = deployBlockers(trifecta, "security", { accountNetwork: "none" });
  assert.ok(open.some((b) => /security\/lethal-trifecta/.test(b.message)), "open network: the trifecta refuses");
  assert.ok(!closed.some((b) => /security\/lethal-trifecta/.test(b.message)), "network: none above takes the open way out away");
  fs.mkdirSync(accountDir("a5"), { recursive: true });
  fs.writeFileSync(path.join(accountDir("a5"), "AGENTS.md"), "---\nname: a5\ndeploy_block: security\nnetwork: none\n---\n");
  assert.ok(!planDeploy("a5", "desk", trifecta).issues.some((i) => /lethal-trifecta/.test(i.message)));
});

test("project.md's network: counts for the scan as it does at runtime (Codex review)", () => {
  const legacy = [
    { path: "project.md", content: "---\nname: desk\nnetwork: none\n---\n" },
    { path: "agents/browser/agent.md", content: "---\nname: browser\ndescription: reads the web\ntools: [web, bash]\nsecrets: [CRM_TOKEN]\n---\n\nRead.\n" },
  ];
  assert.ok(!deployBlockers(legacy, "security").some((b) => /lethal-trifecta/.test(b.message)));
});

test("a workspace tool that replaces an outward library tool is not counted outward (Codex review)", () => {
  const lib = path.join(accountDir("a7"), "library", "tools");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(accountDir("a7"), "AGENTS.md"), "---\nname: a7\ndeploy_block: security\nnetwork: none\n---\n");
  fs.writeFileSync(path.join(lib, "poster.md"), "---\nname: poster\nbase: https://api.example.com\nmethods: [POST]\noutward: true\n---\n\nPosts.\n");
  const agent = { path: "agents/browser/agent.md", content: "---\nname: browser\ndescription: reads the web\ntools: [web, poster]\nsecrets: [CRM_TOKEN]\n---\n\nRead.\n" };
  const withLibrary = planDeploy("a7", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }, agent]);
  const overridden = planDeploy("a7", "desk", [
    { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
    agent,
    { path: "tools/poster/tool.md", content: "---\nname: poster\nbase: https://api.example.com\nmethods: [GET]\n---\n\nReads only.\n" },
  ]);
  const trifecta = (p: { issues: { message: string }[] }) => p.issues.some((i) => /lethal-trifecta/.test(i.message));
  assert.ok(trifecta(withLibrary), "the library's outward poster is a way out");
  assert.ok(!trifecta(overridden), "the workspace's own poster replaces it");
});

test("a workspace tool is matched by its name:, not its file name (Codex review)", () => {
  const ws = (tool: { path: string; content: string }) =>
    planDeploy("a7", "desk", [
      { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
      { path: "agents/browser/agent.md", content: "---\nname: browser\ndescription: reads the web\ntools: [web, poster]\nsecrets: [CRM_TOKEN]\n---\n\nRead.\n" },
      tool,
    ]).issues.some((i) => /lethal-trifecta/.test(i.message));
  assert.ok(ws({ path: "tools/poster.md", content: "---\nname: reader\nbase: https://api.example.com\nmethods: [GET]\n---\n" }), "a file called poster that is named reader does not replace poster");
  assert.ok(!ws({ path: "tools/readonly.md", content: "---\nname: poster\nbase: https://api.example.com\nmethods: [GET]\n---\n" }), "a tool named poster in another file does");
  assert.ok(ws({ path: "tools/poster.md", content: "---\nname: poster\n---\n\nNo base, no run.\n" }), "an invalid definition does not replace the library's");
});

test("a deploy path spelled ./AGENTS.md is read as AGENTS.md (Codex review)", () => {
  setAccount("a8", null);
  const dotted = files("---\nname: desk\ndeploy_block: secrets\n---\n").map((f) => ({ ...f, path: `./${f.path}` }));
  assert.ok(planDeploy("a8", "desk", dotted).issues.some((i) => /refused: deploy_block: secrets/.test(i.message)));
});

test("security also refuses a flow that acts outside with no check or approval (Codex review)", () => {
  const outward = [
    { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
    { path: "tools/poster/tool.md", content: "---\nname: poster\nbase: https://api.example.com\nmethods: [POST]\noutward: true\n---\n" },
    { path: "agents/sender/agent.md", content: "---\nname: sender\ndescription: sends\ntools: [poster]\n---\n\nSend.\n" },
    { path: "flows/send.md", content: "---\nname: send\ntrigger: manual\n---\n\n1. [[sender]] — send it\n" },
  ];
  assert.ok(deployBlockers(outward, "security").some((b) => /flow\/outward-ungated/.test(b.message)), JSON.stringify(deployBlockers(outward, "security")));
  assert.ok(!deployBlockers(outward, "secrets").some((b) => /outward-ungated/.test(b.message)), "secrets mode is secrets only");
});

test("an outward tool from the library counts for outward-ungated too (Codex review)", () => {
  const flowFiles = [
    { path: "AGENTS.md", content: "---\nname: desk\n---\n" },
    { path: "agents/sender/agent.md", content: "---\nname: sender\ndescription: sends\ntools: [poster]\n---\n\nSend.\n" },
    { path: "flows/send.md", content: "---\nname: send\ntrigger: manual\n---\n\n1. [[sender]] — send it\n" },
  ];
  assert.ok(planDeploy("a7", "desk", flowFiles).issues.some((i) => /flow\/outward-ungated/.test(i.message)), "a7's library poster is outward");
  const replaced = flowFiles.concat([{ path: "tools/poster/tool.md", content: "---\nname: poster\nbase: https://api.example.com\nmethods: [GET]\n---\n" }]);
  assert.ok(!planDeploy("a7", "desk", replaced).issues.some((i) => /outward-ungated/.test(i.message)), "replaced by a read-only one");
});

test("two entries for one AGENTS.md: the last wins, as the save keeps it (Codex review)", () => {
  setAccount("a9", null);
  const both = [
    { path: "AGENTS.md", content: "---\nname: desk\ndeploy_block: none\n---\n" },
    ...files("---\nname: desk\ndeploy_block: secrets\n---\n").map((f) => (f.path === "AGENTS.md" ? { ...f, path: "./AGENTS.md" } : f)),
  ];
  assert.ok(planDeploy("a9", "desk", both).issues.some((i) => /refused: deploy_block: secrets/.test(i.message)));
});
