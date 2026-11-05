// Browsing and `network:` (FOL-110, foldrun-docs/proposals/browse-egress.md).
//
// Three tiers, said in the trace:
//
//   hosted  — foldrun's own browser (the account's browser pod, Lightpanda,
//             Obscura, a live session): our network boundary confines it.
//   vendor  — a vendor that takes a customer proxy (Browserbase, Steel,
//             Hyperbrowser, Browserless): through the egress proxy, enforced
//             once that vendor is qualified by our own tests (phase 4).
//   none    — a vendor that always browses through its own network (Bright
//             Data, ZenRows) or any DevTools address: never enforced; a
//             restricted, enforced `network:` refuses it.
//
// Phase 3 (hosted enforcement) holds a browsing step to its list where the
// executor can wall the step's network (the k8s tier, with the install's
// FOLDRUN_BROWSE_ENFORCE=1 — Platform.confinesBrowsing). Such a step gets the
// forward proxy like any other, so its run pod is `filtered`: it reaches the
// egress proxy and nothing else, and the browser runs inside it, in the
// step's own pod. A client that sets another proxy, a CDP context with its
// own proxyServer, a curl that ignores HTTPS_PROXY — each finds no route,
// never a way round the list. DNS is the platform's to wall too (FOL-128:
// foldrun-platform run-dns.ts, FOLDRUN_RUN_DNS_WALL), and its trace says on
// a `dns:` line whether this sandbox may look names up. browseVerdict
// says, for one step, which of the three ways it goes; everywhere else (no
// wall, an open or report-only list) the step browses as it did before
// phase 3, and the trace says so.

import { findBrowserApi, readBrowseSettings, resolveSearch } from "./providers.ts";
import { networkLine, type NetworkLevel, type NetworkPolicy } from "./network.ts";

export type BrowseTier = "hosted" | "vendor" | "none";

/** Set to "1" in a browsing step held to its list (browseVerdict "hosted"):
 *  the web tool gives its browser the forward door as launch options and
 *  refuses what cannot go through it; the platform starts no account browser
 *  pod for the step (its pod could not reach one, and that pod is not walled). */
export const BROWSER_CONFINED_ENV = "FOLDRUN_BROWSER_CONFINED";

/** The vendor a `web.browse` value names (the runner's FOLDRUN_BROWSER_VENDOR),
 *  or null for foldrun's own browser — read the way runner.ts reads it. */
export function browseVendorOf(browse: unknown): string | null {
  const read = readBrowseSettings(browse);
  const choice = resolveSearch(read.rest, "browse");
  return choice.shape === "direct" && choice.provider ? choice.provider : null;
}

/** Which tier a step's browser falls in: no vendor (or foldrun) is ours. */
export function browseTier(vendor: string | null | undefined): { tier: BrowseTier; title: string } {
  const name = (vendor ?? "").trim().toLowerCase();
  if (!name || name === "foldrun") return { tier: "hosted", title: "foldrun's own browser" };
  const api = findBrowserApi(name);
  if (!api) return { tier: "none", title: name };
  return { tier: api.egress === "proxy" ? "vendor" : "none", title: api.title };
}

/** How one browsing step is held to its `network:` list:
 *
 *   legacy  — as before phase 3: no forward proxy, the pod keeps the world,
 *             and the trace says the list does not hold. An open list, a
 *             report-only install, or an executor that cannot wall the
 *             step's network.
 *   hosted  — enforced: the step gets the forward proxy, its pod is walled
 *             to the egress proxy, and foldrun's browser runs in it.
 *   refuse  — a vendor's browser under a restricted, enforced list on an
 *             install that holds browsing: it browses from the vendor's
 *             network, which nothing here can hold to the list, so the step
 *             is refused before anything connects (decision 4). */
export type BrowseVerdict =
  | { kind: "legacy" }
  | { kind: "hosted" }
  | { kind: "refuse"; message: string };

export function browseVerdict(o: {
  /** The step's resolved level (network.ts). */
  level: NetworkLevel;
  /** Will the proxy refuse a site off the list (lease.enforce)? */
  enforce: boolean;
  /** FOLDRUN_BROWSER_VENDOR: the vendor the agent named, if any. */
  vendor: string | null | undefined;
  /** Can this executor wall the step's network (Platform.confinesBrowsing)? */
  confines: boolean;
}): BrowseVerdict {
  if (o.level === "open" || !o.enforce || !o.confines) return { kind: "legacy" };
  const { tier, title } = browseTier(o.vendor);
  if (tier === "hosted") return { kind: "hosted" };
  const why =
    tier === "vendor"
      ? `${title} browses from its own network, and foldrun cannot hold it to network: until that vendor is qualified (FOL-110 phase 4)`
      : `${title} always browses through its own network, and nothing can hold it to network:`;
  return {
    kind: "refuse",
    message:
      `browse: refused before it connected — this step's network: ${o.level} is enforced, and ${why}. ` +
      `Drop browse: ${(o.vendor ?? "").trim()} from the agent's web: block to browse with foldrun's own browser, which is held to the list; ` +
      `or, to accept browsing that no list holds for this one agent, give that agent network: open.`,
  };
}

/** The trace's network line for a step that may browse, on an install with
 *  an egress proxy: the step's list, and whether it holds — `hosted` when
 *  browseVerdict put the step under the wall, else the plain fact that it
 *  does not hold yet, for the browser or anything else in the step. */
export function browseNetworkLine(policy: NetworkPolicy, vendor: string | null | undefined, opts: { hosted?: boolean } = {}): string {
  const what = networkLine(policy, true);
  if (opts.hosted) {
    return `${what} — enforced — hosted: the browser runs inside this step's sandbox, whose network reaches only the egress proxy (which holds the list), so a page, a script or a changed proxy setting reaches no site off the list.`;
  }
  const { tier, title } = browseTier(vendor);
  const now = " — not enforced in this step: it may browse, and browsing does not go through the egress proxy here, so the browser and every other program in this step reach sites directly";
  const later =
    tier === "hosted"
      ? policy.level === "open"
        ? `. Its browser is ${title}; with an open list there is nothing to hold it to`
        : `. Its browser is ${title}: it is held to network: on an install that confines browsing, with the list enforced (FOL-110)`
      : tier === "vendor"
        ? `. Its browser (${title}) browses from the vendor's network: it comes under network: through the egress proxy once that vendor is qualified (FOL-110)`
        : `. Its browser (${title}) always browses through its own network and cannot be held to network: — a restricted, enforced network: will refuse it (FOL-110)`;
  return `${what}${now}${later}.`;
}
