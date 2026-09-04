// Public links to workspace files.
//
// A share is the one thing here reachable without a credential, so most of
// these tests are about what it must refuse.
//
//   node --test tests/shares.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createShare,
  resolveShare,
  revokeShare,
  listShares,
  pruneShares,
  assertShareablePath,
  contentTypeFor,
  isLive,
  shareUrl,
  syncPublicShares,
} from "../packages/core/src/shares.ts";

/** A throwaway FOLDRUN_DATA holding one workspace with one file in storage/. */
function inTempData<T>(fn: (root: string, ws: string) => T): T {
  const previous = process.env.FOLDRUN_DATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-share-test-"));
  process.env.FOLDRUN_DATA = root;
  const ws = path.join(root, "acct", "workspaces", "desk");
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.writeFileSync(path.join(ws, "storage", "cover.jpg"), "JPEGBYTES");
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "memory", "notes.md"), "what the desk knows");
  try {
    return fn(root, ws);
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a share resolves to the bytes on disk", () => {
  inTempData(() => {
    const share = createShare("acct", "desk", "storage/cover.jpg");
    const hit = resolveShare(share.token);
    assert.ok(hit, "the token just minted must resolve");
    assert.equal(fs.readFileSync(hit!.file, "utf8"), "JPEGBYTES");
    assert.equal(hit!.share.contentType, "image/jpeg");
  });
});

test("the token is long and random, never derived from the file", () => {
  inTempData(() => {
    const a = createShare("acct", "desk", "storage/cover.jpg");
    const b = createShare("acct", "desk", "storage/cover.jpg");
    assert.notEqual(a.token, b.token, "the same file twice must not mint the same link");
    assert.ok(a.token.length >= 32, `token too short to be a credential: ${a.token.length}`);
    assert.doesNotMatch(a.token, /cover/, "a token derived from the path is a guessable share");
  });
});

// The allowlist is the security boundary. Everything an agent could be talked
// into naming has to fail here, not at the route.
test("only produced content can be shared — never how the workspace thinks", () => {
  for (const rel of [
    "memory/notes.md",
    "agents/writer/agent.md",
    "tools/post-image/tool.md",
    "knowledge/pricing.md",
    "state/cursor.md",
    "AGENTS.md",
  ]) {
    assert.throws(() => assertShareablePath(rel), /not a shareable path/, rel);
  }
  for (const rel of ["storage/cover.jpg", "files/report.pdf", "outputs/run-1/out.csv"]) {
    assert.equal(assertShareablePath(rel), rel);
  }
});

test("traversal cannot climb out of the workspace", () => {
  for (const rel of [
    "storage/../../../etc/passwd",
    "storage/../memory/notes.md",
    "/etc/passwd",
    "../keys.json",
  ]) {
    assert.throws(() => assertShareablePath(rel), /illegal path|not a shareable path/, rel);
  }
});

test("a hand-edited manifest still fails closed", () => {
  inTempData((root) => {
    const share = createShare("acct", "desk", "storage/cover.jpg");
    // Someone (or something) rewrites the entry to point at a secret.
    const file = path.join(root, "shares.json");
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    all[0].path = "memory/notes.md";
    fs.writeFileSync(file, JSON.stringify(all));
    assert.equal(
      resolveShare(share.token),
      null,
      "the path rule must be enforced on read, not only when the share was made",
    );
  });
});

test("an expired link stops working, and a revoked one cannot come back", () => {
  inTempData(() => {
    const expired = createShare("acct", "desk", "storage/cover.jpg", { ttlDays: -1 });
    assert.equal(resolveShare(expired.token), null, "past its expiry");

    const live = createShare("acct", "desk", "storage/cover.jpg");
    assert.ok(resolveShare(live.token));
    assert.equal(revokeShare("acct", live.token), true);
    assert.equal(resolveShare(live.token), null, "revoked");
    assert.equal(revokeShare("acct", live.token), false, "revoking twice is not a second event");
  });
});

test("one account cannot revoke another's link", () => {
  inTempData(() => {
    const share = createShare("acct", "desk", "storage/cover.jpg");
    assert.equal(revokeShare("someone-else", share.token), false);
    assert.ok(resolveShare(share.token), "still live — the other account's call did nothing");
  });
});

test("a link to a file that has since been deleted resolves to nothing", () => {
  inTempData((_root, ws) => {
    const share = createShare("acct", "desk", "storage/cover.jpg");
    fs.rmSync(path.join(ws, "storage", "cover.jpg"));
    assert.equal(resolveShare(share.token), null);
  });
});

test("sharing a file that does not exist is refused at creation", () => {
  inTempData(() => {
    assert.throws(() => createShare("acct", "desk", "storage/nope.jpg"), /file not found/);
  });
});

test("an unknown token is null, and so is an empty one", () => {
  inTempData(() => {
    assert.equal(resolveShare("not-a-real-token"), null);
    assert.equal(resolveShare(""), null);
  });
});

test("listing is per account, newest first", () => {
  inTempData((root) => {
    const theirs = path.join(root, "other", "workspaces", "desk", "storage");
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, "cover.jpg"), "THEIRS");

    createShare("acct", "desk", "storage/cover.jpg");
    createShare("other", "desk", "storage/cover.jpg");
    const mine = listShares("acct");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].tenant, "acct");
  });
});

