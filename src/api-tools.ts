// Turns an agent's `apis:` declarations into real tools it can call.
//
// One generic tool per API, named `call_<api>`: the agent supplies a method,
// path, optional query and body. When the API declares an `openapi:`
// document, each of its operations becomes a typed tool of its own,
// `<api>_<operationId>`, whose arguments are the parameters the document
// declares — path parameters filled into the template by the platform,
// query and header parameters routed to where they belong.
//
// Either way the platform resolves ${SECRET} placeholders from the encrypted
// store, enforces the declared base URL and method allowlist, and returns
// status + body. Credentials never enter the agent's context — it sees the
// tool, not the token. A `rate:` on the API is a token bucket per step:
// a call over the limit waits for its turn rather than failing.

import crypto from "node:crypto";
import { z } from "zod";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { ApiSpec } from "./store.ts";
import type { OperationSpec } from "./openapi.ts";
import { resolveSecrets, materializeSecrets } from "./secrets.ts";

const MAX_BODY_CHARS = 20_000;
/** MCP tool names are capped; ours also carry the server prefix on the wire. */
const MAX_TOOL_NAME = 64;
/** How many typed tools the prompt lists by name before summarising. */
const PROMPT_LIST_CAP = 40;
/** A wait shorter than this is not worth a word in the log. */
const LOG_WAIT_MS = 1000;

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

/**
 * A token bucket: `count` tokens, refilled at `perSec`. `take()` resolves
 * when a token is available, in arrival order — a caller never learns "no",
 * only "not yet". Lives as long as the tool set does, which is one step.
 */
export class TokenBucket {
  private readonly count: number;
  private readonly perSec: number;
  private tokens: number;
  private last = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(count: number, perSec: number) {
    this.count = count;
    this.perSec = perSec;
    this.tokens = count;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.count, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
  }

  /** Resolves with the milliseconds waited. */
  take(): Promise<number> {
    const started = Date.now();
    const turn = this.chain.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const wait = Math.ceil(((1 - this.tokens) / this.perSec) * 1000);
        await new Promise((r) => setTimeout(r, Math.max(1, wait)));
      }
    });
    // The queue must survive one caller's failure (there is none today, but
    // a rejected link would freeze every later call behind it).
    this.chain = turn.catch(() => {});
    return turn.then(() => Date.now() - started);
  }
}

/** `<api>_<operation>`, held under the MCP cap: a long name keeps its head
 *  and gains a hash tail, so two long names never collapse into one. */
