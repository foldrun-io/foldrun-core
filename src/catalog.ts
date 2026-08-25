// The model catalogue: what a gateway can actually run, cached.
//
// "Any model they want" is only an offer if picking a wrong one fails in one
// line at step start — not three minutes in, as an agent that narrates tool
// calls into prose because its model cannot make them. OpenRouter's models
// endpoint declares, per model, which parameters it supports (`tools` being
// the one that decides whether an agent loop is possible at all), plus
// context length and real prices. This module fetches that once, caches it
// on disk, and answers three questions from the cache:
//
//   - can this model drive tools?          → the run-start gate
//   - what models exist, at what price?    → `model:` autocomplete
//   - what does a token actually cost?     → metering for routed models
//
// Everything degrades to "don't know": a missing cache, an offline fetch or
// an unknown id yields null, and callers treat null as "no opinion" — the
// gate never blocks on ignorance, only on knowledge. A preset reference
// (`@preset/…`) is opaque by design: its settings live in the provider's
// dashboard, so the catalogue has no opinion about it either.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { resolveModel, resolveTier, MODEL_TIERS, EFFORT_LEVELS, type Effort, type Tier, type FlowInfo } from "./store.ts";
import type { FlowWarning } from "./flow-lint.ts";

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per input token, as the gateway quotes it (not per MTok). */
  promptPrice: number | null;
  /** USD per output token. */
  completionPrice: number | null;
  /** Can this model make tool calls? Null when the gateway doesn't say. */
  tools: boolean | null;
  /** Does it take a reasoning-depth parameter? (What `effort:` needs.) */
  reasoning: boolean | null;
  /** The effort levels this model accepts, when the gateway names them —
   *  OpenRouter's level names are ours (low…max, plus minimal/none below
   *  our scale), so no translation table sits between the two. */
  efforts: string[] | null;
}

export interface Catalog {
  /** The base_url this catalogue was fetched from. */
  baseUrl: string;
  fetchedAt: string;
  models: CatalogModel[];
}

/** A day. Model lists move weekly, not hourly, and a stale price in an
 *  autocomplete hint is a smaller failure than a fetch on every keystroke. */
const TTL_MS = 24 * 60 * 60 * 1000;

const cacheFile = (baseUrl: string) =>
  path.join(
    dataRoot(),
    "catalog",
    // One file per endpoint, named legibly: catalog/openrouter.ai.json.
    `${new URL(baseUrl).hostname.replace(/[^a-z0-9.-]/gi, "_")}.json`,
  );

function parseModels(payload: unknown): CatalogModel[] {
  const data = (payload as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string") continue;
    const supported = Array.isArray(m.supported_parameters)
      ? m.supported_parameters.map(String)
      : null;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const price = (k: string) => {
      const n = Number(pricing[k]);
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      contextLength: Number.isFinite(Number(m.context_length)) ? Number(m.context_length) : null,
      promptPrice: price("prompt"),
      completionPrice: price("completion"),
      tools: supported ? supported.includes("tools") : null,
      reasoning: supported ? supported.includes("reasoning") : null,
      efforts: Array.isArray((m.reasoning as Record<string, unknown> | undefined)?.supported_efforts)
        ? ((m.reasoning as Record<string, unknown>).supported_efforts as unknown[]).map(String)
        : null,
    });
  }
  return out;
}

/** The cache as it stands, however old — null only when nothing was ever
 *  fetched. Reading never touches the network. */
export function readCatalog(baseUrl: string): Catalog | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(baseUrl), "utf8")) as Catalog;
    return Array.isArray(parsed.models) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The cache, refreshed over the network when it is older than the TTL.
 * A failed fetch keeps the stale copy — offline is a reason to be out of
 * date, not a reason to forget everything — and returns null only when
 * there is nothing at all to fall back on.
 */
