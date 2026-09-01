// Two tools over what an agent already has and cannot easily reach at scale:
// its documents, and its own past.
//
//   tools: [search]    search_files — ranked full-text search over knowledge,
//                      memory, state and storage, all three scopes
//   tools: [history]   recall_runs / read_run — what this workspace's earlier
//                      runs concluded, and what their steps said
//
// Both take values, not stores: a list of directories, a list of run
// digests. That is what lets the same servers be rebuilt inside a run
// container, where the vault, the run journal and the account do not exist
// — the host gathers, the boundary is crossed as JSON, the container serves.
//
// Search is lexical (a BM25-shaped score over tokens), not embeddings. It
// runs anywhere, needs no vendor, and nothing leaves the box — which is the
// property the search-on-our-box work already paid for. A workspace with a
// few hundred memory files is what this is for; at tens of thousands an
// index would be the next step, and it would be built on the same tool.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { RunRecord } from "./store.ts";

// ------------------------------------------------------------------ search

export interface SearchRoot {
  /** How the agent should name the place: "knowledge/", "../../memory/". */
  label: string;
  /** The directory, absolute. */
  dir: string;
}

const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".html", ".tsv"]);
const MAX_FILE_BYTES = 512_000;
const MAX_FILES = 5_000;

interface Doc {
  label: string;
  rel: string;
  text: string;
  /** Frontmatter name/title/description, weighted higher than the body. */
  head: string;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$@._-]+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length > 1);
}

function readDocs(roots: SearchRoot[]): Doc[] {
  const docs: Doc[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (docs.length >= MAX_FILES) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          walk(abs);
          continue;
        }
        if (!e.isFile() || !TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        // OKF's generated files describe the bundle, not a fact in it.
        if (e.name === "index.md" || e.name === "log.md") continue;
        try {
          if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(abs, "utf8");
          const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
          const head = [...front.matchAll(/^(?:name|title|description):\s*(.+)$/gm)].map((m) => m[1]).join(" ");
          docs.push({ label: root.label, rel: path.relative(root.dir, abs).replaceAll("\\", "/"), text, head });
        } catch {
          // unreadable: not a hit
        }
      }
    };
    walk(root.dir);
  }
  return docs;
}

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

/**
 * Rank documents for a query. BM25's shape — term frequency saturating,
 * rare terms weighing more, long documents not winning by bulk — with the
 * frontmatter head counted three times, because a memory file's name and
 * description are what its author thought it was about.
 */
export function rankDocs(docs: Doc[], query: string, limit: number): SearchHit[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0 || docs.length === 0) return [];
  const bodies = docs.map((d) => tokens(d.head + " " + d.head + " " + d.head + " " + d.text));
  const avg = bodies.reduce((n, b) => n + b.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const b of bodies) for (const t of new Set(b)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4;
  const bParam = 0.75;
  const scored = docs.map((d, i) => {
    const b = bodies[i];
    const tf = new Map<string, number>();
    for (const t of b) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - bParam + bParam * (b.length / avg))));
    }
    return { d, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ d, score }) => ({ path: `${d.label}${d.rel}`, score: Math.round(score * 100) / 100, snippet: snippetFor(d.text, q) }));
}

/** The line that mentions the most query terms, trimmed — enough to tell
 *  whether to open the file, not a substitute for opening it. */
function snippetFor(text: string, q: string[]): string {
  let best = "";
  let bestN = 0;
  for (const line of text.split("\n")) {
    const l = line.toLowerCase();
    const n = q.filter((t) => l.includes(t)).length;
    if (n > bestN && line.trim()) {
      bestN = n;
      best = line.trim();
    }
  }
  return best.length > 200 ? `${best.slice(0, 197)}…` : best;
}

export function searchRoots(roots: SearchRoot[], query: string, limit = 10): SearchHit[] {
  return rankDocs(readDocs(roots), query, Math.min(Math.max(1, limit), 30));
}

export interface ContextToolResult {
  server: ReturnType<typeof createSdkMcpServer> | null;
  toolNames: string[];
  promptLines: string[];
}