export function typedToolName(apiName: string, opId: string): string {
  const full = `${apiName}_${opId}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const hash = crypto.createHash("sha256").update(full).digest("hex").slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
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

interface Request {
  method: string;
  /** Path after the base URL, already templated. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
}

type ToolReply = { content: { type: "text"; text: string }[]; isError: boolean };

/**
 * The one request path both tool shapes share: rate limit, secrets made
 * live, base-URL confinement, the API's own headers and query, the timeout,
 * the truncation, the log line. Typed and generic tools differ only in how
 * they arrive at a Request.
 */
async function performRequest(
  api: ApiSpec,
  env: Record<string, string>,
  bucket: TokenBucket | null,
  log: string[],
  req: Request,
): Promise<ToolReply> {
  const started = Date.now();
  try {
    const waited = bucket ? await bucket.take() : 0;
    const waitNote = waited >= LOG_WAIT_MS ? ` [waited ${(waited / 1000).toFixed(1)}s for rate limit]` : "";
    // Per call, not per build: an oauth2 secret's recipe becomes a
    // live access token here, so a step that runs for an hour keeps
    // getting fresh tokens (the exchange is cached until near expiry)
    // — and a recipe can never end up inside a header.
    const live = await materializeSecrets(env);
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    const url = new URL(api.base + path);
    // Base-URL confinement: a path can't escape the declared host.
    if (!url.href.startsWith(api.base)) {
      throw new Error(`path escapes the declared base URL (${api.base})`);
    }
    for (const [k, v] of Object.entries(api.query)) {
      url.searchParams.set(k, substitute(v, live));
    }
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(api.headers)) headers[k] = substitute(v, live);
    for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
    if (req.body && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }

    const res = await fetch(url, {
      method: req.method,
      headers,
      body: req.body,
      // The tool.md's `timeout:` is the only clock; none set, none applied.
      ...(api.timeout ? { signal: AbortSignal.timeout(api.timeout * 1000) } : {}),
    });
    const text = await res.text();
    const truncated =
      text.length > MAX_BODY_CHARS
        ? `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated ${text.length - MAX_BODY_CHARS} chars]`
        : text;

    log.push(
      `${req.method} ${url.pathname}${url.search ? "?…" : ""} → ${res.status} (${Date.now() - started}ms)${waitNote}`,
    );
    return {
      content: [{ type: "text" as const, text: `HTTP ${res.status} ${res.statusText}\n\n${truncated}` }],
      isError: !res.ok,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`${req.method} ${req.path} → error: ${message}`);
    return { content: [{ type: "text" as const, text: `Request failed: ${message}` }], isError: true };
  }
}

const rateSentence = (api: ApiSpec) =>
  api.rate
    ? ` Rate limit: ${api.rate.count} call${api.rate.count === 1 ? "" : "s"} per ` +
      `${api.rate.perSec === api.rate.count ? "second" : `${Math.round(api.rate.count / api.rate.perSec)}s`}, ` +
      `shared by every call this step makes to ${api.name}; a call over the limit waits its turn.`
    : "";

/** Zod for one declared parameter, typed as the document says. */
function paramSchema(p: OperationSpec["params"][number]) {
  const base =
    p.type === "integer" ? z.number().int() : p.type === "number" ? z.number() : p.type === "boolean" ? z.boolean() : z.string();
  const described = base.describe(p.description || `${p.in} parameter ${p.name}`);
  return p.required ? described : described.optional();
}

/** Argument keys must be identifiers the model can write; parameter names
 *  need not be (`filter[status]`). Map one to the other, keeping a
 *  collision between locations apart with a suffix. */
function argKeys(op: OperationSpec): Map<string, OperationSpec["params"][number]> {
  const out = new Map<string, OperationSpec["params"][number]>();
  for (const p of op.params) {
    let key = p.name.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || p.in;
    if (/^\d/.test(key)) key = `_${key}`;
    if (out.has(key)) key = `${key}_${p.in}`;
    let n = 2;
    while (out.has(key)) key = `${key}_${n++}`;
    out.set(key, p);
  }
  return out;
}

function typedTool(
  api: ApiSpec,
  op: OperationSpec,
  env: Record<string, string>,
  bucket: TokenBucket | null,
  log: string[],
) {
  const keys = argKeys(op);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of keys) shape[key] = paramSchema(p);
  if (op.hasBody) {
    shape.body = z
      .string()
      .optional()
      .describe(`Request body as a JSON string. ${op.bodyDescription}`.trim());
  }
  const description =
    `${op.summary} — ${op.method} ${op.path} on the ${api.name} API. ` +
    `Authentication is added automatically — never ask the user for credentials.` +
    rateSentence(api);

  return tool(typedToolName(api.name, op.id), description, shape, async (args) => {
    const values = args as Record<string, unknown>;
    const query: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const pathValues: Record<string, string> = {};
    for (const [key, p] of keys) {
      const v = values[key];
      if (v === undefined || v === null) continue;
      const s = String(v);
      if (p.in === "path") pathValues[p.name] = s;
      else if (p.in === "query") query[p.name] = s;
      else headers[p.name] = s;
    }
    let missing: string | null = null;
    const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      if (!(name in pathValues)) {
        missing ??= name;
        return "";
      }
      return encodeURIComponent(pathValues[name]);
    });
    if (missing) {
      log.push(`${op.method} ${op.path} → error: path parameter ${missing} not supplied`);
      return {
        content: [{ type: "text" as const, text: `Request failed: path parameter "${missing}" is required` }],
        isError: true,
      };
    }
    return performRequest(api, env, bucket, log, {
      method: op.method,
      path,
      query,
      headers,
      body: typeof values.body === "string" ? values.body : undefined,
    });
  });
}

function genericTool(api: ApiSpec, env: Record<string, string>, bucket: TokenBucket | null, log: string[]) {
  const typed = api.resolvedOperations?.length
    ? ` Prefer the typed ${api.name}_* tools; this one is the escape hatch for operations they do not cover.`
    : "";
  return tool(
    `call_${api.name}`,
    `Call the ${api.name} API. ${api.description} Base URL: ${api.base}. ` +
      `Allowed methods: ${api.methods.join(", ")}. Provide only the path after the base URL. ` +
      `Authentication is added automatically — never ask the user for credentials.` +
      typed +
      rateSentence(api),
    {
      method: z.enum(api.methods as [string, ...string[]]).describe("HTTP method"),
      path: z.string().describe("Path appended to the base URL, e.g. /customers/123/campaigns"),
      query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
      body: z.string().optional().describe("Request body — JSON string for JSON APIs"),
    },
    (args) =>
      performRequest(api, env, bucket, log, {
        method: args.method,
        path: args.path,
        query: args.query ?? {},
        headers: {},
        body: args.body,
      }),
  );
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types its own list this way
  const tools: SdkMcpToolDefinition<any>[] = [];
  const toolNames: string[] = [];
  const promptLines: string[] = [];

  for (const api of apis) {
    // One bucket per API per step: the limit is the vendor's, the scope is
    // this process. Two steps on two workers each get their own.
    const bucket = api.rate ? new TokenBucket(api.rate.count, api.rate.perSec) : null;
    const ops = api.resolvedOperations ?? [];
    // An explicit `operations:` list means "only these": no escape hatch.
    const withGeneric = !(api.operations && ops.length);

    const typedNames: string[] = [];
    for (const op of ops) {
      tools.push(typedTool(api, op, env, bucket, log));
      typedNames.push(typedToolName(api.name, op.id));
    }
    if (withGeneric) tools.push(genericTool(api, env, bucket, log));

    const names = [...typedNames, ...(withGeneric ? [`call_${api.name}`] : [])];
    toolNames.push(...names.map((n) => `mcp__foldrun_apis__${n}`));

    const rateLine = api.rate ? ` Rate limit ${api.rate.count}/${Math.round(api.rate.count / api.rate.perSec)}s — over it, calls wait.` : "";
    if (ops.length) {
      const listed = ops.slice(0, PROMPT_LIST_CAP).map((op) => `  - \`${typedToolName(api.name, op.id)}\` — ${op.summary}`);
      const more = ops.length > PROMPT_LIST_CAP ? [`  - …and ${ops.length - PROMPT_LIST_CAP} more`] : [];
      promptLines.push(
        `- **${api.name}** — ${api.description} Base URL \`${api.base}\`. ` +
          `${ops.length} typed tool${ops.length === 1 ? "" : "s"}` +
          (withGeneric ? `, plus \`call_${api.name}\` for anything they do not cover` : "") +
          `. Credentials are injected for you.${rateLine}`,
        ...listed,
        ...more,
      );
    } else {
      promptLines.push(
        `- **${api.name}** — call with the \`call_${api.name}\` tool. ${api.description} ` +
          `Base URL \`${api.base}\`; allowed methods ${api.methods.join(", ")}. Credentials are injected for you.${rateLine}`,
      );
    }
  }

  const server = createSdkMcpServer({ name: "foldrun_apis", version: "1.0.0", tools });

  return {
    server,
    toolNames,
    missingSecrets: missing,
    promptLines,
    drainLog: () => log.splice(0, log.length),
  };
}