export async function loadCatalog(baseUrl: string): Promise<Catalog | null> {
  const cached = readCatalog(baseUrl);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) return cached;

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const models = parseModels(await res.json());
    if (!models.length) throw new Error("empty model list");
    const catalog: Catalog = { baseUrl, fetchedAt: new Date().toISOString(), models };
    fs.mkdirSync(path.dirname(cacheFile(baseUrl)), { recursive: true });
    // Atomic like every other store write: a crashed refresh must not leave
    // half a JSON file where the whole catalogue used to be.
    const tmp = cacheFile(baseUrl) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(catalog));
    fs.renameSync(tmp, cacheFile(baseUrl));
    return catalog;
  } catch {
    return cached; // stale beats nothing; null when there is no nothing
  }
}

/** A preset reference — settings live in the gateway's dashboard, opaque to
 *  us on purpose. The catalogue offers no opinion on one. */
export const isPresetRef = (model: string) => model.startsWith("@preset/");

export function findModel(catalog: Catalog | null, id: string): CatalogModel | null {
  if (!catalog || isPresetRef(id)) return null;
  return catalog.models.find((m) => m.id === id) ?? null;
}

export interface ModelVerdict {
  ok: boolean;
  /** One line, naming the cause and the nearest fix. Only set when !ok. */
  reason?: string;
}

/**
 * The run-start gate. Only ever fails on *knowledge*: an id the catalogue
 * has, whose declared capabilities rule the step out. Unknown ids, preset
 * refs, tier names that resolved elsewhere, and an absent catalogue all
 * pass — the model call itself is the authority of last resort, and a gate
 * that blocks on ignorance would make offline development impossible.
 */
export function checkModel(
  catalog: Catalog | null,
  modelId: string,
  needs: { tools: boolean },
): ModelVerdict {
  const m = findModel(catalog, modelId);
  if (!m) return { ok: true };
  if (needs.tools && m.tools === false) {
    const alternative = nearestWithTools(catalog!, m);
    return {
      ok: false,
      reason:
        `model ${m.id} cannot call tools, and this agent declares some — the run would ` +
        `narrate tool use as text instead of doing it.` +
        (alternative ? ` Nearest model that can: ${alternative.id}.` : ""),
    };
  }
  return { ok: true };
}

/** Same family first (everything before the slash), then anything with
 *  tools — "use the provider's sibling" is advice people actually take. */
function nearestWithTools(catalog: Catalog, from: CatalogModel): CatalogModel | null {
  const vendor = from.id.split("/")[0];
  const candidates = catalog.models.filter((m) => m.tools === true);
  return candidates.find((m) => m.id.startsWith(vendor + "/")) ?? candidates[0] ?? null;
}

/** True when `effort:` will be silently ignored by this model — worth a
 *  trace line, never a failure: the step still runs, just without the depth
 *  the file asked for. */
export function effortIgnored(catalog: Catalog | null, modelId: string): boolean {
  const m = findModel(catalog, modelId);
  return m !== null && m.reasoning === false;
}

/**
 * The effort that will actually reach this model, and the sentence that
 * explains any difference. Three outcomes:
 *
 *   - the model takes this level        → unchanged, silent
 *   - it reasons, but not at this level → nearest supported level, said aloud
 *   - it does not reason at all         → null, said aloud
 *
 * "Nearest" prefers the highest supported level at or below the request —
 * someone who wrote `max` wanted the ceiling, and the ceiling here is
 * `xhigh` — falling back to the lowest above it. Unknown models and absent
 * catalogues pass the request through untouched: no knowledge, no opinion,
 * same as the gate.
 */