test("pruning drops long-dead entries and keeps live ones", () => {
  inTempData(() => {
    createShare("acct", "desk", "storage/cover.jpg", { ttlDays: -90 });
    const live = createShare("acct", "desk", "storage/cover.jpg");
    assert.equal(pruneShares(30), 1);
    assert.ok(resolveShare(live.token), "the live one survives the prune");
  });
});

// An SVG is a document that can carry script, and shares are served from our
// own origin to anyone with the link.
test("svg and markdown are served as text, never as themselves", () => {
  assert.equal(contentTypeFor("storage/x.svg"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("storage/x.md"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("storage/x.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("storage/x.unknown"), "application/octet-stream");
});

test("a link that never expires has to be asked for", () => {
  inTempData(() => {
    const def = createShare("acct", "desk", "storage/cover.jpg");
    assert.ok(def.expiresAt, "the default must expire");
    const forever = createShare("acct", "desk", "storage/cover.jpg", { ttlDays: null });
    assert.equal(forever.expiresAt, null);
    assert.ok(isLive(forever));
  });
});

// A share whose URL says localhost is worse than an error: it gets pasted
// somewhere and fails for everyone except the person who made it.
test("a share URL refuses to be built without a public origin", () => {
  const previous = process.env.FOLDRUN_PUBLIC_URL;
  try {
    delete process.env.FOLDRUN_PUBLIC_URL;
    assert.throws(() => shareUrl("abc"), /FOLDRUN_PUBLIC_URL/);
    process.env.FOLDRUN_PUBLIC_URL = "https://app.example.com/";
    assert.equal(shareUrl("abc"), "https://app.example.com/s/abc");
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_PUBLIC_URL;
    else process.env.FOLDRUN_PUBLIC_URL = previous;
  }
});

// storage/public/ — the platform mints these, because the agent cannot.
//
// A run's sandbox is denied every private network range on purpose, so a step
// has no route to this platform's API and no way to ask for a URL. Handing
// sandboxes an API key to fix that would give every step editor rights over
// the whole account. Instead the platform publishes the directory after the
// step, and the next step reads a plain JSON file with no network at all.
test("everything in storage/public/ gets a link, written where the next step can read it", () => {
  const previous = process.env.FOLDRUN_PUBLIC_URL;
  process.env.FOLDRUN_PUBLIC_URL = "https://example.test";
  try {
    inTempData((root, ws) => {
      fs.mkdirSync(path.join(ws, "storage", "public", "gbp"), { recursive: true });
      fs.writeFileSync(path.join(ws, "storage", "public", "gbp", "nsw.jpg"), "IMG");

      const first = syncPublicShares("acct", "desk");
      assert.deepEqual(first.added, ["storage/public/gbp/nsw.jpg"]);
      const url = first.urls["storage/public/gbp/nsw.jpg"];
      assert.match(url, /^https:\/\/example\.test\/s\/.+/);

      const manifest = path.join(ws, "storage", "public-urls.json");
      assert.ok(fs.existsSync(manifest), "the next step reads this, so it must exist");
      assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8"))["storage/public/gbp/nsw.jpg"], url);

      // The index of what is public must not itself be inside the public dir.
      assert.ok(
        !fs.existsSync(path.join(ws, "storage", "public", "public-urls.json")),
        "the manifest would otherwise publish the list of every public file",
      );

      // Running again is not a second publish — the URL has to be stable, or a
      // link handed out on one step stops matching on the next.
      const second = syncPublicShares("acct", "desk");
      assert.deepEqual(second.added, [], "already shared");
      assert.equal(second.urls["storage/public/gbp/nsw.jpg"], url, "the URL must not churn");
    });
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_PUBLIC_URL;
    else process.env.FOLDRUN_PUBLIC_URL = previous;
  }
});

test("auto-shared links do not expire — a public asset URL that dies is a silent breakage", () => {
  const previous = process.env.FOLDRUN_PUBLIC_URL;
  process.env.FOLDRUN_PUBLIC_URL = "https://example.test";
  try {
    inTempData((_root, ws) => {
      fs.mkdirSync(path.join(ws, "storage", "public"), { recursive: true });
      fs.writeFileSync(path.join(ws, "storage", "public", "a.jpg"), "IMG");
      syncPublicShares("acct", "desk");
      const share = listShares("acct", "desk").find((s) => s.path === "storage/public/a.jpg");
      assert.ok(share);
      assert.equal(share!.expiresAt, null);
    });
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_PUBLIC_URL;
    else process.env.FOLDRUN_PUBLIC_URL = previous;
  }
});

test("with no public origin nothing is minted and no manifest is written", () => {
  const previous = process.env.FOLDRUN_PUBLIC_URL;
  delete process.env.FOLDRUN_PUBLIC_URL;
  try {
    inTempData((_root, ws) => {
      fs.mkdirSync(path.join(ws, "storage", "public"), { recursive: true });
      fs.writeFileSync(path.join(ws, "storage", "public", "a.jpg"), "IMG");
      assert.deepEqual(syncPublicShares("acct", "desk"), { added: [], urls: {} });
      assert.ok(
        !fs.existsSync(path.join(ws, "storage", "public-urls.json")),
        "a manifest of links that resolve nowhere is worse than none",
      );
    });
  } finally {
    if (previous !== undefined) process.env.FOLDRUN_PUBLIC_URL = previous;
  }
});
