// storeOrigin(): the one origin the dashboard's CSP names for the object store
// (foldrun-web proxy.ts, PR #15). It must be exactly where the presigned URLs
// go — path-style or virtual-hosted, AWS, R2 or MinIO with a port — only when
// S3 is the driver in force, and never anything that is not a plain http(s) host.
//
//   node --test tests/storage-origin.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { storeOrigin, driverFor } from "../src/storage.ts";

const KEYS = {
  FOLDRUN_STORAGE_DRIVER: "s3",
  FOLDRUN_S3_BUCKET: "foldrun-files-123",
  FOLDRUN_S3_ACCESS_KEY_ID: "AKIATEST",
  FOLDRUN_S3_SECRET_ACCESS_KEY: "secret-test",
};

const VARS = ["FOLDRUN_STORAGE_DRIVER", "FOLDRUN_S3_ENDPOINT", "FOLDRUN_S3_BUCKET", "FOLDRUN_S3_ACCESS_KEY_ID",
  "FOLDRUN_S3_SECRET_ACCESS_KEY", "FOLDRUN_S3_PATH_STYLE", "FOLDRUN_S3_REGION",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];

/** The origins a real presigned PUT and GET go to, under `env` (static keys: no network). */
async function signedOrigins(env: Record<string, string>): Promise<string[]> {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    const d = driverFor("acme", "desk");
    assert.equal(d.kind, "s3");
    const put = new URL((await d.presignPut("k/upload.bin", "application/octet-stream"))!);
    const get = new URL((await d.presignGet("k/clip.mp4", "clip.mp4", "video/mp4", 300, "video/mp4"))!);
    return [put.origin, get.origin];
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

const CASES: Array<[string, Record<string, string>, string]> = [
  ["AWS path-style (the default)", { FOLDRUN_S3_ENDPOINT: "https://s3.eu-north-1.amazonaws.com" }, "https://s3.eu-north-1.amazonaws.com"],
  ["AWS virtual-hosted (prod)", { FOLDRUN_S3_ENDPOINT: "https://s3.eu-north-1.amazonaws.com", FOLDRUN_S3_PATH_STYLE: "false" }, "https://foldrun-files-123.s3.eu-north-1.amazonaws.com"],
  ["R2", { FOLDRUN_S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com/" }, "https://acct123.r2.cloudflarestorage.com"],
  ["MinIO with a port", { FOLDRUN_S3_ENDPOINT: "http://minio.local:9000", FOLDRUN_S3_REGION: "us-east-1" }, "http://minio.local:9000"],
  ["MinIO virtual-hosted with a port", { FOLDRUN_S3_ENDPOINT: "http://minio.local:9000", FOLDRUN_S3_REGION: "us-east-1", FOLDRUN_S3_PATH_STYLE: "false" }, "http://foldrun-files-123.minio.local:9000"],
];

for (const [name, extra, want] of CASES) {
  test(`storeOrigin is where the signed URLs go — ${name}`, async () => {
    const env = { ...KEYS, ...extra };
    assert.equal(storeOrigin(env), want, "the expected origin, stated outright");
    assert.deepEqual(await signedOrigins(env), [want, want], "and where a presigned PUT and GET really go");
  });
}

test("storeOrigin is null unless S3 is the driver in force", () => {
  const base = { ...KEYS, FOLDRUN_S3_ENDPOINT: "https://s3.eu-north-1.amazonaws.com" };
  assert.equal(storeOrigin({ ...base, FOLDRUN_STORAGE_DRIVER: "fs" }), null, "fs selected");
  assert.equal(storeOrigin({ ...base, FOLDRUN_STORAGE_DRIVER: undefined }), null, "nothing selected");
  assert.equal(storeOrigin({ ...base, FOLDRUN_S3_BUCKET: undefined }), null, "no bucket");
  assert.equal(storeOrigin({ ...base, FOLDRUN_S3_SECRET_ACCESS_KEY: undefined }), null, "half a key and no role: driverFor falls back to fs");
  assert.equal(
    storeOrigin({ ...base, FOLDRUN_S3_ACCESS_KEY_ID: undefined, FOLDRUN_S3_SECRET_ACCESS_KEY: undefined, AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials" }),
    "https://s3.eu-north-1.amazonaws.com",
    "a pod role counts as configured, with no credential fetched",
  );
});

test("storeOrigin refuses anything that is not a plain http(s) host", () => {
  for (const endpoint of ["not a url", "data:text/plain,x", "file:///etc/passwd", "javascript:alert(1)", "https://*.example.com", "ftp://store.example.com"]) {
    assert.equal(storeOrigin({ ...KEYS, FOLDRUN_S3_ENDPOINT: endpoint }), null, endpoint);
  }
  assert.equal(storeOrigin({ ...KEYS, FOLDRUN_S3_ENDPOINT: "https://s3.example.com:9443/some/path?x=1" }), "https://s3.example.com:9443", "only the origin, never a path or query");
});
