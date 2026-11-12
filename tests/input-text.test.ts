// Text beside a run's media inputs (12 Nov 2026, input-text.ts): at staging,
// `<file>.txt` beside each image, PDF, office file, recording or video the
// platform's extractText could read — never over an input or a file already
// there, within one time budget for them all, and never a reason a run fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INPUT_TEXT_LIMITS, mediaKind, mediaKindByName, sniff, textBesideInputs, textCandidates } from "../src/input-text.ts";
import { inputsNote } from "../src/run-inputs.ts";
import type { RunInputFile } from "../src/storage.ts";
import type { ExtractTextAsk } from "../src/platform.ts";
import { platform, registerPlatform, resetPlatform } from "../src/platform.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7\n...");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const MP3 = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(8)]);

/** A staged inputs folder holding these files. */
function staged(files: Record<string, Buffer>): { dir: string; inputs: RunInputFile[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-input-text-"));
  const inputs: RunInputFile[] = [];
  for (const [p, b] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), b);
    inputs.push({ path: p, sha: "s", size: b.length, mime: "application/octet-stream" });
  }
  return { dir, inputs };
}

test("the kind: the name and the first bytes must agree; text, data and code are never sent", () => {
  assert.equal(mediaKindByName("scan.PDF"), "pdf");
  assert.equal(mediaKindByName("a/b/voice.m4a"), "audio");
  for (const n of ["notes.txt", "data.csv", "x.json", "a.md", "run.py", "noext"]) assert.equal(mediaKindByName(n), null, n);
  assert.equal(sniff(PNG), "png");
  assert.equal(sniff(PDF), "pdf");
  assert.equal(sniff(ZIP), "zip");
  assert.equal(sniff(MP3), "mp3");
  assert.equal(sniff(MP4), "isobmff");
  assert.equal(sniff(Buffer.from("hello")), null);
  assert.equal(mediaKind("photo.png", PNG), "image");
  assert.equal(mediaKind("deck.pptx", ZIP), "office");
  assert.equal(mediaKind("clip.mp4", MP4), "video");
  assert.equal(mediaKind("voice.m4a", MP4), "audio");
  assert.equal(mediaKind("photo.png", PDF), null, "a PDF named .png is not taken");
  assert.equal(mediaKind("notes.txt", PDF), null);
});

test("writes <file>.txt beside each media input it could read, and nothing for the rest", async () => {
  const { dir, inputs } = staged({ "photo.png": PNG, "docs/scan.pdf": PDF, "notes.csv": Buffer.from("a,b\n"), "voice.mp3": MP3 });
  const asked: ExtractTextAsk[] = [];
  const lines: string[] = [];
  const r = await textBesideInputs({
    tenant: "acme", workspace: "desk", runId: "run-1", files: inputs, dir,
    extract: async (ask) => {
      asked.push(ask);
      return { text: `text of ${ask.name}` };
    },
    emit: (l) => lines.push(l),
  });
  assert.deepEqual(asked.map((a) => [a.tenant, a.workspace, a.runId, a.name]), [["acme", "desk", "run-1", "photo.png"], ["acme", "desk", "run-1", "scan.pdf"], ["acme", "desk", "run-1", "voice.mp3"]]);
  assert.ok(asked.every((a) => a.signal instanceof AbortSignal));
  assert.deepEqual(r.wrote, ["photo.png.txt", "docs/scan.pdf.txt", "voice.mp3.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "docs/scan.pdf.txt"), "utf8"), "text of scan.pdf\n");
  assert.equal(fs.existsSync(path.join(dir, "notes.csv.txt")), false);
  assert.deepEqual(lines, ["inputs: text beside 3 files — photo.png.txt, docs/scan.pdf.txt, voice.mp3.txt"]);
});

test("never overwrites: an input of that name, or a file already there, is left alone", async () => {
  const { dir, inputs } = staged({ "a.png": PNG, "a.png.txt": Buffer.from("the person's own notes"), "b.png": PNG });
  fs.writeFileSync(path.join(dir, "b.png.txt"), "already here");
  let calls = 0;
  const r = await textBesideInputs({ tenant: "acme", workspace: "desk", runId: "r", files: inputs, dir, extract: async () => (calls++, { text: "ocr" }), emit: () => {} });
  assert.equal(calls, 0, "neither was sent");
  assert.deepEqual(r.wrote, []);
  assert.equal(fs.readFileSync(path.join(dir, "a.png.txt"), "utf8"), "the person's own notes");
  assert.equal(fs.readFileSync(path.join(dir, "b.png.txt"), "utf8"), "already here");
  assert.ok(r.notes.some((n) => /a\.png → no text \(a\.png\.txt is an input of its own\)/.test(n)), r.notes.join("\n"));
  assert.ok(r.notes.some((n) => /b\.png → no text \(b\.png\.txt is already there\)/.test(n)), r.notes.join("\n"));
});

test("a failure writes nothing for that file, says why in one line, and the rest go on", async () => {
  const { dir, inputs } = staged({ "bad.png": PNG, "good.pdf": PDF, "fake.png": PDF, "empty.png": Buffer.concat([PNG, Buffer.from("e")]) });
  const r = await textBesideInputs({
    tenant: "acme", workspace: "desk", runId: "r", files: inputs, dir,
    extract: async (ask) => {
      if (ask.name === "bad.png") throw new Error("the text extraction service did not answer");
      if (ask.name === "empty.png") return { text: "  \n" };
      return { text: "fine" };
    },
    emit: () => {},
  });
  assert.deepEqual(r.wrote, ["good.pdf.txt"]);
  assert.equal(fs.existsSync(path.join(dir, "bad.png.txt")), false);
  assert.ok(r.notes.includes("inputs: bad.png → no text (the text extraction service did not answer)"), r.notes.join("\n"));
  assert.ok(r.notes.includes("inputs: fake.png → no text (its bytes are not an image file)"), r.notes.join("\n"));
  assert.ok(r.notes.includes("inputs: empty.png → no text (none found)"), r.notes.join("\n"));
});

test("bounded: past the size cap a file is not sent; past the time budget the rest are skipped in one line", async () => {
  const { dir, inputs } = staged({ "big.png": Buffer.concat([PNG, Buffer.alloc(200)]), "slow.png": PNG, "later.pdf": PDF, "last.mp3": MP3 });
  const started = Date.now();
  const sent: string[] = [];
  const r = await textBesideInputs({
    tenant: "acme", workspace: "desk", runId: "r", files: inputs, dir, totalMs: 150, fileBytes: 100,
    // Slow, and honours the signal as the platform's does.
    extract: (ask) => {
      sent.push(ask.name);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: "late" }), 5_000);
        ask.signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
      });
    },
    emit: () => {},
  });
  assert.ok(Date.now() - started < 2_000, "the budget, not the slow service, decides");
  assert.deepEqual(sent, ["slow.png"], "nothing more is sent once the time is up");
  assert.deepEqual(r.wrote, []);
  assert.ok(r.notes.includes("inputs: big.png → no text (larger than 0 MB)"), r.notes.join("\n"));
  assert.ok(r.notes.includes("inputs: slow.png, later.pdf, last.mp3 → no text (the 0 s for inputs' text ran out)"), r.notes.join("\n"));
  assert.equal(INPUT_TEXT_LIMITS.totalMs, 120_000);
  assert.equal(INPUT_TEXT_LIMITS.fileBytes, 50 * 1024 * 1024);
});

