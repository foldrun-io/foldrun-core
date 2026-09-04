#!/usr/bin/env node
// Rewrite `use:` into `tools:` in every agent.md under the given roots.
//
// `use:` was the second spelling for granting an agent its own tools; the
// runtime no longer reads it. This moves each name into `tools:` — merged
// into an existing list in whichever form it is already written (inline
// `[a, b]` or block `- a`), or a fresh inline list where `use:` stood — and
// deletes the `use:` key. Text edits only: comments, order and the rest of
// the frontmatter come through byte-for-byte.
//
//   node scripts/migrate-use-to-tools.mjs <dir> [<dir>...]     rewrite
//   node scripts/migrate-use-to-tools.mjs --check <dir> ...    list, exit 1 if any
//
// Re-runnable: a file with no `use:` is left alone.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Every agent.md below a root, skipping generated and vendored trees. */
function* agentFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "runs") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* agentFiles(full);
    else if (entry.name === "agent.md") yield full;
  }
}

const parseInline = (inside) =>
  inside
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);

/**
 * Rewrite one file's text. Returns the new text, or null when there is no
 * `use:` in the frontmatter.
 */
export function convert(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return null;
  const front = m[1].split(/\r?\n/);

  // 1. Find `use:` and collect its names, in either list form.
  let useAt = -1;
  let useEnd = -1;
  const names = [];
  for (let i = 0; i < front.length; i++) {
    const inline = front[i].match(/^use:\s*\[([^\]]*)\]\s*(#.*)?$/);
    const block = front[i].match(/^use:\s*(#.*)?$/);
    if (inline) {
      names.push(...parseInline(inline[1]));
      useAt = i;
      useEnd = i + 1;
      break;
    }
    if (block) {
      useAt = i;
      let j = i + 1;
      for (; j < front.length; j++) {
        const item = front[j].match(/^\s+-\s*(.+?)\s*(#.*)?$/);
        if (!item) break;
        names.push(item[1].replace(/^["']|["']$/g, ""));
      }
      useEnd = j;
      break;
    }
  }
  if (useAt < 0) return null;
  front.splice(useAt, useEnd - useAt);

  // 2. Merge into `tools:` — the form it already has, or a new inline list.
  let toolsAt = front.findIndex((l) => /^tools:/.test(l));
  if (toolsAt < 0) {
    if (names.length) front.splice(useAt, 0, `tools: [${names.join(", ")}]`);
  } else {
    const inline = front[toolsAt].match(/^tools:\s*\[([^\]]*)\]\s*(#.*)?$/);
    if (inline) {
      const have = parseInline(inline[1]).map((n) => n.split(":")[0].trim());
      const add = names.filter((n) => !have.includes(n));
      const list = [...parseInline(inline[1]), ...add].join(", ");
      front[toolsAt] = `tools: [${list}]${inline[2] ? ` ${inline[2]}` : ""}`;
    } else {
      // Block form: append after the last `- item`, matching its indent.
      let j = toolsAt + 1;
      let indent = "  ";
      const have = [];
      for (; j < front.length; j++) {
        const item = front[j].match(/^(\s+)-\s*(.+?)\s*(#.*)?$/);
        if (!item) break;
        indent = item[1];
        have.push(item[2].split(":")[0].trim());
      }
      const add = names.filter((n) => !have.includes(n)).map((n) => `${indent}- ${n}`);
      front.splice(j, 0, ...add);
    }
  }

  return text.slice(0, m.index) + `---\n${front.join("\n")}\n---` + text.slice(m.index + m[0].length - m[2].length);
}

// Run as a command; importable (the tests do) without touching a file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const roots = args.filter((a) => a !== "--check");
  if (!roots.length) {
    console.error("usage: migrate-use-to-tools.mjs [--check] <dir> [<dir>...]");
    process.exit(2);
  }
  let changed = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of agentFiles(root)) {
      const before = fs.readFileSync(file, "utf8");
      const after = convert(before);
      if (after === null || after === before) continue;
      changed++;
      if (check) {
        console.log(file);
      } else {
        fs.writeFileSync(file, after);
        console.log(`rewrote ${file}`);
      }
    }
  }
  if (check && changed) process.exit(1);
  if (!check) console.log(`${changed} file(s) rewritten`);
}
