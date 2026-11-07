// A fault-injecting forwarder in front of a REAL S3-compatible server. The
// requests are passed through untouched (SigV4 signs the Host header, so it is
// forwarded as the client sent it), so everything the server does is real;
// the proxy only adds what a test cannot get from a healthy local server:
// a 503 on the Nth part, a connection reset mid-upload, a response cut off
// halfway, a slow answer, and a count of calls in flight.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
}

export type Fault =
  | { status: number; body?: string }
  | { reset: true }
  | { delayMs: number }
  /** Pass the request, then cut the RESPONSE body after this many bytes. */
  | { truncateResponseAt: number }
  /** Pass the request but destroy the connection after this many request body bytes. */
  | { resetRequestAfter: number };

export interface Rule {
  when: (r: Seen) => boolean;
  fault: Fault;
  /** How many matching requests it applies to. Default 1. */
  times?: number;
}

export interface S3Proxy {
  endpoint: string;
  seen: Seen[];
  inFlight: number;
  peakInFlight: number;
  add(rule: Rule): void;
  clearRules(): void;
  reset(): void;
  close(): Promise<void>;
}

export async function s3Proxy(target: string): Promise<S3Proxy> {
  const to = new URL(target);
  const rules: (Rule & { left: number })[] = [];
  const state = { seen: [] as Seen[], inFlight: 0, peak: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const seen: Seen = { method: req.method!, path: decodeURIComponent(url.pathname), query: url.searchParams, headers: req.headers };
    state.seen.push(seen);
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    res.on("close", () => state.inFlight--);
    const rule = rules.find((r) => r.left > 0 && r.when(seen));
    if (rule) rule.left--;
    const f = rule?.fault;
    if (f && "delayMs" in f) await new Promise((r) => setTimeout(r, f.delayMs));
    if (f && "status" in f) {
      req.resume();
      res.writeHead(f.status, { "content-type": "application/xml" }).end(f.body ?? `<Error><Code>Injected${f.status}</Code><Message>injected</Message></Error>`);
      return;
    }
    if (f && "reset" in f) {
      req.resume();
      req.socket.destroy();
      return;
    }
    const up = http.request(
      { host: to.hostname, port: to.port, method: req.method, path: req.url, headers: req.headers },
      (ures) => {
        res.writeHead(ures.statusCode!, ures.headers);
        if (f && "truncateResponseAt" in f) {
          let sent = 0;
          ures.on("data", (c: Buffer) => {
            if (sent >= f.truncateResponseAt) return;
            const part = c.subarray(0, f.truncateResponseAt - sent);
            sent += part.length;
            res.write(part);
            if (sent >= f.truncateResponseAt) {
              ures.destroy();
              res.destroy(); // a cut, not a clean end
            }
          });
        } else {
          ures.pipe(res);
        }
      },
    );
    up.on("error", () => res.destroy());
    // A client that gives up mid-body (a source that failed while being sent)
    // must not leave the upstream request waiting for the rest of its length.
    req.on("close", () => {
      if (!req.complete) up.destroy();
    });
    if (f && "resetRequestAfter" in f) {
      let got = 0;
      req.on("data", (c: Buffer) => {
        got += c.length;
        if (got >= f.resetRequestAfter) {
          up.destroy();
          req.socket.destroy();
        } else up.write(c);
      });
    } else {
      req.pipe(up);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get seen() {
      return state.seen;
    },
    get inFlight() {
      return state.inFlight;
    },
    get peakInFlight() {
      return state.peak;
    },
    add: (r) => void rules.push({ ...r, left: r.times ?? 1 }),
    clearRules: () => void (rules.length = 0),
    reset: () => {
      state.seen = [];
      state.peak = state.inFlight;
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  } as S3Proxy;
}