export function clampEffort(
  catalog: Catalog | null,
  modelId: string,
  effort: Effort | null,
): { effort: Effort | null; note: string | null } {
  if (!effort) return { effort: null, note: null };
  const m = findModel(catalog, modelId);
  if (!m) return { effort, note: null };
  if (m.reasoning === false && !m.efforts?.length) {
    return {
      effort: null,
      note: `model ${m.id} takes no reasoning parameter — effort: ${effort} will have no effect`,
    };
  }
  if (!m.efforts?.length) return { effort, note: null }; // reasons, levels unnamed
  const supported = EFFORT_LEVELS.filter((l) => m.efforts!.includes(l));
  if (!supported.length || supported.includes(effort)) return { effort, note: null };
  const want = EFFORT_LEVELS.indexOf(effort);
  const below = [...supported].reverse().find((l) => EFFORT_LEVELS.indexOf(l) < want);
  const clamped = below ?? supported[0];
  return {
    effort: clamped,
    note:
      `model ${m.id} supports effort ${supported.join(", ")} — ` +
      `effort: ${effort} runs as ${clamped}`,
  };
}

/**
 * What one step actually cost through this gateway, or null when the
 * catalogue can't say. The SDK's own costUsd is priced off Anthropic's
 * table, which is wrong for every routed model — so when the catalogue
 * knows better, its number wins.
 */
export function catalogCost(
  catalog: Catalog | null,
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const m = findModel(catalog, modelId);
  if (!m || m.promptPrice == null || m.completionPrice == null) return null;
  return usage.inputTokens * m.promptPrice + usage.outputTokens * m.completionPrice;
}

/** Catalogue entries as completion items: price per MTok, context, and the
 *  one capability that decides agent-worthiness. Tool-capable models first —
 *  on an agent platform they are almost always what the author wants. */
export function catalogCompletions(catalog: Catalog | null): { id: string; hint: string }[] {
  if (!catalog) return [];
  const perMTok = (v: number | null) => (v == null ? "?" : `$${(v * 1_000_000).toFixed(2)}`);
  const ctx = (n: number | null) => (n == null ? "" : n >= 1000 ? ` · ${Math.round(n / 1000)}k ctx` : ` · ${n} ctx`);
  return [...catalog.models]
    .sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      hint: `${perMTok(m.promptPrice)}/${perMTok(m.completionPrice)} MTok${ctx(m.contextLength)}${m.tools === false ? " · no tools" : ""}`,
    }));
}

// -------------------------------------------------------------- edit-time

/** What the lint needs to know about each agent: its own model, and whether
 *  it declares any tools at all. */
export interface AgentModelInfo {
  name: string;
  model: string;
  usesTools: boolean;
}

/**
 * The run-start gate's veto, raised while the file is still open. Same
 * knowledge, earlier moment: a step whose resolved model the catalogue says
 * cannot call tools — run by an agent that declares some — gets a warning in
 * the editor instead of a failed step tomorrow morning. Advisory like every
 * flow lint; the run-start gate stays the enforcement.
 */
export function lintFlowModels(
  flow: FlowInfo,
  agents: AgentModelInfo[],
  catalog: Catalog | null,
  providerModels: Partial<Record<Tier, string>> = {},
): FlowWarning[] {
  if (!catalog) return [];
  const warnings: FlowWarning[] = [];
  const byName = new Map(agents.map((a) => [a.name, a]));

  // The same remap the runner applies on the wire: a tier the provider
  // block renames is checked as the gateway's id.
  const wire = (value: string): string => {
    const resolved = resolveModel(value);
    const tier = (Object.entries(MODEL_TIERS) as [Tier, string][]).find(
      ([, id]) => id === resolved,
    )?.[0] ?? resolveTier(value);
    return (tier && providerModels[tier]) || resolved;
  };

  flow.steps.forEach((step, i) => {
    if (step.subflow) return; // the subflow's own lint covers its steps
    const agent = byName.get(step.agent);
    if (!agent?.usesTools) return;
    const model = wire(step.model ?? flow.model ?? agent.model);
    const verdict = checkModel(catalog, model, { tools: true });
    if (!verdict.ok) {
      warnings.push({
        step: i,
        line: step.line,
        message: `"${step.agent}" would run on ${model}, which cannot call tools`,
        detail: verdict.reason!,
      });
    }
  });
  return warnings;
}