export function buildSearchTools(roots: SearchRoot[]): ContextToolResult {
  if (roots.length === 0) return { server: null, toolNames: [], promptLines: [] };
  const search = tool(
    "search_files",
    `Full-text search over this agent's knowledge, memory, state and stored files (all scopes: own, workspace, account). ` +
      `Returns the best-matching paths with a one-line snippet each — open a hit with Read to use it. ` +
      `Use it instead of guessing which of many files holds a fact.`,
    {
      query: z.string().describe("Words to look for — names, ids, phrases"),
      limit: z.number().int().min(1).max(30).optional().describe("How many hits (default 10)"),
    },
    async (args) => {
      const hits = searchRoots(roots, args.query, args.limit ?? 10);
      const text = hits.length
        ? hits.map((h) => `${h.path}  (${h.score})\n    ${h.snippet}`).join("\n")
        : "no files mention that";
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: "foldrun_search", version: "1.0.0", tools: [search] }),
    toolNames: ["mcp__foldrun_search__search_files"],
    promptLines: [
      `- **search_files(query)** — ranked search across ${roots.map((r) => r.label).join(", ")}. Search first, then Read the hit.`,
    ],
  };
}

// ----------------------------------------------------------------- history

export interface RunDigest {
  id: string;
  flow: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  costUsd: number;
  tags: string[];
  steps: { agent: string; status: string; result: string | null }[];
}

const STEP_RESULT_CHARS = 6_000;

/** The digest of a workspace's recent runs — host-side, from the records. */
export function digestRuns(runs: RunRecord[], limit = 30, exceptRunId?: string): RunDigest[] {
  return runs
    .filter((r) => r.id !== exceptRunId && (r.status === "completed" || r.status === "failed"))
    .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      flow: r.flow,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      summary: r.summary ?? null,
      costUsd: r.steps.reduce((n, s) => n + (s.costUsd ?? 0), 0),
      tags: r.tags ?? [],
      steps: r.steps
        .filter((s) => s.status === "completed" || s.status === "failed")
        .map((s) => ({
          agent: s.agent,
          status: s.status,
          result: s.result ? (s.result.length > STEP_RESULT_CHARS ? `${s.result.slice(0, STEP_RESULT_CHARS)}…` : s.result) : null,
        })),
    }));
}

export function buildHistoryTools(digest: RunDigest[]): ContextToolResult {
  const recall = tool(
    "recall_runs",
    `What this workspace's earlier runs concluded — newest first, one line each (id, flow, when, status, cost, summary). ` +
      `Filter by flow, status or a word. Use it to avoid redoing yesterday's work, to continue where a run left off, ` +
      `or to see what a scheduled flow found last time. Then read_run(id) for the detail.`,
    {
      limit: z.number().int().min(1).max(50).optional().describe("How many (default 10)"),
      flow: z.string().optional().describe("Only runs of this flow"),
      status: z.enum(["completed", "failed"]).optional(),
      query: z.string().optional().describe("Only runs whose summary or results mention this"),
    },
    async (args) => {
      const q = (args.query ?? "").toLowerCase();
      const rows = digest
        .filter((r) => !args.flow || r.flow === args.flow)
        .filter((r) => !args.status || r.status === args.status)
        .filter(
          (r) =>
            !q ||
            (r.summary ?? "").toLowerCase().includes(q) ||
            r.steps.some((s) => (s.result ?? "").toLowerCase().includes(q)),
        )
        .slice(0, args.limit ?? 10)
        .map((r) => `${r.id}  ${r.flow}  ${r.startedAt.slice(0, 16)}  ${r.status}  $${r.costUsd.toFixed(3)}  ${r.summary ?? "(no summary)"}`);
      return { content: [{ type: "text" as const, text: rows.length ? rows.join("\n") : "no earlier runs match" }] };
    },
  );
  const read = tool(
    "read_run",
    "One earlier run in full: each step's agent, status and what it replied (long replies trimmed).",
    { id: z.string().describe("A run id from recall_runs") },
    async (args) => {
      const r = digest.find((d) => d.id === args.id);
      if (!r) return { content: [{ type: "text" as const, text: `no run ${args.id} in the recent history` }], isError: true };
      const text =
        `${r.flow} · ${r.status} · started ${r.startedAt}${r.finishedAt ? ` · finished ${r.finishedAt}` : ""} · $${r.costUsd.toFixed(4)}\n` +
        (r.summary ? `summary: ${r.summary}\n` : "") +
        r.steps.map((s) => `\n## ${s.agent} (${s.status})\n${s.result ?? "(no reply)"}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );
  return {
    server: createSdkMcpServer({ name: "foldrun_history", version: "1.0.0", tools: [recall, read] }),
    toolNames: ["mcp__foldrun_history__recall_runs", "mcp__foldrun_history__read_run"],
    promptLines: [
      `- **recall_runs()** / **read_run(id)** — this workspace's last ${digest.length} finished runs and what they concluded. ` +
        `Check before repeating work a recent run already did.`,
    ],
  };
}
