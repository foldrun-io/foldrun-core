// The file store: the index, the drivers, the run mirror, and the one thing
// that cannot be checked by reading the code — that the SigV4 signature this
// module produces is the signature S3 expects.
//
//   node --test tests/files.test.ts
//
// Nothing here talks to a network. The s3 driver is exercised through its
// signing, which is pure; the rest runs on the fs driver, which is what a
// self-hoster and the CLI get anyway.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  assertFilePath,
  putFile,
  listStorage,
  getFile,
  deleteFile,
  usedBytes,
  readFileBytes,
  materializeFiles,
  harvestFiles,
  blobPath,
  mimeFor,
} from "../packages/core/src/storage.ts";
import { workspaceDir, isPlatformPath, saveWorkspace, adoptLegacyFilesDir } from "../packages/core/src/store.ts";

let root: string;
const TENANT = "default";
const WS = "demo";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-files-"));
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_STORAGE_DRIVER;
  fs.mkdirSync(path.join(workspaceDir(TENANT, WS), "agents"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FOLDRUN_DATA;
});

// ---------- paths ----------

test("a file path cannot escape the store", () => {
  for (const bad of [
    "../secrets.json",
    "/etc/passwd",
    "a/../../b",
    "C:\\windows\\system32",
    "",
    "with\u0000null",
  ]) {
    assert.throws(() => assertFilePath(bad), /illegal file path/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(assertFilePath("reports/q3.pdf"), "reports/q3.pdf");
  // Backslashes are a separator on the way in, not a literal in a name.
  assert.equal(assertFilePath("reports\\q3.pdf"), "reports/q3.pdf");
  assert.equal(assertFilePath("./a.csv"), "a.csv");
});

// ---------- the index ----------

test("a file round-trips, and identical bytes store one blob", async () => {
  const bytes = Buffer.from("name,email\nada,ada@example.com\n");
  const first = await putFile(TENANT, WS, "leads.csv", bytes, "user:you@example.com");
  const second = await putFile(TENANT, WS, "copy-of-leads.csv", bytes, "user:you@example.com");

  assert.equal(first.sha, second.sha, "same bytes hashed differently");
  assert.equal(first.mime, "text/csv");
  assert.equal(listStorage(TENANT, WS).length, 2);
  // Two records, one blob — and the quota counts the blob once.
  assert.equal(usedBytes(TENANT, WS), bytes.length);
  assert.deepEqual(await readFileBytes(TENANT, WS, "copy-of-leads.csv"), bytes);
});

test("deleting the last record naming a blob removes the blob", async () => {
  const bytes = Buffer.from("one");
  const rec = await putFile(TENANT, WS, "a.txt", bytes, "user:me");
  await putFile(TENANT, WS, "b.txt", bytes, "user:me");
  const blob = blobPath(TENANT, WS, rec.sha);

  assert.ok(fs.existsSync(blob));
  await deleteFile(TENANT, WS, "a.txt");
  assert.ok(fs.existsSync(blob), "a blob still named by another record was collected");
  await deleteFile(TENANT, WS, "b.txt");
  assert.ok(!fs.existsSync(blob), "the last record went and the blob stayed");
  assert.equal(usedBytes(TENANT, WS), 0);
});

test("re-writing a name replaces the record and keeps one entry", async () => {
  await putFile(TENANT, WS, "report.md", Buffer.from("draft"), "user:me");
  await putFile(TENANT, WS, "report.md", Buffer.from("final"), "run:run-xyz");

  const files = listStorage(TENANT, WS);
  assert.equal(files.length, 1);
  assert.equal(files[0].by, "run:run-xyz");
  assert.equal((await readFileBytes(TENANT, WS, "report.md"))?.toString(), "final");
});

test("the per-object limit is enforced", async () => {
  process.env.FOLDRUN_STORAGE_MAX_MB = "0.001"; // 1 KB
  await assert.rejects(
    putFile(TENANT, WS, "big.bin", Buffer.alloc(4096), "user:me"),
    /the limit is/,
  );
  delete process.env.FOLDRUN_STORAGE_MAX_MB;
});

test("the workspace quota is enforced", async () => {
  process.env.FOLDRUN_STORAGE_QUOTA_MB = "0.001"; // 1 KB
  await putFile(TENANT, WS, "a.bin", Buffer.alloc(600), "user:me");
  await assert.rejects(
    putFile(TENANT, WS, "b.bin", Buffer.alloc(600), "user:me"),
    /quota exceeded/,
  );
  delete process.env.FOLDRUN_STORAGE_QUOTA_MB;
});

// ---------- the run mirror ----------

test("files are mirrored into the workspace for a run, and cost no extra bytes", async () => {
  const bytes = Buffer.from("a price list");
  const rec = await putFile(TENANT, WS, "prices/2026.txt", bytes, "user:me");
  const brought = await materializeFiles(TENANT, WS);

  const mirrored = path.join(workspaceDir(TENANT, WS), "storage", "prices/2026.txt");
  assert.deepEqual(brought, ["prices/2026.txt"]);
  assert.deepEqual(fs.readFileSync(mirrored), bytes);
  // Hardlinked, not copied: the mirror and the blob are one inode, so a large
  // corpus does not double on the disk holding every other workspace.
  assert.equal(
    fs.statSync(mirrored).ino,
    fs.statSync(blobPath(TENANT, WS, rec.sha)).ino,
    "the mirror copied the bytes instead of linking them",
  );

  // A second run brings nothing new in.
  assert.deepEqual(await materializeFiles(TENANT, WS), []);
});

test("what a run leaves in storage/ is harvested, stamped with the run", async () => {
  const dir = path.join(workspaceDir(TENANT, WS), "storage");
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "report.pdf"), "%PDF-1.4 pretend");

  const { saved, errors } = await harvestFiles(TENANT, WS, "run:run-abc");
  assert.deepEqual(errors, []);
  assert.deepEqual(saved, ["out/report.pdf"]);

  const rec = getFile(TENANT, WS, "out/report.pdf");
  assert.equal(rec?.by, "run:run-abc");
  assert.equal(rec?.mime, "application/pdf");

  // Harvesting again saves nothing — the index already describes it, so a
  // run that touched no files does not rewrite every record it can see.
  assert.deepEqual((await harvestFiles(TENANT, WS, "run:run-def")).saved, []);
  assert.equal(getFile(TENANT, WS, "out/report.pdf")?.by, "run:run-abc");
});

