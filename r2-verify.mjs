#!/usr/bin/env node
// Prove the R2 credential works, through the same code a run uses.
//
// The unit tests check the signing against AWS's published vector, which
// catches a broken signature but not a wrong endpoint, a bucket that does not
// exist, a token scoped to the wrong resource, or path-style addressing that
// this particular provider rejects. Only a real round trip catches those, and
// finding out during a customer's run is the expensive way.
//
//   ./scripts/r2-verify.mjs            # reads infra/production/production.env
//   CF_ENV=/etc/foldrun/env ./scripts/r2-verify.mjs
//
// Writes one object, reads it back, checks the presigned URL an actual browser
// would follow, then deletes it. Leaves nothing behind.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.join(import.meta.dirname, "..");
const envFile = process.env.CF_ENV ?? path.join(root, "infra/production/production.env");

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} else if (!process.env.FOLDRUN_S3_BUCKET) {
  console.error(`no ${envFile} and no FOLDRUN_S3_* in the environment — run scripts/r2-setup.sh first`);
  process.exit(1);
}

// A scratch tenant/workspace, so nothing here can collide with real data.
process.env.FOLDRUN_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "r2-verify-"));
process.env.FOLDRUN_STORAGE_DRIVER = "s3";

const { s3Config, driverFor, blobKey } = await import("../packages/core/src/storage.ts");

const cfg = s3Config();
if (!cfg) {
  console.error("FOLDRUN_S3_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY are not all set");
  process.exit(1);
}
console.log(`endpoint  ${cfg.endpoint}`);
console.log(`bucket    ${cfg.bucket}  (${cfg.pathStyle ? "path" : "virtual-host"} style, region ${cfg.region})`);

const driver = driverFor("default", "verify");
if (driver.kind !== "s3") {
  console.error("the driver resolved to fs — check FOLDRUN_STORAGE_DRIVER and the four S3 values");
  process.exit(1);
}

const body = Buffer.from(`foldrun r2 check ${crypto.randomUUID()}\n`);
const sha = crypto.createHash("sha256").update(body).digest("hex");
const key = blobKey("default", "verify", sha);

const step = async (label, fn) => {
  process.stdout.write(`  ${label.padEnd(34, ".")} `);
  try {
    const note = await fn();
    console.log(`ok${note ? ` — ${note}` : ""}`);
  } catch (err) {
    console.log("FAILED");
    console.error(`\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
};

console.log("");
await step("PUT an object", () => driver.put(key, body, "text/plain"));

await step("GET it back", async () => {
  const got = await driver.get(key);
  if (!got.equals(body)) throw new Error("the bytes came back different");
  return `${got.length} bytes`;
});

await step("HEAD says it is there", async () => {
  if (!(await driver.has(key))) throw new Error("HEAD said no on an object that exists");
});

await step("a presigned URL works unsigned", async () => {
  // The real test of the download path: fetch with no credentials at all,
  // exactly as a browser following the link would.
  const url = await driver.presignGet(key, "check.txt", "text/plain", 120);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`presigned GET returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const disposition = res.headers.get("content-disposition") ?? "";
  if (!disposition.startsWith("attachment")) {
    throw new Error(`served as "${disposition}" — an agent-written .html would render as a page`);
  }
  if (!Buffer.from(await res.arrayBuffer()).equals(body)) throw new Error("presigned GET returned different bytes");
  return "and is served as an attachment";
});

await step("an expired URL is refused", async () => {
  const url = await driver.presignGet(key, "check.txt", "text/plain", 1);
  await new Promise((r) => setTimeout(r, 2000));
  const res = await fetch(url);
  if (res.ok) throw new Error("an expired signature was accepted — links would never stop working");
  return `${res.status}`;
});

await step("DELETE removes it", async () => {
  await driver.remove(key);
  if (await driver.has(key)) throw new Error("still there after delete");
});

fs.rmSync(process.env.FOLDRUN_DATA, { recursive: true, force: true });
console.log("\nR2 is wired up correctly.\n");
