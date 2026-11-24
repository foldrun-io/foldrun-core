// MCP servers on foldrun's own loop (FOL-213): every tool beyond the six
// file and shell tools reaches a step as an MCP server — foldrun's own, made
// in this process (createSdkMcpServer: `foldrun_scripts` with `web` search,
// fetch and browse; agents, apis, a2a, install, ask, peers, history), and an
// agent's own `mcpServers:` (stdio, http, sse). The SDK connected them inside
// the Claude Code binary; this connects them here, so the loop offers the
// same tools under the same names.
//
// What stays where it was:
//   - the tools run where they always ran — the browser pod, the egress
//     proxy and its search door, the vault's site-bound secrets are behind
//     the server, not in this file;
//   - each tool is offered as `mcp__<server>__<tool>`, the SDK's name, so
//     step-exec's grant (`mcpNames`), limits, hooks and the run record read
//     it as before, and every call goes through the loop's permission order
//     (engine-common.ts decide/after);
//   - a server that does not connect refuses the step by name. The SDK went
//     on without its tools; a step that runs without a tool it was given is
//     the failure this engine refuses to have.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { EngineTool, ToolOutcome } from "./engine-tools.ts";

type Json = Record<string, unknown>;

export { grantedServer, ENGINE_MCP_FEATURES, checkMcpSpecs } from "./mcp-specs.ts";
export type { McpSpec } from "./mcp-specs.ts";
import { grantedServer, type McpSpec } from "./mcp-specs.ts";

/** Longest a call may run when its server names no timeout: the step's own
 *  timeout ends it sooner (the loop's signal). */
const DEFAULT_CALL_MS = 24 * 60 * 60 * 1000;
/** The longest a timer holds (2^31 − 1 ms, ~24.8 days); past it Node fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const CONNECT_MS = 60_000;
/** The most text one call hands the model; the rest is said to be cut. */
const MAX_TEXT = 100_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface McpConnection {
  tools: EngineTool[];
  /** Which server offered each tool, by its full name. */
  owner: Map<string, string>;
  /** What each server told its client to tell the model (MCP `instructions`),
   *  which the SDK put in the system prompt; so does the loop. */
  instructions: { server: string; text: string }[];
  servers: { name: string; status: "connected" }[];
  close(): Promise<void>;
  /** Ends every stdio server and what it started, at once and without
   *  waiting: for a host that is itself exiting. */
  kill(): void;
}

import { LAUNCHER, killTree, treePids } from "./local-sandbox.ts";
import type { SandboxWalls } from "./engine-common.ts";