test("a run that changes a mirrored file is harvested as a new version", async () => {
  await putFile(TENANT, WS, "notes.txt", Buffer.from("before"), "user:me");
  await materializeFiles(TENANT, WS);

  const mirrored = path.join(workspaceDir(TENANT, WS), "storage", "notes.txt");
  // rm-then-write, the way a container copy-out applies changes — writing
  // through the hardlink would edit the blob itself.
  fs.rmSync(mirrored);
  fs.writeFileSync(mirrored, "after and longer");

  assert.deepEqual((await harvestFiles(TENANT, WS, "run:run-1")).saved, ["notes.txt"]);
  assert.equal((await readFileBytes(TENANT, WS, "notes.txt"))?.toString(), "after and longer");
});

// ---------- keeping bytes out of the source tree ----------

test("storage/ is not source: a deploy cannot ship one, and does not delete one", async () => {
  await putFile(TENANT, WS, "keep.txt", Buffer.from("survive the deploy"), "user:me");
  await materializeFiles(TENANT, WS);

  assert.throws(
    () => saveWorkspace(TENANT, WS, [{ path: "storage/sneaky.png", content: "binary-ish" }]),
    /unexpected file/,
    "a deploy carried a blob into the source tree",
  );

  saveWorkspace(TENANT, WS, [
    { path: "AGENTS.md", content: "# demo\n" },
    { path: "agents/writer/agent.md", content: "---\nmodel: sonnet\n---\n\nWrite.\n" },
  ]);

  assert.ok(
    fs.existsSync(path.join(workspaceDir(TENANT, WS), "storage", "keep.txt")),
    "a deploy wiped the file mirror",
  );
  assert.equal(getFile(TENANT, WS, "keep.txt")?.size, 18);
});

test("a run may carry storage/ across the container boundary", async () => {
  // The copy-in filter drops platform-owned paths. storage/ must not be one, or
  // the mirror would never reach the pod that is supposed to read it.
  assert.equal(isPlatformPath("storage/prices.csv"), false);
  assert.equal(isPlatformPath("runs/run-1/x"), true);
});

// ---------- signing ----------

