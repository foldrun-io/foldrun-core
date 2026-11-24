// What a step's MCP servers are, checked without the MCP library: the
// runner, the step and a host that only lists servers import this, and only
// connecting one (engine-mcp.ts) loads the library (FOL-265: it is about
// 24 MB, loaded for every turn of a session with no server).
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** The server a granted name belongs to: `mcp__<server>`, `mcp__<server>__*`
 *  (the runner grants a whole server so) or `mcp__<server>__<tool>`. Matched
 *  against the step's own server names, the longest first, so a server named
 *  `sales__eu` is not read as `sales`. */
export function grantedServer(name: string, servers: string[]): { server: string; tool: string | null } | null {
  for (const s of [...servers].sort((a, b) => b.length - a.length)) {
    const head = `mcp__${s}`;
    if (name === head || name === `${head}__*`) return { server: s, tool: null };
    if (name.startsWith(`${head}__`) && name.length > head.length + 2) return { server: s, tool: name };
  }
  return null;
}

/** A server as the SDK's `mcpServers` option holds it. */
export interface McpSpec {
  type?: string;
  name?: string;
  instance?: { connect(t: Transport): Promise<void> };
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Milliseconds one call may take; below 1000 is ignored, as in the SDK. */
  timeout?: number;
  /** The SDK's per-tool permission policy — refused here (checkMcpSpecs). */
  tools?: unknown;
  /** `"error"`: a remote server that answers with a redirect is refused, so
   *  the headers a person approved for one address never follow to another. */
  redirect?: "error";
}

/** What a host may rely on from this connector: a host that keeps servers
 *  for a session (foldrun code) refuses to start any on a build without them. */
export const ENGINE_MCP_FEATURES = { killOnClose: true, maxTools: true, redirectError: true, kill: true, remoteInWalls: true } as const;

/** Refused before a model call is paid for: a server this loop cannot connect. */
export function checkMcpSpecs(servers: Record<string, unknown>, engine: string): Record<string, McpSpec> {
  // No prototype: a server named __proto__ is a server, not a prototype.
  const out: Record<string, McpSpec> = Object.create(null);
  for (const [name, raw] of Object.entries(servers)) {
    const s = (raw ?? {}) as McpSpec;
    const type = s.type ?? "stdio";
    const ok =
      (type === "sdk" && typeof s.instance?.connect === "function") ||
      (type === "stdio" && typeof s.command === "string" && !!s.command) ||
      ((type === "http" || type === "sse") && typeof s.url === "string" && !!s.url);
    if (!ok) throw new Error(`the ${engine} engine cannot connect the MCP server ${name} (type ${type}) — run this agent on the default engine.`);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`the MCP server name ${name} has characters a tool name cannot hold (letters, digits, _ and -)`);
    // The SDK honours a per-tool always_deny / always_ask; this loop would
    // offer such a tool like any other, so it refuses the spec instead.
    if (Array.isArray(s.tools) && s.tools.length) throw new Error(`the ${engine} engine does not apply per-tool permission policies (MCP server ${name}) — run this agent on the default engine.`);
    out[name] = { ...s, type };
  }
  return out;
}
