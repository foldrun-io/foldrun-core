// A fetch that goes out only through the local sandbox's site proxy
// (FOL-222). A remote MCP server (Streamable HTTP or SSE) is connected to
// by this process, not by a command inside the walls, so without this its
// connection would pass the walls' site list and address checks. Every
// request here is sent to the proxy — CONNECT for https, an absolute URL
// for http — with the proxy's own credential, and the proxy decides as it
// does for a command: a site not on the list is refused there.
//
// No other way out: there is no direct connection, and a proxy that is not
// up is a refusal, never a fallback.

import http from "node:http";
import tls from "node:tls";
import { Readable } from "node:stream";

export interface SiteProxy {
  host: string;
  port: number;
  /** The proxy's credential: user and password for Proxy-Authorization (Basic). */
  user?: string;
  token?: string;
}

const MAX_REDIRECTS = 5;

/** A fetch whose every request is sent through `proxy`. */
export function proxyFetch(proxy: SiteProxy): typeof fetch {
  const auth = proxy.token ? `Basic ${Buffer.from(`${proxy.user ?? "srt"}:${proxy.token}`).toString("base64")}` : null;
  const once = async (url: URL, method: string, headers: Headers, body: Buffer | null, signal: AbortSignal | null | undefined): Promise<Response> => {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`only http and https go through the sandbox's proxy, not ${url.protocol}`);
    if (url.username || url.password) throw new TypeError("a URL with a user name or password in it is not sent");
    if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      // Hop-by-hop and the proxy's own: never the caller's to set.
      if (!/^(proxy-authorization|proxy-connection|connection|keep-alive|transfer-encoding|upgrade|host)$/i.test(k)) out[k] = v;
    });
    out.host = url.host;
    if (body) out["content-length"] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        // A failed dial to every address is an AggregateError with no message of its own: say its parts.
        reject(err instanceof AggregateError && !err.message ? new Error(err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ") || "the connection failed") : err);
      };
      const onResponse = (res: http.IncomingMessage) => {
        if (settled) return;
        settled = true;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
        }
        const status = res.statusCode ?? 502;
        const noBody = method === "HEAD" || status === 204 || status === 304;
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? "", headers: h }));
      };
      let req: http.ClientRequest;
      const abort = () => {
        req?.destroy();
        fail(signal?.reason ?? new DOMException("aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (url.protocol === "http:") {
        // Plain http: the request itself goes to the proxy, by its full URL.
        req = http.request({ host: proxy.host, port: proxy.port, method, path: url.href, headers: { ...out, ...(auth ? { "proxy-authorization": auth } : {}) } });
        req.on("response", onResponse);
        req.on("error", fail);
        req.end(body ?? undefined);
        return;
      }
      // https: a tunnel through the proxy, then TLS to the site itself.
      const connect = http.request({ host: proxy.host, port: proxy.port, method: "CONNECT", path: `${url.hostname}:${port}`, headers: { host: `${url.hostname}:${port}`, ...(auth ? { "proxy-authorization": auth } : {}) } });
      req = connect;
      connect.on("error", fail);
      connect.on("connect", (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return fail(new Error(`the sandbox's proxy refused ${url.hostname} (${res.statusCode} ${res.statusMessage ?? ""}) — add the site to the sandbox's list (/permissions sandbox allow ${url.hostname})`.trim()));
        }
        const secure = tls.connect({ socket, servername: url.hostname.replace(/^\[|\]$/g, ""), ALPNProtocols: ["http/1.1"] });
        secure.on("error", fail);
        // An agent of one connection: the request rides the tunnel, never a socket of its own.
        const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
        (agent as unknown as { createConnection: () => tls.TLSSocket }).createConnection = () => secure;
        req = http.request({ agent, host: url.hostname, port, method, path: `${url.pathname}${url.search}`, headers: out });
        req.on("response", onResponse);
        req.on("error", fail);
        req.end(body ?? undefined);
      });
      connect.end();
    });
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    let url = new URL(request.url);
    let method = request.method.toUpperCase();
    let body: Buffer | null = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    const headers = new Headers(request.headers);
    const signal = init?.signal ?? request.signal;
    const redirect = init?.redirect ?? request.redirect;
    for (let hop = 0; ; hop++) {
      const res = await once(url, method, headers, body, signal);
      const location = res.headers.get("location");
      if (redirect === "manual" || res.status < 300 || res.status >= 400 || !location) return res;
      await res.body?.cancel();
      if (redirect === "error") throw new TypeError(`redirected to ${location}, and this request refuses redirects`);
      if (hop >= MAX_REDIRECTS) throw new TypeError(`more than ${MAX_REDIRECTS} redirects`);
      const next = new URL(location, url);
      // A credential is never carried to another site.
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
        headers.delete("content-type");
      }
      url = next;
    }
  }) as typeof fetch;
}