/** A program and its arguments as one shell line, each word quoted. */
export function shellLine(command: string, args: string[]): string {
  return [command, ...args].map((w) => `'${w.replaceAll("'", `'\\''`)}'`).join(" ");
}

function transportFor(s: McpSpec, env: Record<string, string | undefined>, cwd: string, wrapped?: string, viaProxy?: typeof fetch): { client: Transport; server?: Transport } {
  if (s.type === "sdk") {
    const [client, server] = InMemoryTransport.createLinkedPair();
    return { client, server };
  }
  if (s.type === "stdio") {
    // The step's environment, as the SDK gave it: already the allowlisted
    // one (host-env.ts: the clock, the proxy that is the way out, declared
    // secrets), never this process's. Then what the spec names. The MCP
    // library adds PATH, HOME, SHELL, TERM, USER and LOGNAME from this
    // process where the step has none: names a program needs, no secrets.
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") base[k] = v;
    // Inside the walls (a person's machine), the server starts as the
    // sandbox's wrapping of its command line, so it and what it starts
    // stay inside them.
    // Its variables, the spec's too, ride inside (launch); `env` here is
    // the launcher's own few, so none of them touches the program that
    // puts the walls up.
    if (wrapped !== undefined) {
      return { client: new StdioClientTransport({ command: LAUNCHER, args: ["-c", wrapped], env: base, cwd, stderr: "ignore" }) };
    }
    return { client: new StdioClientTransport({ command: s.command!, args: s.args ?? [], env: { ...base, ...(s.env ?? {}) }, cwd, stderr: "ignore" }) };
  }
  const url = new URL(s.url!);
  const requestInit: RequestInit = { headers: s.headers ?? {}, ...(s.redirect === "error" ? { redirect: "error" as const } : {}) };
  // SSE is the older MCP transport (deprecated in the SDK); still accepted,
  // because an agent may name a server that has nothing newer.
  // Inside the walls, every request (the SSE stream too) goes through their
  // site proxy (FOL-222): the same list decides as for a command.
  const via = viaProxy ? { fetch: viaProxy } : {};
  return { client: s.type === "sse" ? new SSEClientTransport(url, { requestInit, ...via }) : new StreamableHTTPClientTransport(url, { requestInit, ...via }) };
}

/** A call's result as the loop hands it on: its text and images in the
 *  order the server gave them (a caption stays beside its picture), the text
 *  cut to a size, marked an error when the server says it is one. */
export function outcomeOf(result: Json): ToolOutcome {
  const parts: ({ type: "text"; text: string } | { type: "image"; data: string; mediaType: string })[] = [];
  const add = (text: string) => parts.push({ type: "text", text });
  for (const c of (Array.isArray(result.content) ? result.content : []) as Json[]) {
    if (c.type === "text" && typeof c.text === "string") add(c.text);
    else if (c.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") parts.push({ type: "image", data: c.data, mediaType: c.mimeType });
    else if (c.type === "resource") {
      const r = (c.resource ?? {}) as Json;
      add(typeof r.text === "string" ? r.text : `[resource ${String(r.uri ?? "")}${r.mimeType ? ` (${String(r.mimeType)})` : ""}]`);
    } else if (c.type === "resource_link") add(`[resource ${String(c.uri ?? "")}]`);
    else if (c.type === "audio") add("[audio — not shown]");
  }
  if (!parts.some((p) => p.type === "text") && result.structuredContent !== undefined) add(JSON.stringify(result.structuredContent));
  if (!parts.length && "toolResult" in result) add(typeof result.toolResult === "string" ? result.toolResult : JSON.stringify(result.toolResult));
  // One budget across every text part, in order, the newline between two
  // counted; a part past it is dropped, not kept empty.
  let left = MAX_TEXT;
  let cut = 0;
  const kept: typeof parts = [];
  let any = false;
  for (const p of parts) {
    if (p.type !== "text") { kept.push(p); continue; }
    const sep = any ? 1 : 0;
    const room = left - sep;
    // An empty part still fits when only its newline does.
    if (room < 0 || (room === 0 && p.text.length > 0)) { cut += p.text.length; continue; }
    if (p.text.length > room) {
      let end = room;
      // Never half a character: a cut between a surrogate pair drops both.
      if (/[\uD800-\uDBFF]/.test(p.text[end - 1] ?? "")) end--;
      cut += p.text.length - end;
      p.text = p.text.slice(0, end);
    }
    left -= p.text.length + sep;
    any = true;
    kept.push(p);
  }
  parts.length = 0;
  parts.push(...kept);
  if (cut) add(`[cut: ${cut} more characters]`);
  const texts = parts.filter((p) => p.type === "text") as { text: string }[];
  const text = texts.map((p) => p.text).join("\n");
  const hasImage = parts.some((p) => p.type === "image");
  return { text, isError: result.isError === true, ...(hasImage ? { parts } : {}) };
}

/** A promise held to a time and a signal — the MCP client waits for a
 *  transport to start before its own timeout begins (an SSE server that
 *  never sends its endpoint would hold the step open forever). */
function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
    const onAbort = () => { done(); reject(new Error(`${what}: stopped`)); };
    const timer = setTimeout(() => { done(); reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)); }, ms);
    // Handled first, so the work failing after a stop is never unhandled.
    work.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Connect every server and list its tools. All or none: one that fails
 *  closes the rest and refuses the step, naming it. */
/** `env` is the step's options' environment (where MCP_TOOL_TIMEOUT is
 *  read, as the SDK read it); `toolEnv` is what a tool's process starts
 *  from — the loop's shellEnv, which a caller keeps apart from the model's
 *  credentials. */
/** The walls' own fetch, when the handle has one (FOL-222). Read here rather than named in connectMcp's type,
 *  so that type stays as it was: a handle without one is still accepted, and a remote server is then refused. */
function wallsFetch(sandbox: object): typeof fetch | undefined {
  const f = (sandbox as { fetch?: unknown }).fetch;
  return typeof f === "function" ? (f as typeof fetch) : undefined;
}

export async function connectMcp(servers: Record<string, McpSpec>, ctx: { env: Record<string, string | undefined>; toolEnv: Record<string, string | undefined>; cwd: string; signal: AbortSignal; killOnClose?: boolean; maxTools?: number; sandbox?: Pick<SandboxWalls, "launch" | "fresh" | "onChange"> | null }): Promise<McpConnection> {
  const open: { client: Client; transport: Transport; server?: Transport }[] = [];
  const close = async () => {
    await Promise.all(open.map(async (o) => {
      // A streamable HTTP server that gave a session is told it is over
      // (DELETE), so it is not left holding one; then the local side closes.
      if (o.transport instanceof StreamableHTTPClientTransport && o.transport.sessionId) {
        await bounded(o.transport.terminateSession(), 5_000, new AbortController().signal, "end session").catch(() => undefined);
      }
      // A host that keeps servers for a whole session (foldrun code) asks
      // that what a stdio server started goes with it: read while the
      // server still holds its children, ended after it was asked to close.
      const pid = ctx.killOnClose ? ((o.transport as { pid?: number | null }).pid ?? null) : null;
      const started = pid ? treePids(pid).filter((p) => p !== pid) : [];
      await o.client.close().catch(() => undefined);
      await o.server?.close().catch(() => undefined);
      for (const p of [...started, ...(pid ? [pid] : [])]) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* gone already */
        }
      }
    }));
  };
  const tools: EngineTool[] = [];
  const owner = new Map<string, string>();
  const instructions: { server: string; text: string }[] = [];
  const envTimeout = Number(ctx.env.MCP_TOOL_TIMEOUT);
  try {
    for (const [name, s] of Object.entries(servers)) {
      let wrapped: { line: string; env: Record<string, string>; token?: string } | undefined;
      if (ctx.sandbox && s.type === "stdio") {
        // The server's environment (the step's, then what the spec names)
        // is set again inside; the launcher starts with the walls' own.
        wrapped = await ctx.sandbox.launch(shellLine(s.command!, s.args ?? []), { ...ctx.toolEnv, ...(s.env ?? {}) });
        if (!wrapped?.line) throw new Error(`MCP server ${name}: the sandbox gave no command line`);
        // A long-lived server inside the walls must be stoppable when they
        // change: without a token and a way to check it, it does not start.
        if (!wrapped.token || typeof ctx.sandbox.fresh !== "function" || typeof ctx.sandbox.onChange !== "function") throw new Error(`MCP server ${name}: this sandbox cannot tell a long-lived server when its rules change, so it is not started`);
      } else if (ctx.sandbox && (s.type === "http" || s.type === "sse") && typeof wallsFetch(ctx.sandbox) !== "function") {
        // This process makes that connection itself: only through the walls'
        // site proxy. A sandbox that has none refuses the server.
        throw new Error(`MCP server ${name}: a server over ${s.type === "sse" ? "SSE" : "HTTP"} needs the sandbox's site proxy, which this sandbox does not offer — run this in the cloud, or use a stdio server`);
      }
      const remoteInWalls = ctx.sandbox && (s.type === "http" || s.type === "sse") ? wallsFetch(ctx.sandbox) : undefined;
      const t = wrapped ? transportFor(s, wrapped.env, ctx.cwd, wrapped.line) : transportFor(s, ctx.toolEnv, ctx.cwd, undefined, remoteInWalls);
      const client = new Client({ name: "foldrun-engine", version: "1.0.0" });
      open.push({ client, transport: t.client, server: t.server });
      const sandboxToken = wrapped?.token;
      // Any launch that finds the protections changed stops this server at
      // once, not only its own next call.
      if (sandboxToken !== undefined && ctx.sandbox?.onChange) {
        const transport = t.client as { pid?: number | null };
        const stop = ctx.sandbox.onChange(async (now) => {
          if (now === sandboxToken) return;
          stop();
          // Ended, with all it started, before the launch that saw the
          // change goes ahead.
          // The tree is read and ended while the server still holds it:
          // closed first, its children would be orphaned out of reach.
          const pid = transport.pid ?? null;
          if (pid) killTree(pid);
          await client.close().catch(() => undefined);
        });
      }
      let listed: { name: string; description?: string; inputSchema?: Json; annotations?: { readOnlyHint?: boolean } }[];
      if (ctx.signal.aborted) throw new Error(`the MCP server ${name} did not start: connect: stopped`);
      try {
        const started = (async () => {
          if (t.server) await s.instance!.connect(t.server);
          await client.connect(t.client, { timeout: CONNECT_MS, signal: ctx.signal });
          const found: typeof listed = [];
          // A server that offers no tools says so in its capabilities.
          if (!client.getServerCapabilities()?.tools) return found;
          let cursor: string | undefined;
          do {
            let page;
            try {
              page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_MS, signal: ctx.signal });
            } catch (err) {
              // Some say they have tools and answer tools/list with "method
              // not found" when they have none (the Agent SDK's in-process
              // server with an empty list): no tools, not a failed start.
              if ((err as { code?: number }).code === -32601 && !cursor) return found;
              throw err;
            }
            found.push(...(page.tools as typeof listed));
            // Refused while it is still arriving, not after every page is held.
            if (ctx.maxTools !== undefined && found.length > ctx.maxTools) throw new Error(`it offers more than ${ctx.maxTools} tools`);
            cursor = page.nextCursor;
          } while (cursor);
          // Each page replaced the client's output-schema checks with its
          // own: give it every page's, so a tool on page one is still checked.
          (client as unknown as { cacheToolMetadata?(t: unknown[]): void }).cacheToolMetadata?.(found);
          return found;
        })();
        listed = await bounded(started, CONNECT_MS, ctx.signal, "connect");
      } catch (err) {
        throw new Error(`the MCP server ${name} did not start: ${(err as Error).message}`);
      }
      // The server's own timeout, else MCP_TOOL_TIMEOUT, as the SDK read them.
      const told = client.getInstructions();
      if (typeof told === "string" && told.trim()) instructions.push({ server: name, text: told.trim() });
      const timeout = Math.min(MAX_TIMER_MS, typeof s.timeout === "number" && s.timeout >= 1000 ? s.timeout : envTimeout >= 1000 ? envTimeout : DEFAULT_CALL_MS);
      for (const tool of listed) {
        const full = `mcp__${name}__${tool.name}`;
        if (!TOOL_NAME.test(full)) throw new Error(`the MCP server ${name} offers a tool whose full name ${full} is not one a model accepts (at most 64 letters, digits, _ and -)`);
        if (owner.has(full)) throw new Error(`two MCP servers offer a tool named ${full} (${owner.get(full)} and ${name})`);
        // A name that reads as another server's (sales offering eu__find
        // beside a server sales__eu) would be granted by the wrong server:
        // the step is refused rather than guess.
        const readAs = grantedServer(full, Object.keys(servers));
        if (readAs?.server !== name) throw new Error(`the MCP tool ${full} from ${name} reads as server ${readAs?.server ?? "none"}'s — rename the server or the tool`);
        owner.set(full, name);
        tools.push({
          name: full,
          description: tool.description ?? "",
          input_schema: tool.inputSchema ?? { type: "object" },
          // Run beside other reads only when the server says it changes nothing.
          readOnly: tool.annotations?.readOnlyHint === true,
          run: async (input, toolCtx) => {
            // A server inside the walls holds the write rules it started
            // under: once git's protections have changed it is stopped, and
            // the call refused, rather than run with the old ones.
            if (sandboxToken !== undefined && ctx.sandbox?.fresh && !ctx.sandbox.fresh(sandboxToken)) {
              const pid = (t.client as { pid?: number | null }).pid ?? null;
              if (pid) killTree(pid);
              await client.close().catch(() => undefined);
              return { text: `the MCP server ${name} was stopped: the files this session may not write changed after it started (a git hooks path or repository). It starts again on the next step.`, isError: true };
            }
            const result = await client.callTool({ name: tool.name, arguments: input }, undefined, { signal: toolCtx.signal, timeout, maxTotalTimeout: timeout });
            return outcomeOf(result as Json);
          },
        });
      }
    }
  } catch (err) {
    await close();
    throw err;
  }
  const kill = () => {
    for (const o of open) {
      const pid = (o.transport as { pid?: number | null }).pid ?? null;
      if (pid) killTree(pid);
    }
  };
  return { tools, owner, instructions, servers: Object.keys(servers).map((name) => ({ name, status: "connected" as const })), close, kill };
}
