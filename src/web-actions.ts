// The web, as actions. One question answered in one place: which provider
// can do which action, and what does foldrun do when none is named?
//
// An action is a call with a fixed input and a fixed output — search takes a
// query and returns URLs, fetch takes a URL and returns the page — whoever
// answers it. A provider is the list of actions it has an adapter for. foldrun
// is a provider like any other, and the one used when `web_<action>:` is
// unset. A provider named for an action it cannot do is an error in `check`,
// never a quiet fall back to ours: a fallback would bill and behave
// differently from what the file says.
//
// Browse has a second level: inside a page, the steps and modes of
// web_browse. A browser reached over CDP is driven by our own code, so it
// takes every step and mode unless it is listed as lacking one; a vendor
// that runs the steps itself would list the few it has.
//
// The vendor facts (endpoint, key, docs page, the date the adapter was last
// matched to those docs) stay on SEARCH_APIS, FETCH_APIS and BROWSER_APIS in
// providers.ts; this file reads them rather than restating them.

import { SEARCH_APIS, FETCH_APIS, BROWSER_APIS } from "./providers.ts";

export const WEB_ACTIONS = ["search", "fetch", "browse", "crawl", "map", "extract", "answer", "monitor"] as const;
export type WebAction = (typeof WEB_ACTIONS)[number];

/** What web_browse can return — its `mode`. Kept equal to the tool's own
 *  MODES by the platform's gallery test. */
export const BROWSE_MODES = [
  "text", "markdown", "html", "links", "meta", "table", "network", "screenshot", "pdf", "capture",
  "aria", "map", "crawl", "console", "vitals", "a11y", "diff", "feed", "webmcp", "react",
] as const;

/** What web_browse can do in a page — its `actions` steps. Kept equal to
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

/** Ours. Search is the account's SearXNG; fetch is a plain HTTP read; browse
 *  is the account's browser pod, which also maps, crawls and extracts. */
export const FOLDRUN: WebProvider = {
  name: "foldrun",
  title: "foldrun",
  actions: {
    search: { status: "live", how: "web_search — the account's own SearXNG" },
    fetch: { status: "live", how: "web_fetch — one plain HTTP request in the sandbox" },
    browse: { status: "live", how: "web_browse — the account's browser pod", via: "cdp" },
    crawl: { status: "live", how: "web_browse mode=crawl" },
    map: { status: "live", how: "web_browse mode=map" },
    extract: { status: "live", how: "web_browse's extract step — selectors to JSON rows" },
    answer: { status: "planned", how: "not built yet" },
    monitor: { status: "planned", how: "not built yet" },
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
  for (const a of SEARCH_APIS as readonly Facts[]) add(a, "search", { status: "live", how: `web_search via ${a.title}` });
  for (const a of FETCH_APIS as readonly Facts[]) add(a, "fetch", { status: "live", how: `web_fetch via ${a.title}` });
  for (const a of BROWSER_APIS as readonly Facts[]) {
    add(a, "browse", { status: "live", how: `web_browse on ${a.title}`, via: "cdp", ...(a.lacks?.length ? { lacks: a.lacks } : {}) });
  }
  return [FOLDRUN, ...byName.values()];
}

/** The names a provider answers to, for lookups. */
function aliasesOf(name: string): string[] {
  const all = [...SEARCH_APIS, ...FETCH_APIS, ...BROWSER_APIS] as readonly Facts[];
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
  const field = `web_${action}`;
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

/** The actions that have no tool of their own yet: their `web_<action>:`
 *  key is still checked, so a provider named for one it cannot do is caught
 *  now rather than when the tool arrives. search, fetch and browse are
 *  checked by webProblems in providers.ts, which also knows model providers. */
const UNTOOLED: readonly WebAction[] = ["crawl", "map", "extract", "answer", "monitor"];

/** Every `web_<action>:` value that names a provider unable to do it — the
 *  sentences resolveWebAction gives. Empty when all are unset or answerable. */
export function actionProblems(front: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const action of UNTOOLED) {
    const raw = front[`web_${action}`];
    if (raw === undefined || raw === null || raw === "") continue;
    const name = typeof raw === "string" ? raw : typeof raw === "object" && raw && typeof (raw as { name?: unknown }).name === "string" ? (raw as { name: string }).name : null;
    if (name === null) {
      out.push(`web_${action}: takes a provider name, or a block with name:.`);
      continue;
    }
    const choice = resolveWebAction(action, name);
    if (choice.error) out.push(choice.error);
  }
  return out;
}
