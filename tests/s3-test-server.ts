// A real S3-compatible endpoint for tests (FOL-126 s3 driver), offered by the
// environment and skipped cleanly when it is not:
//
//   FOLDRUN_TEST_S3_URL         http://127.0.0.1:19000   (MinIO, loopback only)
//   FOLDRUN_TEST_S3_ACCESS_KEY  throwaway key
//   FOLDRUN_TEST_S3_SECRET_KEY  throwaway secret
//   FOLDRUN_TEST_S3_REGION      optional, default us-east-1
//
// Never point this at AWS or any account you care about: every test creates a
// bucket of its own and DELETES everything in it afterwards.

import crypto from "node:crypto";
import { s3Request, type S3Config } from "../src/storage.ts";

export interface RealS3 {
  endpoint: string;
  region: string;
  /** A fresh empty bucket; `drop()` empties and removes it. */
  newBucket(): Promise<{ bucket: string; cfg: S3Config; drop(): Promise<void> }>;
}

/** Null when no endpoint is offered — the caller skips. */
export function realS3(env: NodeJS.ProcessEnv = process.env): RealS3 | null {
  const endpoint = env.FOLDRUN_TEST_S3_URL;
  const accessKeyId = env.FOLDRUN_TEST_S3_ACCESS_KEY;
  const secretAccessKey = env.FOLDRUN_TEST_S3_SECRET_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  // A guard against pointing the suite at a real cloud: it deletes buckets.
  const host = new URL(endpoint).hostname;
  if (!/^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/.test(host) && env.FOLDRUN_TEST_S3_ALLOW_REMOTE !== "1") {
    throw new Error(`FOLDRUN_TEST_S3_URL is ${host}, not loopback; these tests create and delete buckets. Set FOLDRUN_TEST_S3_ALLOW_REMOTE=1 if you mean it.`);
  }
  const region = env.FOLDRUN_TEST_S3_REGION ?? "us-east-1";
  const base = { endpoint: endpoint.replace(/\/+$/, ""), region, accessKeyId, secretAccessKey, pathStyle: true };
  return {
    endpoint: base.endpoint,
    region,
    async newBucket() {
      const bucket = `fr-test-${crypto.randomBytes(6).toString("hex")}`;
      const cfg: S3Config = { ...base, bucket };
      const made = await s3Request(cfg, "PUT", "", undefined, undefined, {}, AbortSignal.timeout(10_000));
      if (!made.ok) throw new Error(`could not create test bucket: ${made.status} ${(await made.text()).slice(0, 200)}`);
      await made.arrayBuffer().catch(() => {});
      return { bucket, cfg, drop: () => dropBucket(cfg) };
    },
  };
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Abort every in-flight multipart upload, delete every object, delete the bucket. */
async function dropBucket(cfg: S3Config): Promise<void> {
  const q = AbortSignal.timeout(30_000);
  for (;;) {
    const res = await s3Request(cfg, "GET", "", undefined, undefined, {}, q, { query: { "list-type": "2", "max-keys": "500" } });
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unxml(m[1]));
    if (!keys.length) break;
    for (const k of keys) await (await s3Request(cfg, "DELETE", k, undefined, undefined, {}, q)).arrayBuffer().catch(() => {});
  }
  const ups = await (await s3Request(cfg, "GET", "", undefined, undefined, {}, q, { query: { uploads: "" } })).text();
  for (const m of ups.matchAll(/<Upload>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<UploadId>([^<]*)<\/UploadId>[\s\S]*?<\/Upload>/g)) {
    await (await s3Request(cfg, "DELETE", unxml(m[1]), undefined, undefined, {}, q, { query: { uploadId: unxml(m[2]) } })).arrayBuffer().catch(() => {});
  }
  await (await s3Request(cfg, "DELETE", "", undefined, undefined, {}, q)).arrayBuffer().catch(() => {});
}

/** In-flight multipart uploads under a prefix, for assertions. */
export async function openUploads(cfg: S3Config, prefix = ""): Promise<{ key: string; uploadId: string }[]> {
  const xml = await (await s3Request(cfg, "GET", "", undefined, undefined, {}, AbortSignal.timeout(10_000), { query: { uploads: "", ...(prefix ? { prefix } : {}) } })).text();
  return [...xml.matchAll(/<Upload>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<UploadId>([^<]*)<\/UploadId>[\s\S]*?<\/Upload>/g)].map((m) => ({ key: unxml(m[1]), uploadId: unxml(m[2]) }));
}
