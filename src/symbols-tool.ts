// tools: [symbols] in a cloud step (FOL-297): the Symbols tool of foldrun
// code (lsp.ts), served to a step as an in-process MCP server, as
// extract_text is (text-tool.ts). The step's container is the boundary
// programs run inside, so the language server runs there; it reads only what
// the file tools may (confine.ts: the workspace and the library, never
// secrets or the run journal), and its servers are installed per step into
// the container's own temporary folder.

import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkPaths, expandVirtual, type Roots } from "./confine.ts";
import { symbols, stopServers, SYMBOLS_DESCRIPTION } from "./lsp.ts";
import type { ToolContext } from "./engine-tools.ts";

export const SYMBOLS_SERVER = "foldrun_symbols";
export const SYMBOLS_TOOL = `mcp__${SYMBOLS_SERVER}__symbols`;

export function symbolsPromptLine(): string {
  return (
    "`symbols` finds where a name is defined, or every place it is used, with a language server (TypeScript and JavaScript, Python, Go): " +
    "give the file (`workspace/…` for the workspace's folders), the line, and the name as written on that line. " +
    "It follows imports and types as the compiler does, which a text search cannot; its first call for a language installs that language's server (some seconds)."
  );
}

type Emit = (type: "info" | "error", text: string) => void;

/** The `symbols` tool for one step: `agentDir` is where relative paths start; the language servers see the
 *  workspace root as the project. `toolsDir` is for tests (default: a folder in the container's temp). */
export function buildSymbolsTools(opts: { agentDir: string; workspaceRoot: string; libraryRoot: string; toolsDir?: string; env?: Record<string, string | undefined>; emit?: Emit }) {
  const roots: Roots = { agentDir: opts.agentDir, workspaceRoot: opts.workspaceRoot, libraryRoot: opts.libraryRoot };
  const stop = new AbortController();
  // One context for the step: its servers are started once and live until the step ends (close()).
  const ctx: ToolContext = {
    cwd: opts.workspaceRoot,
    env: opts.env ?? process.env,
    signal: stop.signal,
    reads: new Map(),
    groups: new Set(),
    programs: true,
    toolsDir: opts.toolsDir ?? path.join(os.tmpdir(), "foldrun-lsp"),
    // What the file tools may read, and nothing else is shown (Codex).
    readable: (file: string) => checkPaths("Read", { file_path: file }, roots).ok,
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const run = tool(
    "symbols",
    SYMBOLS_DESCRIPTION,
    {
      action: z.enum(["definition", "references"]).describe("definition: where it is defined; references: every place it is used"),
      file_path: z.string().describe("The file the name is written in, relative to your agent folder, or workspace/… for the workspace"),
      line: z.number().int().describe("The line it is on, counting from 1"),
      symbol: z.string().optional().describe("The name as written on that line"),
      column: z.number().int().optional().describe("Instead of symbol, or to choose between two on one line: the column, counting from 1"),
    },
    async (args) => {
      const verdict = checkPaths("Read", { file_path: args.file_path }, roots);
      if (!verdict.ok) return { ...text((verdict.reason ?? `"${args.file_path}" may not be read`).replace(/^Read was denied/, "symbols was refused")), isError: true };
      const abs = expandVirtual(args.file_path, roots)?.abs ?? path.resolve(roots.agentDir, args.file_path);
      const r = await symbols.run({ ...args, file_path: abs }, ctx);
      if (r.isError) opts.emit?.("info", `symbols: ${r.text.slice(0, 200)}`);
      return { ...text(r.text), ...(r.isError ? { isError: true } : {}) };
    },
  );
  return {
    server: createSdkMcpServer({ name: SYMBOLS_SERVER, version: "1.0.0", tools: [run] }),
    toolNames: [SYMBOLS_TOOL],
    promptLines: [symbolsPromptLine()],
    /** End the step's language servers. */
    close: () => {
      // Not the signal: a later call (a retried attempt) starts them again.
      stopServers(ctx);
      for (const g of ctx.groups) {
        try {
          process.kill(-g, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      ctx.groups.clear();
    },
    /** The tool's own function, for tests. */
    call: (args: { action: string; file_path: string; line: number; symbol?: string; column?: number }) => run.handler(args as never, {}),
  };
}