test("SigV4 matches AWS's published test vector", () => {
  // aws-sig-v4-test-suite / get-vanilla, restated as the signing this module
  // does. If this drifts, every presigned URL is rejected by the bucket with
  // a message that names nothing useful — so the vector is the test.
  const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  const dateStamp = "20150830";
  const region = "us-east-1";

  const hmac = (key: crypto.BinaryLike, data: string) =>
    crypto.createHmac("sha256", key).update(data, "utf8").digest();
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "service");
  const signing = hmac(kService, "aws4_request");

  const canonicalRequest = [
    "GET",
    "/",
    "",
    "host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
    "host;x-amz-date",
    crypto.createHash("sha256").update("").digest("hex"),
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20150830T123600Z",
    "20150830/us-east-1/service/aws4_request",
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  assert.equal(
    hmac(signing, stringToSign).toString("hex"),
    "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("a presigned GET is signed as an attachment, and expires", async () => {
  process.env.FOLDRUN_STORAGE_DRIVER = "s3";
  process.env.FOLDRUN_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.FOLDRUN_S3_BUCKET = "foldrun-files";
  process.env.FOLDRUN_S3_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  process.env.FOLDRUN_S3_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  try {
    const { downloadUrl } = await import("../packages/core/src/storage.ts");
    const url = (await downloadUrl(TENANT, WS, {
      path: "out/report.html",
      sha: "a".repeat(64),
      size: 10,
      mime: "text/html",
      updatedAt: new Date(0).toISOString(),
      by: "run:run-1",
    }))!;

    const parsed = new URL(url);
    assert.equal(parsed.host, "acct.r2.cloudflarestorage.com");
    assert.equal(parsed.pathname, `/foldrun-files/t/${TENANT}/w/${WS}/blobs/${"a".repeat(64)}`);
    // The one that matters: an agent-written .html can never render as a page.
    assert.match(
      parsed.searchParams.get("response-content-disposition") ?? "",
      /^attachment; filename="report\.html"$/,
    );
    assert.ok(parsed.searchParams.get("X-Amz-Signature"));
    assert.equal(parsed.searchParams.get("X-Amz-Expires"), "300");
    assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "host");
  } finally {
    for (const k of [
      "FOLDRUN_STORAGE_DRIVER",
      "FOLDRUN_S3_ENDPOINT",
      "FOLDRUN_S3_BUCKET",
      "FOLDRUN_S3_ACCESS_KEY_ID",
      "FOLDRUN_S3_SECRET_ACCESS_KEY",
    ]) delete process.env[k];
  }
});

test("a half-configured bucket falls back rather than failing every upload", async () => {
  process.env.FOLDRUN_STORAGE_DRIVER = "s3";
  process.env.FOLDRUN_S3_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  // No bucket, no credentials.
  try {
    const rec = await putFile(TENANT, WS, "still-works.txt", Buffer.from("hi"), "user:me");
    assert.ok(fs.existsSync(blobPath(TENANT, WS, rec.sha)));
  } finally {
    delete process.env.FOLDRUN_STORAGE_DRIVER;
    delete process.env.FOLDRUN_S3_ENDPOINT;
  }
});

test("mime comes from the extension, and defaults to bytes", () => {
  assert.equal(mimeFor("a/b/c.PDF"), "application/pdf");
  assert.equal(mimeFor("data.csv"), "text/csv");
  assert.equal(mimeFor("mystery"), "application/octet-stream");
});

// The rename: files/ became storage/. An install created before it has bytes
// under the old name, and a workspace whose files vanished on upgrade is a
// data-loss bug however cosmetic the cause. adoptLegacyFilesDir moves one
// across, in place, the first time either root is resolved.
test("a pre-rename files/ directory is adopted as storage/", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-adopt-"));
  const legacy = path.join(root, "files");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "prices.csv"), "a,b\n1,2\n");

  adoptLegacyFilesDir(root);

  assert.ok(fs.existsSync(path.join(root, "storage", "prices.csv")), "content moved across");
  assert.equal(fs.existsSync(legacy), false, "the old directory is gone, not duplicated");
  assert.equal(fs.readFileSync(path.join(root, "storage", "prices.csv"), "utf8"), "a,b\n1,2\n");
  fs.rmSync(root, { recursive: true, force: true });
});

test("adoption never overwrites an existing storage/, and is a no-op when there is nothing to move", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-adopt2-"));
  fs.mkdirSync(path.join(root, "storage"), { recursive: true });
  fs.writeFileSync(path.join(root, "storage", "keep.txt"), "current");
  fs.mkdirSync(path.join(root, "files"), { recursive: true });
  fs.writeFileSync(path.join(root, "files", "old.txt"), "legacy");

  adoptLegacyFilesDir(root);

  assert.equal(fs.readFileSync(path.join(root, "storage", "keep.txt"), "utf8"), "current");
  assert.equal(fs.existsSync(path.join(root, "storage", "old.txt")), false, "no merge — current wins");

  // And a fresh install, with neither directory, must not throw.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-adopt3-"));
  adoptLegacyFilesDir(fresh);
  assert.equal(fs.existsSync(path.join(fresh, "storage")), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
});

test("a mirror the same size as the record is re-fetched when its bytes differ", async () => {
  // A date bumped by one day is the same length as the date before it. The
  // mirror check used to trust size alone, so an upload like that never
  // reached the pod — and the harvest then wrote the stale copy back over it.
  await putFile(TENANT, WS, "draft/post.md", Buffer.from("lastUpdated: 2026-08-31"), "user:me");
  await materializeFiles(TENANT, WS);
  await putFile(TENANT, WS, "draft/post.md", Buffer.from("lastUpdated: 2026-09-01"), "api-key");
  const brought = await materializeFiles(TENANT, WS);
  assert.deepEqual(brought, ["draft/post.md"]);
  assert.equal(
    fs.readFileSync(path.join(workspaceDir(TENANT, WS), "storage", "draft/post.md"), "utf8"),
    "lastUpdated: 2026-09-01",
  );
  // And an unchanged mirror still costs nothing.
  assert.deepEqual(await materializeFiles(TENANT, WS), []);
});
