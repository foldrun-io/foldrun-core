// The web, as actions. One question answered in one place: which provider
// can do which action, and what does foldrun do when none is named?
//
// An action is a call with a fixed input and a fixed output — search takes a
// query and returns URLs, fetch takes a URL and returns the page — whoever
// answers it. A provider is the list of actions it has an adapter for. foldrun
// is a provider like any other, and the one used when `web: {<action>: …}` is
// unset. A provider named for an action it cannot do is an error in `check`,
// never a quiet fall back to ours: a fallback would bill and behave
// differently from what the file says.
//
// Browse has a second level: inside a page, the steps and modes of
// the browse action. A browser reached over CDP is driven by our own code, so it
// takes every step and mode unless it is listed as lacking one; a vendor
// that runs the steps itself would list the few it has.
//
// The vendor facts (endpoint, key, docs page, the date the adapter was last
// matched to those docs) stay on SEARCH_APIS, FETCH_APIS and BROWSER_APIS in
// providers.ts; this file reads them rather than restating them.

import { SEARCH_APIS, FETCH_APIS, BROWSER_APIS, ACTION_APIS, WEB_ACTIONS, webConfig, type WebAction } from "./providers.ts";

export { WEB_ACTIONS, type WebAction };

/** What the browse action can return — its `mode`. Kept equal to the tool's own
 *  MODES by the platform's gallery test. */
export const BROWSE_MODES = [
  "text", "markdown", "html", "links", "meta", "table", "network", "screenshot", "pdf", "capture",
  "aria", "map", "crawl", "console", "vitals", "a11y", "diff", "feed", "webmcp", "react",
] as const;

/** What the browse action can do in a page — its `actions` steps. Kept equal to
 *  the tool's own ACTIONS by the platform's gallery test. */
export const BROWSE_STEPS = [
  "click", "dblclick", "rightclick", "hover", "check", "uncheck", "drag", "fill", "type", "press", "select",
  "wait", "goto", "screenshot", "pdf", "scroll", "paste", "upload", "download", "extract", "frame", "tab",
  "back", "forward", "reload", "focus", "clear", "highlight", "keyboard", "keydown", "keyup", "mouse", "wheel",
  "tap", "swipe", "clipboard", "eval", "get", "expect", "if", "mock", "unmock", "offline", "cookie",
  "localstorage", "sessionstorage", "viewport", "dialog", "solve", "pushstate", "insert", "webmcp", "login",
] as const;

export interface ActionSupport {
  /** live: callable today. planned: agreed and not built — naming it is an
   *  error that says so, rather than a tool that does nothing. */
  status: "live" | "planned";
  /** How: which tool serves it, and for foldrun's own, with what. */
  how: string;
  /** Browse only. cdp: our code drives the browser, so every step and mode
   *  works unless listed in `lacks`. api: the vendor runs the steps, and
   *  `steps`/`modes` list what it has. */
  via?: "cdp" | "api";
  steps?: readonly string[];
  modes?: readonly string[];
  lacks?: readonly string[];
  /** The vendor page the adapter was built from, and the day it was last
   *  matched to it (YYYY-MM-DD). Absent on foldrun's own. */
  docs?: string;
  checked?: string;
}

export interface WebProvider {
  name: string;
  title: string;
  actions: Partial<Record<WebAction, ActionSupport>>;
}

/** Ours: every action, and none of them with a second model in it. */
export const FOLDRUN: WebProvider = {
  name: "foldrun",
  title: "foldrun",
  actions: {
    search: { status: "live", how: "the account's own SearXNG" },
    fetch: { status: "live", how: "one plain HTTP request in the sandbox" },
    browse: { status: "live", how: "the account's browser pod", via: "cdp" },
    crawl: { status: "live", how: "plain HTTP, same site, robots.txt honoured" },
    map: { status: "live", how: "the site's sitemaps, else its links" },
    extract: { status: "live", how: "selectors, or the page's own JSON-LD and OpenGraph — no model" },
    answer: { status: "live", how: "search, read the top pages, rank the passages that answer — no model" },
    monitor: { status: "live", how: "a page's lines or a query's results, against the last call, in state/" },
  },
};

