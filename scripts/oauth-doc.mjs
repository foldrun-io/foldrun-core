#!/usr/bin/env node
// Write the customer page foldrun-docs/oauth.md from src/oauth-capabilities.ts,
// the one list of every kind of OAuth and what foldrun does about it.
//
//   node scripts/oauth-doc.mjs           write ../foldrun-docs/oauth.md
//   node scripts/oauth-doc.mjs --check   exit 1 when it is stale

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../foldrun-docs/oauth.md");

export async function render() {
  const { OAUTH_CAPABILITIES } = await import(pathToFileURL(path.resolve(here, "../src/oauth-capabilities.ts")).href);
  const mark = { supported: "Supported", planned: "Planned", refused: "Refused", "not-needed": "Not needed" };
  const table = (rows) => [
    "| What | Spec | Status | How, or why not |",
    "|---|---|---|---|",
    ...rows.map((c) => `| ${c.title} | ${c.spec} | ${mark[c.status]} | ${c.note.replace(/\|/g, "\\|")} |`),
  ].join("\n");
  const client = OAUTH_CAPABILITIES.filter((c) => c.role === "client" && !c.id.startsWith("refused."));
  const server = OAUTH_CAPABILITIES.filter((c) => c.role === "server" && !c.id.startsWith("refused."));
  const refused = OAUTH_CAPABILITIES.filter((c) => c.id.startsWith("refused."));
  return `---
title: OAuth support
description: Every kind of OAuth, and what foldrun does about it — when an agent connects to a provider, and when an AI app signs in to foldrun.
---

<!-- Generated from foldrun-core/src/oauth-capabilities.ts by
     \`node scripts/oauth-doc.mjs\` in foldrun-core. Edit the list, not this page. -->

# OAuth support

foldrun meets OAuth in two roles:

- **As a client.** An agent reaches Google, Slack, Notion or a bank. You
  connect the account once ([connected accounts](secrets#connected-accounts)),
  and foldrun holds the token and refreshes it.
- **As an authorization server.** An AI app such as claude.ai signs in to
  foldrun's MCP endpoint ([MCP](mcp)), and foldrun issues the token.

Each row that says *Supported* is proven by tests that run against a real
authorization server (Keycloak) and against recorded provider answers.

## When an agent connects to a provider

${table(client)}

## When an AI app signs in to foldrun (\`/api/mcp\`)

${table(server)}

## Refused on purpose

These are refused, and the error says why. They are never quietly ignored.

${table(refused)}
`;
}

async function main() {
  const text = await render();
  if (process.argv.includes("--check")) {
    const now = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (now !== text) {
      console.error("foldrun-docs/oauth.md is stale — run node scripts/oauth-doc.mjs in foldrun-core");
      process.exit(1);
    }
    console.log("foldrun-docs/oauth.md is current");
    return;
  }
  fs.writeFileSync(target, text);
  console.log(`wrote ${target}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
