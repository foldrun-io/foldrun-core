// Web search and `network:` (FOL-128, foldrun-docs/network.md#search).
//
// A step held to its list — restricted (trusted or none), enforced, on the
// k8s tier — runs in a `filtered` pod: Cilium lets it reach the egress proxy
// and nothing else, and (FOLDRUN_RUN_DNS_WALL) it has no DNS. The account's
// search pod (SearXNG, which has the world) is not reachable from there. A
// named search API (`web: {search: brave}`) already works: its host is a
// site the step declares, and its key is filled at the proxy. foldrun's own
// engine did not: the tool was pointed at an address the wall drops.
//
// The semantics chosen (owner, 5 Nov 2026: search should work there):
//
//   - The account's engine is a platform service, not a site on the list.
//     A held step reaches it through the egress proxy's search door
//     (`/s/<lease>/search`), lease-authenticated, and only when this
//     module says the step searches our engine (grant.search, which the
//     runner writes and the pod cannot). Nothing is added to the list.
//   - A query is a message out — to the public engines SearXNG asks — so
//     the door holds what it may say: only a fixed set of index engines
//     (none that fetches a URL named in the query, none that federates to
//     instances a query could name), no engine or bang chosen inside the
//     query, no URL and no `${NAME}` placeholder in it. Every query is a
//     line in the run trace, so what left is on the record.
//   - Results are data. Nothing in them widens the list: fetching a result
//     is a CONNECT through the proxy, held to the list like any other.
//
// Everything else — a step whose list is open or only reported, a step on
// an executor that walls nothing — searches exactly as before.

import type { NetworkLevel } from "./network.ts";
import { readSearchSettings, resolveSearch } from "./providers.ts";
import { resolveActionApi } from "./web-actions.ts";

/** The `web` actions that ask a search engine when no provider answers them. */
export const SEARCHING_ACTIONS = ["search", "answer", "monitor"] as const;
export type SearchingAction = (typeof SEARCHING_ACTIONS)[number];

/** The searching actions a provider answers instead of our engine, from an
 *  agent's resolved `web:` block (webConfig(...).raw) — the runner's reading
 *  of it: a search API or a model provider's own search for `search`, an
 *  answer or monitor provider for those. */
export function searchProvided(raw: Record<string, unknown>): SearchingAction[] {
  const out: SearchingAction[] = [];
  const search = resolveSearch(readSearchSettings(raw.search).rest, "search");
  if (search.provider && !search.error) out.push("search");
  for (const a of ["answer", "monitor"] as const) if (resolveActionApi(a, raw[a]).provider) out.push(a);
  return out;
}

/** What the proxy is told on the grant: the door is open for this step, and
 *  at most this many searches go through it. */
export interface SearchDoorGrant {
  max?: number;
}

/**
 * May this step search through the egress proxy's door? The runner asks,
 * from its own resolved config — never the pod's environment — and after
 * the lease, so `enforce` is the effective one (the install's switch too).
 *
 * Only a step held to a restricted list: the others reach the engine as
 * before. Only the actions our engine answers. And where the list was made
 * narrow on purpose — level `none` (only what the step declares) or
 * `defaults: false` (no trusted list) — the action must be written out in
 * `web: {actions: [...]}`: a bare `tools: [web]` does not open a way out for
 * a query that the list's author never named. Every searching action gives
 * any program in the step that same way out (curl can use the door too).
 */
export function searchDoorWanted(o: {
  level: NetworkLevel;
  /** The trusted list is part of the step's list (network: defaults). */
  defaults: boolean;
  /** Will the proxy refuse a site off the list (the lease's enforce)? */
  enforce: boolean;
  /** The step has the web tool. */
  web: boolean;
  /** The `web: {actions: [...]}` in force, or null for all. */
  actions: readonly string[] | null | undefined;
  /** The searching actions a provider answers instead of our engine. */
  provided: readonly SearchingAction[];
  /** The step's `limits:` (cascaded), for the door's own count. */
  limits?: Record<string, number>;
}): { door: SearchDoorGrant | null; line?: string } {
  if (o.level === "open" || !o.enforce || !o.web) return { door: null };
  const ours = SEARCHING_ACTIONS.filter((a) => (!o.actions || o.actions.includes(a)) && !o.provided.includes(a));
  if (!ours.length) return { door: null };
  if ((o.level === "none" || !o.defaults) && !o.actions) {
    return { door: null, line: o.level === "none" ? SEARCH_NONE_UNNAMED : SEARCH_NO_DEFAULTS_UNNAMED };
  }
  // limits: — `web` bounds every action; else each searching action's own
  // key, and only when every one this step may use has one.
  const lim = o.limits ?? {};
  const each = ours.map((a) => lim[`web.${a}`]);
  const max = typeof lim.web === "number" ? lim.web : each.every((n) => typeof n === "number") ? each.reduce((s, n) => s + (n as number), 0) : undefined;
  return { door: max !== undefined ? { max } : {}, line: SEARCH_DOOR_LINE };
}

/** The trace lines for a held step that is not given the door. */
export const SEARCH_NONE_UNNAMED =
  "search: not offered — this step's network: none allows only what it declares, and its web: block names no actions, so search is not one of them. Write web: {actions: [search, …]} to let it search through the egress proxy.";
export const SEARCH_NO_DEFAULTS_UNNAMED =
  "search: not offered — this step's network: drops the trusted list (defaults: false), and its web: block names no actions, so search is not one of them. Write web: {actions: [search, …]} to let it search through the egress proxy.";

/** The trace line a held step that searches carries, at its start. */
export const SEARCH_DOOR_LINE =
  "search: through the egress proxy — the account's search engine answers this step's queries from a fixed set of engines; a query's words leave for those engines, and each query is a line in this trace; a result is data, and fetching it is held to network: like any other site";

/** On a held step's sandbox beside the door's address: the web tool reads
 *  it to keep the address's path and to mark results as outside content. */
export const SEARCH_HELD_ENV = "FOLDRUN_SEARCH_HELD";

/** The runner's word to the platform's driver: the search door's address
 *  for this step (its grant carries `search`). The driver takes it out of
 *  the sandbox's environment and, for a step it walls, points the web tool
 *  there (FOLDRUN_SEARCH_URL, with SEARCH_HELD_ENV). */
export const SEARCH_DOOR_ENV = "FOLDRUN_SEARCH_DOOR";
