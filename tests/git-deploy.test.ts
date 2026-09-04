// Deploying from a git push: the tarball reader and the signature.
//
// Both are the boundary with something outside the platform, so both are
// tested against real bytes rather than a mock — the tarball is produced by
// `tar` and the signature by the same HMAC GitHub computes.
//
//   node --test tests/git-deploy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { readTarGz, stripRoot, filesFromTarball } from "../packages/core/src/tar.ts";
import { verifySignature, parsePush, gitSecret, fetchTarball } from "../packages/core/src/git.ts";

/** A real tarball, rooted at one directory the way GitHub's are. */
function tarball(files: Record<string, string>, root = "owner-repo-9f2c1ab"): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tar-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const out = path.join(dir, "archive.tar.gz");
    // COPYFILE_DISABLE: macOS tar otherwise writes an AppleDouble `._x` beside
    // every entry, and this test is about the reader, not about macOS.
    const res = spawnSync("tar", ["-czf", out, "-C", dir, root], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    assert.equal(res.status, 0, `tar failed: ${res.stderr}`);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── the tarball ──────────────────────────────────────────────────────────────

test("a real tarball reads back byte for byte", () => {
  const entries = readTarGz(tarball({ "AGENTS.md": "# desk\n", "agents/w/agent.md": "hi\n" }));
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e.content.toString()]));
  assert.equal(byPath["owner-repo-9f2c1ab/AGENTS.md"], "# desk\n");
  assert.equal(byPath["owner-repo-9f2c1ab/agents/w/agent.md"], "hi\n");
});

// Content that is not a multiple of 512 is padded in the archive; reading the
// padding back as content would corrupt every file that isn't exactly aligned.
test("file sizes are exact, not rounded to the block", () => {
  const body = "x".repeat(700); // spans two blocks, fills neither
  const entries = readTarGz(tarball({ "AGENTS.md": body }));
  assert.equal(entries[0].content.toString(), body);
});

test("a long path survives the 100-byte name field", () => {
  const deep = `agents/${"a".repeat(60)}/skills/${"b".repeat(60)}/SKILL.md`;
  const entries = readTarGz(tarball({ [deep]: "deep\n" }));
  assert.ok(
    entries.some((e) => e.path.endsWith(deep)),
    `a long path was mangled: ${entries.map((e) => e.path).join(", ")}`,
  );
});

test("the archive's wrapper directory is stripped", () => {
  const got = stripRoot(readTarGz(tarball({ "AGENTS.md": "x\n", "flows/a.md": "y\n" })));
  assert.deepEqual(got.map((e) => e.path).sort(), ["AGENTS.md", "flows/a.md"]);
});

// A workspace usually lives in a subdirectory of a repo that holds other things.
test("a workspace inside a larger repo can be picked out", () => {
  const gz = tarball({
    "README.md": "the repo\n",
    "desk/AGENTS.md": "the workspace\n",
    "desk/agents/w/agent.md": "hi\n",
    "other/thing.md": "unrelated\n",
  });
  const files = filesFromTarball(gz, "desk");
  assert.deepEqual(files.map((f) => f.path).sort(), ["AGENTS.md", "agents/w/agent.md"]);
  assert.equal(files.find((f) => f.path === "AGENTS.md")?.content, "the workspace\n");
});

