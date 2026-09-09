// Is the key still good?
//
// A customer's own model key can be revoked, expire, run out of credit or
// have its base URL moved, and today the platform finds out the way the
// customer does: a desk fails at five in the morning. Twenty-seven of the
// thirty provider presets have never had an agent run through them from
// this runtime at all, so "it worked when we set it up" is doing a lot of
// work in that sentence.
//
// This is deliberately NOT the tool-loop probe next door. `foldrun probe`
// asks "can this model drive an agent", which is a question about a model
// and is asked once. This asks "does this endpoint still take our key",
// which is a question about a credential and has to be asked repeatedly —
// so it has to be cheap. One request, one token of output, no SDK, no tool
// loop, no agent. A fraction of a cent, and it answers the thing that
// actually breaks.
//
// It reads the same provider block a run reads, resolved the same way, so a
// pass here means a run would reach the same place with the same key.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { getSecret } from "./secrets.ts";
import { noteSecretUse } from "./secret-health.ts";
import { accountDir, workspaceDir, listWorkspaces, listAgents, parseProvider, type ProviderSpec } from "./store.ts";

export type HealthVerdict = "ok" | "credential" | "not-found" | "busy" | "unreachable" | "provider-error";

export interface ProviderCheck {
  /** How this provider is written in the file: its preset name, or its host. */
  provider: string;
  /** The model id actually asked for — what a run would send. */
  model: string;
  verdict: HealthVerdict;
  ok: boolean;
  status: number | null;
  ms: number;
  /** One sentence a person can act on, in the provider's own words where
   *  they said anything useful. */
  detail: string;
}

/** How long to wait. A provider slower than this is not one a step should
 *  be waiting on either, and the check must never hold a tick. */
const TIMEOUT_MS = 15_000;

/** What each status means for a credential, and what a person does about
 *  it. Kept as a table because the mapping IS the feature: "401" tells you
 *  nothing you can act on, "the key is no longer accepted" tells you
 *  everything. */
function verdictFor(status: number): { verdict: HealthVerdict; detail: string } {
  if (status >= 200 && status < 300) return { verdict: "ok", detail: "the key was accepted and the model answered" };
  if (status === 401 || status === 403) {
    return { verdict: "credential", detail: "the key is no longer accepted — revoked, rotated, or wrong for this endpoint" };
  }
  if (status === 402) return { verdict: "credential", detail: "the account behind this key is out of credit" };
  if (status === 404) {
    return { verdict: "not-found", detail: "the endpoint or the model id does not exist there — check base_url and models:" };
  }
  if (status === 429) {
    // Not a health problem. A busy provider is a provider that is working,
    // and reporting it as broken would train people to ignore the alert.
    return { verdict: "busy", detail: "rate limited right now — the key is fine" };
  }
  if (status >= 500) return { verdict: "provider-error", detail: "the provider is failing at its end" };
  return { verdict: "provider-error", detail: `unexpected HTTP ${status}` };
}

/** `${SECRET}` in a token or header, filled from this account's vault. */
function resolve(tenant: string, workspace: string | null, raw: string): string {
  return raw.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
    const hit = getSecret(tenant, name, workspace ?? undefined);
    return hit ? hit.value : whole;
  });
}

/**
 * One request at the provider, in the wire format it speaks, asking for a
 * single token. Never throws: an unreachable host is a verdict, not an
 * exception, because this runs on a tick.
 */
