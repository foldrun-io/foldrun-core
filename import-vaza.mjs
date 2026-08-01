#!/usr/bin/env node
// Import Vaza's agents and skills into an mdagent project.
//
// Vaza already stores agents as agents/<id>/AGENT.md and skills as
// skills/<id>/SKILL.md with an `agent:` field naming the owner, so this is
// mostly a re-parenting exercise: each skill moves under the agent that owns
// it, and Vaza's tool vocabulary maps onto mdagent's.
//
//   node scripts/import-vaza.mjs <vaza-agent-dir> <output-dir>

import fs from "node:fs";
import path from "node:path";

const [, , sourceArg, outArg] = process.argv;
if (!sourceArg) {
  console.error("usage: node scripts/import-vaza.mjs <vaza-agent-dir> [output-dir]");
  process.exit(1);
}
const SOURCE = path.resolve(sourceArg);
const OUT = path.resolve(outArg ?? "vaza-agents");

// Vaza tool names → mdagent's coarser groups.
const TOOL_MAP = {
  read: "read",
  glob: "read",
  grep: "read",
  write: "files",
  edit: "files",
  websearch: "web",
  webfetch: "web",
  bash: "bash",
};

// `files` supersedes `read` — granting both would be redundant.
const collapse = (tools) => (tools.includes("files") ? tools.filter((t) => t !== "read") : tools);

// Frontmatter is simple enough here that a tiny reader beats a dependency.
function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].replace(/\s+#.*$/, "").trim(); // strip trailing comments
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    data[kv[1]] = value;
  }
  return { data, body: m[2] };
}

const yamlString = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

function write(rel, content) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

fs.rmSync(OUT, { recursive: true, force: true });

// ---- agents ----
const agentDirs = fs.readdirSync(path.join(SOURCE, "agents"));
const agents = new Map();

for (const id of agentDirs) {
  const file = path.join(SOURCE, "agents", id, "AGENT.md");
  if (!fs.existsSync(file)) continue;
  const { data, body } = frontmatter(fs.readFileSync(file, "utf8"));

  const tools = collapse([...new Set((data.tools ?? []).map((t) => TOOL_MAP[t]).filter(Boolean))]);
  // research-analyst deliberately has no write tools; keep that property.
  const description =
    data.displayName ??
    body.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.slice(0, 100) ??
    id;

  const front = [
    `name: ${id}`,
    `description: ${yamlString(description)}`,
    // Heavier models for the agents that write code or content.
    `model: ${["repo-fixer", "site-editor"].includes(id) ? "max" : "default"}`,
    "tools:",
    ...tools.map((t) => `  - ${t}`),
  ].join("\n");

  write(`agents/${id}/agent.md`, `---\n${front}\n---\n${body}`);
  agents.set(id, { skills: 0, tools });
}

// ---- skills, re-parented under the agent that owns them ----
let orphans = 0;
for (const id of fs.readdirSync(path.join(SOURCE, "skills"))) {
  const file = path.join(SOURCE, "skills", id, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  const { data, body } = frontmatter(fs.readFileSync(file, "utf8"));

  const owner = data.agent && agents.has(data.agent) ? data.agent : null;
  if (!owner) {
    orphans += 1;
    continue;
  }

  // mdagent reads `name` and `description`; keep Vaza's metadata alongside so
  // nothing is lost on the round trip.
  const keep = ["category", "domain", "difficulty", "tier", "riskTier", "estMinutes"];
  const front = [
    `name: ${id}`,
    `description: ${yamlString(data.description ?? data.displayName ?? id)}`,
    ...keep.filter((k) => data[k] !== undefined).map((k) => `${k}: ${yamlString(data[k])}`),
  ].join("\n");

  write(`agents/${owner}/skills/${id}/SKILL.md`, `---\n${front}\n---\n${body}`);
  agents.get(owner).skills += 1;
}

// ---- project + a flow mirroring Vaza's real pipeline ----
write(
  "project.md",
  `---\nname: vaza\ndescription: ${yamlString(
    "Vaza's agent team, imported from vaza-agent — research, fixes, content, and site edits.",
  )}\n---\n\nImported from \`vaza-agent\`. Agents and skills keep their original definitions;\nonly the frontmatter vocabulary is translated.\n`,
);

write(
  "flows/aeo-cycle.md",
  `---
name: aeo-cycle
trigger: manual
---

1. [[research-analyst]] — research what the site should target this cycle: prompts, keywords, topic gaps
2. [[repo-fixer]] — apply the technical AEO and accessibility fixes the research implies
2 [[content-writer]] — draft the content the research calls for
3. [[site-editor]] — review both changes together and report what shipped
`,
);

console.log(`Imported into ${OUT}`);
for (const [id, info] of agents) {
  console.log(`  ${id.padEnd(18)} ${String(info.skills).padStart(3)} skills   tools: ${info.tools.join(", ") || "none"}`);
}
if (orphans) console.log(`  (${orphans} skills had no matching agent and were skipped)`);
