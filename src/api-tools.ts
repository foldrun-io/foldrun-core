// Turns an agent's `apis:` declarations into real tools it can call.
//
// One tool per API, named `call_<api>`. The agent supplies a method, path,
// optional query and body; the platform resolves ${SECRET} placeholders from
// the encrypted store, enforces the declared base URL and method allowlist,
// and returns status + body. Credentials never enter the agent's context —
// it sees the tool, not the token.

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ApiSpec } from "./store.ts";
import { resolveSecrets, materializeSecrets } from "./secrets.ts";

const MAX_BODY_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

function substitute(value: string, env: Record<string, string>) {
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name: string) => env[name] ?? whole);
}

// Which secret names does this API's config reference?
export function secretsUsedByApi(api: ApiSpec): string[] {
  const found = new Set<string>();
  for (const value of [...Object.values(api.headers), ...Object.values(api.query)]) {
    for (const m of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) found.add(m[1]);
  }
  return [...found];
}

export interface ApiToolResult {
  /** Passed to the SDK as an in-process MCP server (the agent just sees tools). */
  server: ReturnType<typeof createSdkMcpServer> | null;
  /** Tool names to allow, e.g. mcp__foldrun_apis__call_google_ads. */
  toolNames: string[];
  /** Secrets referenced but not set — surfaced as run warnings. */
  missingSecrets: string[];
  /** Human-readable lines describing each API, appended to the system prompt. */
  promptLines: string[];
  /** Called after the run to collect a log of every request made. */
  drainLog: () => string[];
}

export function buildApiTools(
  tenant: string,
  apis: ApiSpec[],
  workspace?: string,
  // The runner container passes this: secrets were resolved before the specs
  // crossed the boundary, and there is no vault in there to ask.
  resolved?: { env: Record<string, string | undefined>; missing: string[] },
): ApiToolResult {
  if (apis.length === 0) {
    return { server: null, toolNames: [], missingSecrets: [], promptLines: [], drainLog: () => [] };
  }

  const neededSecrets = [...new Set(apis.flatMap(secretsUsedByApi))];
  const { env, missing } = resolved
    ? {
        env: Object.fromEntries(
          Object.entries(resolved.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        missing: resolved.missing,
      }
    : resolveSecrets(tenant, neededSecrets, workspace);
  const log: string[] = [];

  const tools = apis.map((api) =>
    tool(
      `call_${api.name}`,
      `Call the ${api.name} API. ${api.description} Base URL: ${api.base}. ` +
        `Allowed methods: ${api.methods.join(", ")}. Provide only the path after the base URL. ` +
        `Authentication is added automatically — never ask the user for credentials.`,
      {
        method: z.enum(api.methods as [string, ...string[]]).describe("HTTP method"),
        path: z.string().describe("Path appended to the base URL, e.g. /customers/123/campaigns"),
        query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
        body: z.string().optional().describe("Request body — JSON string for JSON APIs"),
      },
      async (args) => {
        const started = Date.now();
        try {
          // Per call, not per build: an oauth2 secret's recipe becomes a
          // live access token here, so a step that runs for an hour keeps
          // getting fresh tokens (the exchange is cached until near expiry)
          // — and a recipe can never end up inside a header.
          const live = await materializeSecrets(env);
          const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
          const url = new URL(api.base + path);
          // Base-URL confinement: a path can't escape the declared host.
          if (!url.href.startsWith(api.base)) {
            throw new Error(`path escapes the declared base URL (${api.base})`);
          }
          for (const [k, v] of Object.entries(api.query)) {
            url.searchParams.set(k, substitute(v, live));
          }
          for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, v);

          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(api.headers)) headers[k] = substitute(v, live);
          if (args.body && !headers["content-type"] && !headers["Content-Type"]) {
            headers["content-type"] = "application/json";
          }

          const res = await fetch(url, {
            method: args.method,
            headers,
            body: args.body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const text = await res.text();
          const truncated =
            text.length > MAX_BODY_CHARS
              ? `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated ${text.length - MAX_BODY_CHARS} chars]`
              : text;

          log.push(
            `${args.method} ${url.pathname}${url.search ? "?…" : ""} → ${res.status} (${Date.now() - started}ms)`,
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `HTTP ${res.status} ${res.statusText}\n\n${truncated}`,
              },
            ],
            isError: !res.ok,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.push(`${args.method} ${args.path} → error: ${message}`);
          return { content: [{ type: "text" as const, text: `Request failed: ${message}` }], isError: true };
        }
      },
    ),
  );

  const server = createSdkMcpServer({ name: "foldrun_apis", version: "1.0.0", tools });

  return {
    server,
    toolNames: apis.map((a) => `mcp__foldrun_apis__call_${a.name}`),
    missingSecrets: missing,
    promptLines: apis.map(
      (a) =>
        `- **${a.name}** — call with the \`call_${a.name}\` tool. ${a.description} ` +
        `Base URL \`${a.base}\`; allowed methods ${a.methods.join(", ")}. Credentials are injected for you.`,
    ),
    drainLog: () => log.splice(0, log.length),
  };
}