// A tarball is untrusted input from whoever controls the repository, and `../`
// in an archive is the oldest way to write outside the destination.
test("an entry that climbs out of the archive is dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-evil-"));
  try {
    // Built by hand: `tar` refuses to create this, which is the point.
    const header = Buffer.alloc(512);
    const name = "root/../../../etc/passwd";
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${(5).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);

    const body = Buffer.alloc(512);
    body.write("owned");
    const gz = zlib.gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));

    assert.deepEqual(filesFromTarball(gz), [], "a climbing path must not become a file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the signature ────────────────────────────────────────────────────────────

const sign = (secret: string, body: string) =>
  `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

test("a correctly signed body is accepted, and nothing else is", () => {
  const secret = "s3cret";
  const body = '{"ref":"refs/heads/main"}';

  assert.equal(verifySignature(secret, body, sign(secret, body)), true);
  assert.equal(verifySignature(secret, body, sign("wrong-secret", body)), false);
  assert.equal(verifySignature(secret, `${body} `, sign(secret, body)), false, "body must match byte for byte");
  assert.equal(verifySignature(secret, body, null), false, "an unsigned request is not authenticated");
  assert.equal(verifySignature(secret, body, "sha256=" + "0".repeat(64)), false);
  assert.equal(verifySignature(secret, body, "garbage"), false, "a short header must not throw");
});

// Every workspace gets its own, so one repository's secret cannot deploy over
// another workspace.
test("the secret is per workspace", () => {
  assert.notEqual(gitSecret("acme", "desk"), gitSecret("acme", "other"));
  assert.notEqual(gitSecret("acme", "desk"), gitSecret("globex", "desk"));
  assert.equal(gitSecret("acme", "desk"), gitSecret("acme", "desk"), "and it is stable");
});

// ── the payload ──────────────────────────────────────────────────────────────

test("a push payload yields the repo, branch and commit", () => {
  const push = parsePush({
    ref: "refs/heads/main",
    after: "9f2c1ab8de00000000000000000000000000abcd",
    repository: { full_name: "owner/repo" },
    head_commit: { message: "fix the flow" },
    pusher: { name: "someone" },
  });
  assert.equal(push?.repo, "owner/repo");
  assert.equal(push?.branch, "main");
  assert.equal(push?.commit, "9f2c1ab8de00000000000000000000000000abcd");
  assert.equal(push?.message, "fix the flow");
});

// Deleting a branch reports all zeros and ships no tree to fetch.
test("a branch deletion is not a deploy", () => {
  assert.equal(
    parsePush({
      ref: "refs/heads/old",
      after: "0".repeat(40),
      repository: { full_name: "owner/repo" },
    }),
    null,
  );
});

test("anything that is not a push payload is refused", () => {
  for (const junk of [null, "a string", {}, { ref: "refs/heads/main" }, { after: "abc" }]) {
    assert.equal(parsePush(junk), null, `accepted ${JSON.stringify(junk)}`);
  }
});

// The repo and commit go straight into a URL. Neither is ours.
test("a repo or commit that could rewrite the URL is refused", async () => {
  for (const repo of ["owner/repo/../../evil", "owner", "../../etc", "owner/repo?x=1"]) {
    await assert.rejects(() => fetchTarball(repo, "9f2c1ab"), /refusing to fetch/, repo);
  }
  for (const commit of ["../../main", "HEAD", "9f2c1ab; rm -rf /", ""]) {
    await assert.rejects(() => fetchTarball("owner/repo", commit), /refusing to fetch/, commit);
  }
});

// ── the whole path ───────────────────────────────────────────────────────────

// Everything a push does except the network call: a real archive in, a live
// workspace out. The two halves are tested apart above; this is the seam,
// which is where a format mismatch would actually bite.
test("a tarball becomes a deployed workspace", async () => {
  const { deployWorkspace, deployedCommit } = await import("../packages/core/src/deploy.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-push-"));
  const previousData = process.env.FOLDRUN_DATA;
  const previousWs = process.env.FOLDRUN_WORKSPACE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_WORKSPACE;
  try {
    const gz = tarball({
      "README.md": "not part of the workspace\n",
      "desk/AGENTS.md": "---\nname: desk\n---\n\nA desk.\n",
      "desk/agents/writer/agent.md": "---\nname: writer\ndescription: writes\n---\n\nWrite.\n",
      "desk/flows/publish.md": "---\nname: publish\ntrigger: manual\n---\n\n1. [[writer]] — write it\n",
      "desk/knowledge/style.md": "---\ntype: Knowledge\ntitle: Style\n---\n\nBe brief.\n",
    });

    const commit = "9f2c1ab8de00000000000000000000000000abcd";
    const out = deployWorkspace("acme", "desk", filesFromTarball(gz, "desk"), { commit });

    assert.deepEqual(out.issues, []);
    assert.equal(out.applied, true);
    assert.equal(deployedCommit("acme", "desk")?.commit, commit);

    const ws = path.join(root, "acme/workspaces/desk");
    assert.ok(fs.existsSync(path.join(ws, "agents/writer/agent.md")));
    assert.ok(!fs.existsSync(path.join(ws, "README.md")), "the repo's own files are not the workspace");
    // A bundle is only a bundle once its index carries okf_version, and a
    // deploy writes straight to disk — so nothing else would generate it.
    assert.match(
      fs.readFileSync(path.join(ws, "knowledge/index.md"), "utf8"),
      /okf_version/,
      "a deployed bundle should be conformant on arrival",
    );
  } finally {
    if (previousData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previousData;
    if (previousWs !== undefined) process.env.FOLDRUN_WORKSPACE = previousWs;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
