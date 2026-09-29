// fetch() for a URL a tenant chose, redirects included.
//
// platform.fetchUntrusted is the seam: on a platform it refuses private and
// cluster addresses (by name, by IP literal, and at connect time through a
// guarded DNS lookup). But it was handed fetch's default `redirect:
// "follow"`, and a redirect is followed inside fetch, past the seam: a
// public host answering `302 Location: http://169.254.169.254/…` sent the
// platform to the metadata endpoint, because an IP literal never reaches the
// DNS lookup the connect-time guard lives in. And the OAuth token POSTs
// carried a client secret to wherever a 307 pointed.
//
// So redirects are followed here, one hop at a time, each hop through the
// seam again — every address a request ends up at is checked the same way
// the first one was. A hop to another origin keeps only the headers that
// cannot carry a credential, and a caller whose request IS a credential
// (a token exchange, a provider key in a header) follows none at all.

import { platform } from "./platform.ts";

/** How many redirects one request may follow. fetch's own limit is 20;
 *  nothing a tenant points the platform at needs more than a couple. */
export const MAX_REDIRECTS = 5;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** Headers that may cross to another origin: none of them can carry a
 *  credential. Everything else — Authorization, a cookie, an x-api-key, a
 *  webhook's signature — stays with the origin it was meant for. */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "content-type", "user-agent"]);

export class RedirectRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectRefused";
  }
}

export async function fetchUntrusted(
  url: string,
  init: RequestInit = {},
  opts: {
    /** The request carries a credential (in its body or its headers):
     *  follow a redirect only within the origin it was sent to. */
    sameOrigin?: boolean;
  } = {},
): Promise<Response> {
  let current = url;
  let req: RequestInit = { ...init };
  for (let hop = 0; ; hop++) {
    const res = await platform.fetchUntrusted(current, { ...req, redirect: "manual" });
    const location = REDIRECT.has(res.status) ? res.headers.get("location") : null;
    if (!location) return res;
    // The body of a redirect is never read; free the socket.
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new RedirectRefused(`${url}: more than ${MAX_REDIRECTS} redirects — not followed`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new RedirectRefused(`${current} redirected to "${location}", which is not a URL`);
    }
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new RedirectRefused(`${current} redirected to a ${next.protocol} URL — not followed`);
    }
    const from = new URL(current);
    const crossOrigin = next.origin !== from.origin;
    if (crossOrigin && opts.sameOrigin) {
      throw new RedirectRefused(
        `${from.origin} redirected to ${next.origin} — not followed: this request carries a credential, and it goes only where it was sent`,
      );
    }
    // fetch's own rewrite: a 303, and a 301/302 answering a POST, is
    // followed as a GET with no body; a 307/308 repeats the request as it was.
    const method = (req.method ?? "GET").toUpperCase();
    const headers = new Headers(req.headers);
    if ((res.status === 303 && method !== "GET" && method !== "HEAD") || ((res.status === 301 || res.status === 302) && method === "POST")) {
      req = { ...req, method: "GET", body: undefined };
      headers.delete("content-type");
    }
    if (crossOrigin) {
      const names: string[] = [];
      headers.forEach((_, name) => names.push(name));
      for (const name of names) if (!CROSS_ORIGIN_SAFE.has(name)) headers.delete(name);
    }
    req = { ...req, headers };
    current = next.toString();
  }
}
