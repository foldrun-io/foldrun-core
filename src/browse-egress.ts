// Browsing and `network:` (FOL-110, foldrun-docs/proposals/browse-egress.md).
//
// A step that may browse is not held to its `network:` list yet: the runner
// gives it no forward proxy (a browser in the sandbox cannot send credentials
// written into a proxy URL), so the browser — and every other program in that
// step — reaches sites directly. Until the browse service and hosted
// enforcement ship, the trace says so plainly, and says which of the three
// tiers this step's browser will fall in:
//
//   hosted  — foldrun's own browser (the account's browser pod, Lightpanda,
//             Obscura, a live session): our network boundary will confine it.
//   vendor  — a vendor that takes a customer proxy (Browserbase, Steel,
//             Hyperbrowser, Browserless): through the egress proxy, enforced
//             once that vendor is qualified by our own tests.
//   none    — a vendor that always browses through its own network (Bright
//             Data, ZenRows) or any DevTools address: never enforced; a
//             restricted, enforced `network:` will refuse it.

import { findBrowserApi } from "./providers.ts";
import { networkLine, type NetworkPolicy } from "./network.ts";

export type BrowseTier = "hosted" | "vendor" | "none";

/** Which tier a step's browser falls in: no vendor (or foldrun) is ours. */
export function browseTier(vendor: string | null | undefined): { tier: BrowseTier; title: string } {
  const name = (vendor ?? "").trim().toLowerCase();
  if (!name || name === "foldrun") return { tier: "hosted", title: "foldrun's own browser" };
  const api = findBrowserApi(name);
  if (!api) return { tier: "none", title: name };
  return { tier: api.egress === "proxy" ? "vendor" : "none", title: api.title };
}

/** The trace's network line for a step that may browse, on an install with
 *  an egress proxy: the step's list, and the plain fact that it does not
 *  hold yet — for the browser or anything else in the step. */
export function browseNetworkLine(policy: NetworkPolicy, vendor: string | null | undefined): string {
  const { tier, title } = browseTier(vendor);
  const what = networkLine(policy, true);
  const now = " — not enforced in this step: it may browse, and browsing does not go through the egress proxy yet, so the browser and every other program in this step reach sites directly";
  const later =
    tier === "hosted"
      ? `. Its browser is ${title}: it comes under network: when hosted enforcement ships (FOL-110)`
      : tier === "vendor"
        ? `. Its browser (${title}) browses from the vendor's network: it comes under network: through the egress proxy once that vendor is qualified (FOL-110)`
        : `. Its browser (${title}) always browses through its own network and cannot be held to network: — a restricted, enforced network: will refuse it (FOL-110)`;
  return `${what}${now}${later}.`;
}