test("bounded even when the extractor ignores its signal: the budget wins and a late answer is not written", async () => {
  const { dir, inputs } = staged({ "hang.png": PNG });
  let finish: (v: { text: string }) => void = () => {};
  const started = Date.now();
  const r = await textBesideInputs({
    tenant: "acme", workspace: "desk", runId: "r", files: inputs, dir, totalMs: 150,
    extract: () => new Promise((resolve) => { finish = resolve; }), // never honours the signal
    emit: () => {},
  });
  assert.ok(Date.now() - started < 2_000, "the step's start is not held by a hung extractor");
  finish({ text: "too late" });
  await new Promise((r2) => setTimeout(r2, 20));
  assert.deepEqual(r.wrote, []);
  assert.equal(fs.existsSync(path.join(dir, "hang.png.txt")), false);
  assert.ok(r.notes.some((n) => /hang\.png → no text \(the 0 s for inputs' text ran out\)/.test(n)), r.notes.join("\n"));
});

test("the prompt's note: the media inputs marked with their .txt, only when text is extracted", () => {
  const files: RunInputFile[] = [
    { path: "scan.pdf", sha: "s", size: 2048, mime: "application/pdf" },
    { path: "data.csv", sha: "s", size: 10, mime: "text/csv" },
    { path: "own.png", sha: "s", size: 10, mime: "image/png" },
    { path: "own.png.txt", sha: "s", size: 10, mime: "text/plain" },
    { path: "huge.mp4", sha: "s", size: INPUT_TEXT_LIMITS.fileBytes + 1, mime: "video/mp4" },
  ];
  assert.deepEqual(textCandidates(files).map((f) => f.path), ["scan.pdf"]);
  const plain = inputsNote(files);
  assert.doesNotMatch(plain, /\.txt exists/);
  const note = inputsNote(files, { textBeside: textCandidates(files).map((f) => f.path) });
  assert.match(note, /inputs\/scan\.pdf \(application\/pdf, 2 KiB\) — its text, when it could be extracted: inputs\/scan\.pdf\.txt/);
  assert.doesNotMatch(note, /data\.csv \(text\/csv, 10 B\) —/);
  assert.match(note, /read it first/);
});

test("the platform hook: absent on a laptop, kept until reset", () => {
  assert.equal(platform.extractText, undefined);
  registerPlatform({ extractText: async () => ({ text: "x" }) });
  assert.equal(typeof platform.extractText, "function");
  resetPlatform();
  assert.equal(platform.extractText, undefined);
});
