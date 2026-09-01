// OpenAPI documents → typed API tools.
//
// A generic `call_<api>` tool asks the agent to know an API's paths and
// parameters by heart; it often does, roughly, and "roughly" costs a retry
// per call. When the vendor publishes an OpenAPI 3.x document, the platform
// can read the shapes off it instead: one tool per operation, its parameters
// typed and required where the document says so, the path template filled
// in by the platform rather than by the model.
//
// Three concerns, kept apart:
//
//   parseOpenApi        — pure: a document in, OperationSpecs out. No I/O.
//   loadOpenApiDocument — sync: a workspace file, or the on-disk cache of a
//                         URL. Never the network, so step assembly stays
//                         synchronous and offline-safe.
//   prefetchOpenApi     — async: fills the cache for URLs, ahead of the run.
//
// attachOperations ties them together for a list of ApiSpecs. The result is
// plain JSON on purpose: it crosses into the run container as values.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { dataRoot } from "./paths.ts";
import type { ApiSpec } from "./store.ts";

export interface OperationParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: "string" | "number" | "integer" | "boolean";
  description: string;
}

export interface OperationSpec {
  /** Tool-safe id: the operationId, or `${method}_${path}`, in [a-zA-Z0-9_]. */
  id: string;
  /** Upper-case HTTP method. */
  method: string;
  /** The path template as written, e.g. `/contacts/{contactId}`. */
  path: string;
  summary: string;
  params: OperationParam[];
  hasBody: boolean;
  bodyDescription: string;
}

/** The most operations one API turns into tools. Past this a tool list
 *  stops helping the model choose and starts crowding the prompt. */
export const MAX_OPERATIONS = 60;

/** A day, like the model catalogue: vendor documents move by release. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------------ parse

/** Follow a local `$ref` (`#/components/parameters/Foo`) within `doc`.
 *  Remote and file refs are not followed: the document is the boundary. */
function deref(doc: Obj, value: unknown, depth = 0): unknown {
  if (!isObj(value) || typeof value.$ref !== "string" || depth > 8) return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) return null;
  let cur: unknown = doc;
  for (const seg of ref.slice(2).split("/")) {
    const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur) || !(key in cur)) return null;
    cur = cur[key];
  }
  return deref(doc, cur, depth + 1);
}

const sanitizeId = (s: string) => s.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

function paramType(schema: unknown): OperationParam["type"] {
  if (!isObj(schema)) return "string";
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== "null") : schema.type;
  return t === "integer" || t === "number" || t === "boolean" ? t : "string";
}

function toParam(doc: Obj, raw: unknown): OperationParam | null {
  const p = deref(doc, raw);
  if (!isObj(p) || typeof p.name !== "string") return null;
  const where = p.in;
  if (where !== "path" && where !== "query" && where !== "header") return null; // cookies: no
  const schema = deref(doc, p.schema);
  let description = typeof p.description === "string" ? p.description.trim() : "";
  if (isObj(schema)) {
    if (Array.isArray(schema.enum)) description += ` One of: ${schema.enum.map(String).join(", ")}.`;
    if (schema.type === "array") description += " Comma-separated list.";
  }
  return {
    name: p.name,
    in: where,
    required: where === "path" ? true : p.required === true,
    type: paramType(schema),
    description: description.trim(),
  };
}

/** One line on what the body should contain — the description if there is
 *  one, plus the JSON schema's field names, which is what the model needs
 *  most and what a summary line least often carries. */
function describeBody(doc: Obj, raw: unknown): { hasBody: boolean; bodyDescription: string } {
  const body = deref(doc, raw);
  if (!isObj(body)) return { hasBody: false, bodyDescription: "" };
  const parts: string[] = [];
  if (typeof body.description === "string" && body.description.trim()) parts.push(body.description.trim());
  const content = isObj(body.content) ? body.content : {};
  const types = Object.keys(content);
  const jsonType = types.find((t) => /json/i.test(t)) ?? types[0];
  if (jsonType) {
    const schema = deref(doc, (content[jsonType] as Obj | undefined)?.schema);
    if (isObj(schema)) {
      const props = isObj(schema.properties) ? Object.keys(schema.properties) : [];
      const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
      if (props.length) {
        parts.push(
          `Fields: ${props.slice(0, 30).join(", ")}${props.length > 30 ? ", …" : ""}` +
            (required.length ? ` (required: ${required.join(", ")})` : "") + ".",
        );
      } else if (typeof schema.description === "string") {
        parts.push(schema.description.trim());
      }
    }
    if (!/json/i.test(jsonType)) parts.push(`Content type: ${jsonType}.`);
  }
  return { hasBody: true, bodyDescription: parts.join(" ") };
}