type Facts = { name: string; title: string; aliases?: string[]; docs?: string; checked?: string; lacks?: readonly string[] };

/** Every provider and what it can do, foldrun first. Built from the vendor
 *  lists so a vendor added there is here without a second edit. */
export function webProviders(): WebProvider[] {
  const byName = new Map<string, WebProvider>();
  const add = (f: Facts, action: WebAction, support: ActionSupport) => {
    const p = byName.get(f.name) ?? { name: f.name, title: f.title, actions: {} };
    p.actions[action] = { ...support, ...(f.docs ? { docs: f.docs } : {}), ...(f.checked ? { checked: f.checked } : {}) };
    byName.set(f.name, p);
  };
  for (const a of SEARCH_APIS as readonly Facts[]) add(a, "search", { status: "live", how: a.title });
  for (const a of FETCH_APIS as readonly Facts[]) add(a, "fetch", { status: "live", how: a.title });
  for (const a of BROWSER_APIS as readonly Facts[]) {
    add(a, "browse", { status: "live", how: a.title, via: "cdp", ...(a.lacks?.length ? { lacks: a.lacks } : {}) });
  }
  for (const [action, apis] of Object.entries(ACTION_APIS) as [WebAction, readonly Facts[]][]) {
    for (const a of apis) add(a, action, { status: "live", how: a.title });
  }
  return [FOLDRUN, ...byName.values()];
}

/** The names a provider answers to, for lookups. */
function aliasesOf(name: string): string[] {
  const all = [...SEARCH_APIS, ...FETCH_APIS, ...BROWSER_APIS, ...Object.values(ACTION_APIS).flat()] as readonly Facts[];
  return all.filter((a) => a.name === name).flatMap((a) => a.aliases ?? []);
}

export function findWebProvider(name: string): WebProvider | undefined {
  const key = name.trim().toLowerCase();
  if (key === "" || key === "ours") return FOLDRUN;
  return webProviders().find((p) => p.name === key || aliasesOf(p.name).includes(key));
}

/** The live providers for an action, foldrun first — for "these do" lines. */
export function providersFor(action: WebAction): string[] {
  return webProviders().filter((p) => p.actions[action]?.status === "live").map((p) => p.name);
}

export type ActionChoice =
  | { provider: WebProvider; support: ActionSupport; error?: undefined }
  | { provider?: undefined; support?: undefined; error: string };

/**
 * Who does `action`. Unset is foldrun. A named provider must have the action
 * live; anything else is an error naming the providers that do — the rule is
 * "fix the file", never "we used ours instead".
 */
export function resolveWebAction(action: WebAction, name?: string | null): ActionChoice {
  const field = `web.${action}`;
  const p = name == null ? FOLDRUN : findWebProvider(name);
  if (!p) {
    return { error: `${field}: ${name} — no provider by that name. These ${action}: ${providersFor(action).join(", ")}.` };
  }
  const s = p.actions[action];
  if (!s) {
    const live = providersFor(action);
    return {
      error: `${field}: ${p.name} does not ${action} here.` +
        (live.length ? ` These do: ${live.join(", ")}.` : " No provider has it wired yet.") +
        (FOLDRUN.actions[action]?.status === "live" ? " Unset uses foldrun." : ""),
    };
  }
  if (s.status === "planned") {
    const others = providersFor(action).filter((n) => n !== p.name);
    return {
      error: `${field}: ${p.title}'s own ${action} is not built yet` +
        (others.length ? ` — name a provider that has it: ${others.join(", ")}.` : " and no provider has it wired either."),
    };
  }
  return { provider: p, support: s };
}