export async function checkProvider(
  tenant: string,
  workspace: string | null,
  spec: ProviderSpec,
  model: string,
): Promise<ProviderCheck> {
  const label = spec.name || (() => {
    try {
      return new URL(spec.baseUrl).host;
    } catch {
      return spec.baseUrl || "provider";
    }
  })();
  const began = Date.now();
  const fail = (verdict: HealthVerdict, detail: string, status: number | null = null): ProviderCheck => ({
    provider: label,
    model,
    verdict,
    ok: false,
    status,
    ms: Date.now() - began,
    detail,
  });

  const token = resolve(tenant, workspace, spec.token);
  if (!token || token.includes("${")) {
    return fail("credential", `the secret named in provider.token is not in this account's vault (${spec.token})`);
  }
  if (!spec.baseUrl) return fail("unreachable", "this provider block has no base_url");

  // The three wire formats, each asking for the smallest possible answer.
  const base = spec.baseUrl.replace(/\/+$/, "");
  const anthropic = spec.format === "anthropic";
  const url = anthropic
    ? `${base}/v1/messages`
    : spec.format === "responses"
      ? `${base}/responses`
      : `${base}/chat/completions`;
  const body = anthropic
    ? { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }
    : spec.format === "responses"
      ? { model, max_output_tokens: 16, input: "hi" }
      : { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };

  const headers: Record<string, string> = { "content-type": "application/json" };
  // An Anthropic-format endpoint takes the key in whichever header its
  // `auth:` says; everything else is a bearer token.
  if (anthropic && spec.auth === "x-api-key") {
    headers["x-api-key"] = token;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${token}`;
    if (anthropic) headers["anthropic-version"] = "2023-06-01";
  }
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k.toLowerCase()] = resolve(tenant, workspace, v);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const { verdict, detail } = verdictFor(res.status);
    // The check is itself a use of the credential, and the most informative
    // one there is: it was made for exactly this purpose.
    const named = spec.token.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/)?.[1];
    if (named) {
      let host = spec.baseUrl;
      try {
        host = new URL(spec.baseUrl).host;
      } catch {
        // an unparseable base_url is its own problem, reported above
      }
      noteSecretUse(tenant, named, { host, status: res.status });
    }
    // The provider's own words when it refused. They are the difference
    // between "fix your key" and "fix your model id", and they are only
    // ever in the body.
    let said = "";
    if (!res.ok) {
      said = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    }
    return {
      provider: label,
      model,
      verdict,
      // Busy counts as healthy: the key worked, the provider is simply full.
      ok: verdict === "ok" || verdict === "busy",
      status: res.status,
      ms: Date.now() - began,
      detail: said ? `${detail} — ${said}` : detail,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("unreachable", /timeout|aborted/i.test(message) ? `no answer within ${TIMEOUT_MS / 1000}s` : message);
  }
}


/** A provider block in use, and where it is declared — because "which file
 *  do I edit" is the next question after "this key is dead". */
export interface ProviderInUse {
  spec: ProviderSpec;
  /** The workspace whose vault resolves this block's secrets. Null for the
   *  account's own block, which resolves against the account vault. */
  workspace: string | null;
  /** Human-readable origin: "account", "rank-desk", "rank-desk/writer". */
  declaredIn: string;
  /** The model id a run would send for the cheapest tier, which is what a
   *  health check should spend. */
  model: string;
}

/** The cheapest tier's id for a provider block: what it calls `fast`, or
 *  our own fast model when it remaps nothing. */
function cheapestModel(spec: ProviderSpec): string {
  return spec.models.fast || spec.models.default || spec.models.max || "claude-haiku-4-5-20251001";
}

function frontmatterOf(file: string): Record<string, unknown> {
  try {
    return (matter(fs.readFileSync(file, "utf8")).data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Every distinct provider block this account would actually use, read from
 * the same three places a run reads them: the account, each workspace, each
 * agent.
 *
 * Deduplicated by endpoint and token, because ten agents sharing one gateway
 * are one credential and checking it ten times spends ten times as much to
 * learn the same fact. The origin recorded is the first one seen, which is
 * the broadest — an account block covers everything under it.
 */
export function providersInUse(tenant: string): ProviderInUse[] {
  const out: ProviderInUse[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown, workspace: string | null, declaredIn: string) => {
    const spec = parseProvider(raw);
    if (!spec || !spec.baseUrl) return;
    // The token is part of the identity: the same gateway with two different
    // keys is two credentials, and either can die on its own.
    const key = `${workspace ?? ""}|${spec.baseUrl}|${spec.token}|${cheapestModel(spec)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec, workspace, declaredIn, model: cheapestModel(spec) });
  };

  add(frontmatterOf(path.join(accountDir(tenant), "AGENTS.md")).provider, null, "account");
  for (const ws of safeList(() => listWorkspaces(tenant))) {
    const dir = workspaceDir(tenant, ws.name);
    add(frontmatterOf(path.join(dir, "AGENTS.md")).provider, ws.name, ws.name);
    for (const agent of safeList(() => listAgents(tenant, ws.name))) {
      add(
        frontmatterOf(path.join(dir, "agents", agent.name, "agent.md")).provider,
        ws.name,
        `${ws.name}/${agent.name}`,
      );
    }
  }
  return out;
}

function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

/**
 * Check every provider this account uses, one at a time.
 *
 * Serial on purpose: this is housekeeping on a tick, the whole point is that
 * it is cheap, and firing twelve model requests at once to save eight
 * seconds nobody is waiting for would be a strange trade.
 */
export async function checkAccountProviders(tenant: string): Promise<(ProviderCheck & { declaredIn: string })[]> {
  const results: (ProviderCheck & { declaredIn: string })[] = [];
  for (const use of providersInUse(tenant)) {
    const check = await checkProvider(tenant, use.workspace, use.spec, use.model);
    results.push({ ...check, declaredIn: use.declaredIn });
  }
  return results;
}
