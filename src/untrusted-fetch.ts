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
//
// And every answer is read to a limit (maxBytes, 1 MiB unless the caller
// says otherwise): a tenant's URL can answer forever, and the worker or web
// tier holding it all in memory is the platform's problem, not the tenant's.
// Past the limit the body errors — a caller never gets the first megabyte
// passed off as the whole answer.

import { platform } from "./platform.ts";

/** How many redirects one request may follow. fetch's own limit is 20;
 *  nothing a tenant points the platform at needs more than a couple. */
export const MAX_REDIRECTS = 5;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** Headers that may cross to another origin: none of them can carry a
 *  credential. Everything else — Authorization, a cookie, an x-api-key, a
 *  webhook's signature — stays with the origin it was meant for. */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "content-type", "user-agent"]);

/** What one answer may be, read, unless the caller says otherwise. */
export const MAX_BYTES = 1024 * 1024;

export class ResponseTooLarge extends Error {
  constructor(url: string, maxBytes: number) {
    super(`${url} answered more than ${sizeLabel(maxBytes)} — not read`);
    this.name = "ResponseTooLarge";
  }
}

const sizeLabel = (n: number) => (n % (1024 * 1024) === 0 ? `${n / (1024 * 1024)} MiB` : `${n} bytes`);

/** Statuses whose Response may carry no body (the constructor throws on one). */
const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * `res`, its body read to at most `maxBytes`. The status and headers stand;
 * the body errors with ResponseTooLarge at the limit — `text()`, `json()`
 * and a reader all reject, never resolve short. A declared length past the
 * limit errors at the first read, before a byte is fetched; an undeclared
 * one is counted as it streams (after decompression, so a small gzip that
 * unpacks huge is caught too). Infinity: no limit.
 */
export function capBody(res: Response, maxBytes: number, url: string): Response {
  if (!Number.isFinite(maxBytes) || !res.body || NULL_BODY.has(res.status)) return res;
  const declared = Number(res.headers.get("content-length") ?? NaN);
  const tooLong = Number.isFinite(declared) && declared > maxBytes;
  const reader = res.body.getReader();
  let seen = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (tooLong) {
        reader.cancel().catch(() => {});
        return controller.error(new ResponseTooLarge(url, maxBytes));
      }
      const { done, value } = await reader.read();
      if (done) return controller.close();
      seen += value.byteLength;
      if (seen > maxBytes) {
        reader.cancel().catch(() => {});
        return controller.error(new ResponseTooLarge(url, maxBytes));
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  // Where the answer came from, as the original said.
  Object.defineProperty(out, "url", { value: res.url });
  return out;
}

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
    /** The most the answer may be, read; MAX_BYTES unless said. */
    maxBytes?: number;
  } = {},
): Promise<Response> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  let current = url;
  let req: RequestInit = { ...init };
  for (let hop = 0; ; hop++) {
    const res = await platform.fetchUntrusted(current, { ...req, redirect: "manual" }, { maxBytes });
    const location = REDIRECT.has(res.status) ? res.headers.get("location") : null;
    if (!location) return capBody(res, maxBytes, current);
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