/** Can this browser run this step, or return this mode? */
export function browseSupports(support: ActionSupport, stepOrMode: string): boolean {
  if (support.via === "cdp") return !(support.lacks ?? []).includes(stepOrMode);
  return (support.steps ?? []).includes(stepOrMode) || (support.modes ?? []).includes(stepOrMode);
}

/** The browsers that can run a step or mode — for the error when one cannot. */
export function browsersFor(stepOrMode: string): string[] {
  return webProviders()
    .filter((p) => p.actions.browse?.status === "live" && browseSupports(p.actions.browse, stepOrMode))
    .map((p) => p.name);
}

/** Vendor actions whose adapter has not been matched to the vendor's docs
 *  within `days` — each as "provider action (checked …)". Empty is healthy.
 *  The test that calls this is the rule "integrations follow the latest
 *  docs" in a form CI can fail on. */
export function staleIntegrations(today: string, days = 90): string[] {
  const out: string[] = [];
  const limit = Date.parse(today) - days * 86_400_000;
  for (const p of webProviders()) {
    if (p === FOLDRUN) continue;
    for (const [action, s] of Object.entries(p.actions)) {
      if (!s || s.status !== "live") continue;
      if (!s.docs || !s.checked) out.push(`${p.name} ${action} (no docs page or check date recorded)`);
      else if (Date.parse(s.checked) < limit) out.push(`${p.name} ${action} (checked ${s.checked})`);
    }
  }
  return out;
}

/** The actions after search, fetch and browse. Those three are resolved by
 *  providers.ts, which also knows the model providers that search. */
export const NEWER_ACTIONS = ["crawl", "map", "extract", "answer", "monitor"] as const;
type NewerAction = (typeof NEWER_ACTIONS)[number];

export type ActionApiChoice =
  | { provider: null; error?: undefined }
  | { provider: string; secret: string; host: string; error?: undefined }
  | { provider: null; error: string };

/**
 * Who does one of the newer actions, and with which key: unset (or
 * "foldrun") is ours and needs none; a name, or `{name, key: ${VAULT_NAME}}`
 * for a key stored under another name, is that provider — if it has the
 * action. The runner turns a provider into FOLDRUN_WEB_<ACTION>_VIA, the
 * secret the step holds, and the one host that secret may reach.
 */
export function resolveActionApi(action: NewerAction, raw: unknown): ActionApiChoice {
  const field = `web.${action}`;
  if (raw === undefined || raw === null || raw === "") return { provider: null };
  let name: string;
  let secret: string | undefined;
  if (typeof raw === "string") name = raw;
  else if (typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { name?: unknown }).name === "string") {
    name = (raw as { name: string }).name;
    const key = (raw as { key?: unknown }).key;
    if (key !== undefined) {
      const m = typeof key === "string" ? /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(key.trim()) : null;
      if (!m) return { provider: null, error: `${field}.key must be a \${NAME} reference to a secret in the vault, not the key itself.` };
      secret = m[1];
    }
  } else {
    return { provider: null, error: `${field}: takes a provider name, or a block with name: (and key: for your own vault name).` };
  }
  const choice = resolveWebAction(action, name);
  if (choice.error !== undefined) return { provider: null, error: choice.error };
  if (choice.provider.name === "foldrun") return { provider: null };
  const api = ACTION_APIS[action].find((a) => a.name === choice.provider.name)!;
  return { provider: api.name, secret: secret ?? api.secret, host: api.host };
}

/** Every newer action in the agent's web: block that names a provider unable
 *  to do it — the sentences resolveActionApi gives. Empty when all are unset
 *  or answerable. */
export function actionProblems(front: Record<string, unknown>): string[] {
  const { raw } = webConfig(front);
  return NEWER_ACTIONS.flatMap((a) => {
    const e = resolveActionApi(a, raw[a]).error;
    return e ? [e] : [];
  });
}