/**
 * Every operation the document declares, as tool shapes. `methods` is the
 * API's own allowlist (an agent that may only GET gets only GET operations,
 * whatever the document offers); `operations` narrows further to named
 * operationIds or `"METHOD /path"` strings. Pure, and forgiving: a broken
 * operation is skipped with a warning, never a throw.
 */
export function parseOpenApi(
  doc: unknown,
  opts: { operations?: string[]; methods: string[] },
): { operations: OperationSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!isObj(doc) || !isObj(doc.paths)) {
    return { operations: [], warnings: ["document has no `paths` object — is it OpenAPI 3.x?"] };
  }
  const allowedMethods = new Set(opts.methods.map((m) => m.toUpperCase()));
  const all: (OperationSpec & { operationId: string | null })[] = [];
  const seen = new Set<string>();

  for (const [route, rawItem] of Object.entries(doc.paths)) {
    const item = deref(doc, rawItem);
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const METHOD = method.toUpperCase();
      // Merge path-level parameters under operation-level ones (same
      // name+location: the operation's wins), as the spec prescribes.
      const byKey = new Map<string, OperationParam>();
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = toParam(doc, raw);
        if (p) byKey.set(`${p.in}:${p.name}`, p);
      }
      const operationId = typeof op.operationId === "string" && op.operationId.trim() ? op.operationId.trim() : null;
      let id = sanitizeId(operationId ?? `${method}_${route}`) || `${method}_op`;
      if (seen.has(id)) {
        let n = 2;
        while (seen.has(`${id}_${n}`)) n++;
        id = `${id}_${n}`;
      }
      seen.add(id);
      const summary =
        (typeof op.summary === "string" && op.summary.trim()) ||
        (typeof op.description === "string" && op.description.trim().split(/\r?\n/)[0]) ||
        `${METHOD} ${route}`;
      all.push({
        id,
        operationId,
        method: METHOD,
        path: route,
        summary: summary.slice(0, 200),
        params: [...byKey.values()],
        ...describeBody(doc, op.requestBody),
      });
    }
  }

  const byMethod = all.filter((o) => allowedMethods.has(o.method));
  let chosen: typeof all;
  if (opts.operations) {
    chosen = [];
    for (const want of opts.operations) {
      const w = want.trim();
      const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(w);
      const match = (o: (typeof all)[number]) =>
        m
          ? o.method === m[1].toUpperCase() && o.path === m[2]
          : o.operationId === w || o.id === w || o.id === sanitizeId(w);
      const hit = byMethod.find(match);
      if (hit) {
        if (!chosen.includes(hit)) chosen.push(hit);
      } else if (all.find(match)) {
        warnings.push(`operation "${w}" uses a method the API does not allow (methods: ${[...allowedMethods].join(", ")})`);
      } else {
        warnings.push(`operation "${w}" is not in the OpenAPI document`);
      }
    }
  } else {
    chosen = byMethod;
  }

  if (chosen.length > MAX_OPERATIONS) {
    warnings.push(
      `${chosen.length} operations in the document; exposing the first ${MAX_OPERATIONS} — ` +
        `add \`operations:\` to choose which`,
    );
    chosen = chosen.slice(0, MAX_OPERATIONS);
  }

  return {
    operations: chosen.map(({ operationId: _omit, ...spec }) => spec),
    warnings,
  };
}

// ------------------------------------------------------------------- load

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** Document text → object, JSON first, YAML when that fails. js-yaml is
 *  reached through require so this module stays loadable where the parser
 *  is absent (a container image with only the runtime deps): a YAML file
 *  there is an error message, not a missing-module crash. */
function parseDocumentText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml") as { safeLoad?: (s: string) => unknown; load: (s: string) => unknown };
  return (yaml.safeLoad ?? yaml.load)(text);
}

function cacheFile(tenant: string, url: string): string {
  const segment = tenant.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
  return path.join(dataRoot(), segment, "cache", "openapi", `${crypto.createHash("sha256").update(url).digest("hex")}.json`);
}

interface CachedDocument {
  url: string;
  fetchedAt: string;
  doc: unknown;
}

