// The run-outputs contract (tests/run-outputs-contract.ts) against the pairings
// foldrun-core ships: fs blobs + local records, s3 blobs (an in-process fake
// endpoint) + local records, and — when FOLDRUN_TEST_MINIO_ENDPOINT is set — a
// real MinIO. The database pairing runs in foldrun-platform.
//
//   node --test tests/run-outputs-local.test.ts
//   FOLDRUN_TEST_MINIO_ENDPOINT=http://127.0.0.1:9000 FOLDRUN_TEST_MINIO_BUCKET=foldrun-test \
//   FOLDRUN_TEST_MINIO_KEY=… FOLDRUN_TEST_MINIO_SECRET=… node --test tests/run-outputs-local.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fsBlobStore, s3BlobStore, bounded } from "../src/blob-store.ts";
import { localRunOutputStore } from "../src/run-outputs.ts";
import { s3Config } from "../src/storage.ts";
import { runOutputsContract, type Harness } from "./run-outputs-contract.ts";
import { fakeS3 } from "./fake-s3.ts";

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-roc-"));

runOutputsContract("fs + local", async (): Promise<Harness> => {
  const root = mk();
  return {
    blobs: bounded(fsBlobStore(path.join(root, "objects")), { backoffMs: 1 }),
    store: localRunOutputStore(path.join(root, "records")),
    cleanup: async () => fs.rmSync(root, { recursive: true, force: true }),
  };
});

const S3_ENV = ["FOLDRUN_S3_ENDPOINT", "FOLDRUN_S3_BUCKET", "FOLDRUN_S3_ACCESS_KEY_ID", "FOLDRUN_S3_SECRET_ACCESS_KEY", "FOLDRUN_S3_PATH_STYLE"] as const;

async function withS3Env(env: Record<(typeof S3_ENV)[number], string>, close: () => Promise<void>): Promise<Harness> {
  const saved = Object.fromEntries(S3_ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const root = mk();
  return {
    blobs: bounded(s3BlobStore(s3Config()!), { backoffMs: 1 }),
    store: localRunOutputStore(path.join(root, "records")),
    cleanup: async () => {
      await close();
      for (const k of S3_ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

runOutputsContract("s3(fake) + local", async () => {
  const server = await fakeS3("test-bucket");
  return withS3Env(
    { FOLDRUN_S3_ENDPOINT: server.endpoint, FOLDRUN_S3_BUCKET: "test-bucket", FOLDRUN_S3_ACCESS_KEY_ID: "AKIATEST", FOLDRUN_S3_SECRET_ACCESS_KEY: "secret-test", FOLDRUN_S3_PATH_STYLE: "true" },
    () => server.close(),
  );
});

if (process.env.FOLDRUN_TEST_MINIO_ENDPOINT) {
  // A real S3 API: conditional puts, ranges, listing and delete as a provider does them.
  runOutputsContract("MinIO + local", async () =>
    withS3Env(
      {
        FOLDRUN_S3_ENDPOINT: process.env.FOLDRUN_TEST_MINIO_ENDPOINT!,
        FOLDRUN_S3_BUCKET: process.env.FOLDRUN_TEST_MINIO_BUCKET ?? "foldrun-test",
        FOLDRUN_S3_ACCESS_KEY_ID: process.env.FOLDRUN_TEST_MINIO_KEY ?? "minioadmin",
        FOLDRUN_S3_SECRET_ACCESS_KEY: process.env.FOLDRUN_TEST_MINIO_SECRET ?? "minioadmin",
        FOLDRUN_S3_PATH_STYLE: "true",
      },
      async () => {},
    ),
  );
} else {
  test("run outputs [MinIO + local]: not run (FOLDRUN_TEST_MINIO_ENDPOINT is not set)", { skip: true }, () => assert.ok(true));
}
