// An in-process stand-in for an S3-compatible endpoint: just enough of the
// protocol for BlobStore — path-style PUT / GET (with Range) / HEAD / DELETE,
// `If-None-Match: *` answered 412, Last-Modified — plus fault injection.
// It does not check SigV4 (storage.test.ts proves the signature against AWS's
// published vector) and it is strongly consistent, which real S3 now is too.
// No dependency: node:http.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  endpoint: string;
  objects: Map<string, { body: Buffer; modifiedAt: Date }>;
  requests: { method: string; key: string; headers: http.IncomingHttpHeaders }[];
  /** Answer the next `n` requests with `status` (e.g. 503) before behaving. */
  failNext(n: number, status: number): void;
  /** Hold every response this long. */
  delay(ms: number): void;
  close(): Promise<void>;
}

export async function fakeS3(bucket = "test-bucket"): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; modifiedAt: Date }>();
  const requests: FakeS3["requests"] = [];
  let failures = 0;
  let failStatus = 503;
  let holdMs = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url!, "http://x");
      const prefix = `/${bucket}/`;
      const key = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname);
      requests.push({ method: req.method!, key, headers: req.headers });
      if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
      if (failures > 0) {
        failures--;
        res.writeHead(failStatus).end("<Error><Code>InjectedFailure</Code></Error>");
        return;
      }
      const body = Buffer.concat(chunks);
      switch (req.method) {
        case "PUT": {
          if (req.headers["if-none-match"] === "*" && objects.has(key)) {
            res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
            return;
          }
          objects.set(key, { body, modifiedAt: new Date() });
          res.writeHead(200).end();
          return;
        }
        case "GET":
        case "HEAD": {
          if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
            const prefix = url.searchParams.get("prefix") ?? "";
            const delimiter = url.searchParams.get("delimiter");
            const after = url.searchParams.get("continuation-token");
            const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
            const prefixes = new Set<string>();
            const direct: string[] = [];
            for (const k of keys) {
              const rest = k.slice(prefix.length);
              if (delimiter && rest.includes(delimiter)) prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
              else direct.push(k);
            }
            const PAGE = 2; // small, so a test crosses a page boundary
            const start = after ? direct.findIndex((k) => k > after) : 0;
            const page = start < 0 ? [] : direct.slice(start, start + PAGE);
            const more = start >= 0 && start + PAGE < direct.length;
            const xml =
              `<ListBucketResult><IsTruncated>${more}</IsTruncated>` +
              (more ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : "") +
              page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size><LastModified>${objects.get(k)!.modifiedAt.toISOString()}</LastModified></Contents>`).join("") +
              [...prefixes].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") +
              `</ListBucketResult>`;
            res.writeHead(200, { "content-type": "application/xml" }).end(xml);
            return;
          }
          const o = objects.get(key);
          if (!o) {
            res.writeHead(404).end(req.method === "GET" ? "<Error><Code>NoSuchKey</Code></Error>" : undefined);
            return;
          }
          const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
          const slice = range ? o.body.subarray(Number(range[1]), Number(range[2]) + 1) : o.body;
          res.writeHead(range ? 206 : 200, { "content-length": slice.length, "last-modified": o.modifiedAt.toUTCString() });
          res.end(req.method === "GET" ? slice : undefined);
          return;
        }
        case "DELETE": {
          objects.delete(key);
          res.writeHead(204).end();
          return;
        }
        default:
          res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    failNext(n, status) {
      failures = n;
      failStatus = status;
    },
    delay(ms) {
      holdMs = ms;
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  };
}