function readCache(tenant: string, url: string): CachedDocument | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(tenant, url), "utf8")) as CachedDocument;
    return parsed && typeof parsed.fetchedAt === "string" && "doc" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The document behind an `openapi:` value, without touching the network.
 * A relative path is read from the workspace — and only from the workspace:
 * `../../etc/passwd` and absolute paths outside the root are refused. A URL
 * is served from the cache `prefetchOpenApi` fills; uncached is an error
 * that names the fix.
 */
export function loadOpenApiDocument(
  tenant: string,
  workspaceRoot: string,
  source: string,
): { doc: unknown | null; error: string | null } {
  if (isUrl(source)) {
    if (!source.toLowerCase().startsWith("https://")) {
      return { doc: null, error: `${source}: only https URLs are fetched` };
    }
    const cached = readCache(tenant, source);
    if (!cached) {
      return { doc: null, error: `${source} is not cached yet — prefetchOpenApi runs before the step assembles` };
    }
    return { doc: cached.doc, error: null };
  }

  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, source);
  const inside = (p: string, r: string) => p === r || p.startsWith(r + path.sep);
  if (!inside(abs, root)) return { doc: null, error: `${source} escapes the workspace` };
  let text: string;
  try {
    // The real path too: a symlink out of the workspace is still out. Both
    // sides resolved, because the root itself may sit behind one (/var on
    // macOS is /private/var).
    const real = fs.realpathSync(abs);
    if (!inside(real, fs.realpathSync(root))) return { doc: null, error: `${source} escapes the workspace` };
    text = fs.readFileSync(real, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { doc: null, error: code === "ENOENT" ? `${source}: no such file in the workspace` : `${source}: ${(err as Error).message}` };
  }
  try {
    return { doc: parseDocumentText(text), error: null };
  } catch (err) {
    return { doc: null, error: `${source}: not JSON or YAML (${(err as Error).message})` };
  }
}

/**
 * Fill the cache for every https `openapi:` URL that is missing or older
 * than a day. Ten seconds per document; a failure is a warning line, and a
 * stale copy is kept when the refresh fails (offline is a reason to be out
 * of date, not to forget). Never throws — the runner calls this on the way
 * into a step and must not be stopped by a vendor's outage.
 */
export async function prefetchOpenApi(tenant: string, sources: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const source of new Set(sources.filter(isUrl))) {
    if (!source.toLowerCase().startsWith("https://")) {
      warnings.push(`openapi: ${source}: only https URLs are fetched`);
      continue;
    }
    const cached = readCache(tenant, source);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) continue;
    try {
      const res = await fetch(source, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json, application/yaml, text/yaml, */*" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = parseDocumentText(await res.text());
      if (!isObj(doc) || !isObj(doc.paths)) throw new Error("document has no `paths` object");
      const file = cacheFile(tenant, source);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const record: CachedDocument = { url: source, fetchedAt: new Date().toISOString(), doc };
      // Atomic like every other cache write: half a document is worse than none.
      fs.writeFileSync(file + ".tmp", JSON.stringify(record));
      fs.renameSync(file + ".tmp", file);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(
        `openapi: could not fetch ${source} (${reason})` +
          (cached ? " — using the cached copy" : " — typed tools unavailable, the generic call tool still works"),
      );
    }
  }
  return warnings;
}

/**
 * Resolve every spec's `openapi:` into `resolvedOperations`. A spec whose
 * document cannot be read or yields nothing keeps `resolvedOperations`
 * unset — the generic `call_<api>` tool still works — and the reason lands
 * in the warnings, named by API. Specs without `openapi:` pass through.
 */
export function attachOperations(
  specs: ApiSpec[],
  tenant: string,
  workspaceRoot: string,
): { specs: ApiSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = specs.map((spec) => {
    if (!spec.openapi) return spec;
    const { doc, error } = loadOpenApiDocument(tenant, workspaceRoot, spec.openapi);
    if (error) {
      warnings.push(`api ${spec.name}: openapi ${error}`);
      return spec;
    }
    const parsed = parseOpenApi(doc, { operations: spec.operations, methods: spec.methods });
    for (const w of parsed.warnings) warnings.push(`api ${spec.name}: ${w}`);
    if (!parsed.operations.length) {
      warnings.push(`api ${spec.name}: the OpenAPI document yielded no operations (methods: ${spec.methods.join(", ")})`);
      return spec;
    }
    return { ...spec, resolvedOperations: parsed.operations };
  });
  return { specs: out, warnings };
}
