// tools: [text] — extract_text (text-tool.ts) against a fake proxy: the door
// it calls, what it sends, what comes back, and what it refuses before a
// byte leaves the sandbox.
//
//   node --test tests/text-tool.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TEXT_HEAD_CHARS,
  TEXT_INLINE_MAX,
  TEXT_SERVER,
  TEXT_TOOL,
  buildTextTools,
  extractHeader,
  textDoorUrl,
  textPromptLine,
  type ExtractResult,
} from "../src/text-tool.ts";
import { PLATFORM_GROUPS, isRuntimeTool, ownToolNames } from "../src/tool-names.ts";
import { limitKeysFor, limitKeyProblems } from "../src/limits.ts";
import { classifyCall } from "../src/browser-pod.ts";
import { completionsAt } from "../src/completions.ts";

const TOKEN = "t".repeat(24);
const EGRESS = `http://foldrun-egress:8090/e/${TOKEN}`;
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

/** A workspace with an agent and a library, both real directories. */
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "text-tool-"));
  const ws = path.join(root, "ws");
  const agentDir = path.join(ws, "agents", "reader");
  const lib = path.join(root, "library");
  fs.mkdirSync(path.join(ws, "storage"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(lib, "knowledge"), { recursive: true });
  return { root, ws, agentDir, lib };
}

const RESULT: ExtractResult = {
  sha256: "ab".repeat(32),
  kind: "pdf",
  format: "pdf",
  text: "سلام دنیا\nHello world",
  pages: 3,
  ocrPages: 2,
  language: "fa",
  engine: { parser: "docling" },
  truncated: false,
  warnings: ["page 2 is rotated"],
  cached: false,
  ms: 1234,
};

type Call = { url: string; init: RequestInit & { duplex?: string }; body: Buffer };
function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    const body = init.body ? Buffer.from(await new Response(init.body as BodyInit).arrayBuffer()) : Buffer.alloc(0);
    const call = { url: String(url), init, body };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, impl };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("text is a platform group of its own: not the web tool's extract action, not an author's tool", () => {
  assert.ok(PLATFORM_GROUPS.has("text"));
  assert.ok(isRuntimeTool("text"));
  assert.deepEqual(ownToolNames({ tools: ["text", "web"] }), ["web"], "`text` is the runtime's; `web` stays the gallery tool");
  assert.equal(TEXT_TOOL, "mcp__foldrun_text__extract_text");
  assert.equal(TEXT_SERVER, "foldrun_text");
  assert.match(textPromptLine(), /extract_text/);
});

test("limits: {text: 20} counts extract_text, and is a key check knows", () => {
  assert.deepEqual(limitKeysFor(TEXT_TOOL, { path: "x.pdf" }), ["calls", "text"]);
  assert.deepEqual(limitKeyProblems({ text: 20 }, { known: [], granted: ["text"] }), []);
  assert.equal(limitKeyProblems({ text: 20 }, { known: [], granted: [] })[0]?.level, "warn");
});

test("the editor offers text in tools:", () => {
  const vocab = { agents: [], flows: [], skills: [], tools: [], secrets: [], scripts: [], types: [] };
  const text = "---\ntools: [read, te";
  const labels = (completionsAt("agents/dev/agent.md", text, text.length, vocab)?.items ?? []).map((c) => c.label);
  assert.ok(labels.includes("text"), labels.join(","));
});

test("a read unless asked to save beside the file", () => {
  assert.deepEqual(classifyCall(TEXT_TOOL, { path: "workspace/storage/a.pdf" }), { write: false });
  const k = classifyCall(TEXT_TOOL, { path: "workspace/storage/a.pdf", save: true });
  assert.equal(k.write, true);
  assert.match(k.write ? k.what : "", /a\.pdf\.txt \(extract_text\)/);
});

test("the door: POST /text/<lease> with name, lang and ocr, the raw bytes as the body", () => {
  assert.equal(
    textDoorUrl({ base: "http://p:8090", token: TOKEN }, { name: "scan 1.pdf", lang: "fa", ocr: "always" }),
    `http://p:8090/text/${TOKEN}?name=scan+1.pdf&lang=fa&ocr=always`,
  );
});

test("200: one header line naming kind, pages, language and warnings, then the text", async () => {
  const { ws, agentDir, lib } = layout();
  const bytes = Buffer.from("%PDF-1.7 not really");
  fs.writeFileSync(path.join(ws, "storage", "scan.pdf"), bytes);
  const f = fakeFetch(() => json(200, RESULT));
  const events: string[] = [];
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl, emit: (_type, text) => events.push(text) });
  const r = await t.call({ path: "workspace/storage/scan.pdf", lang: "fa" });
  assert.equal((r as { isError?: boolean }).isError, undefined);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, `http://foldrun-egress:8090/text/${TOKEN}?name=scan.pdf&lang=fa&ocr=auto`);
  assert.equal(c.init.method, "POST");
  assert.equal((c.init.headers as Record<string, string>)["content-type"], "application/octet-stream");
  assert.equal((c.init.headers as Record<string, string>)["content-length"], String(bytes.length));
  assert.ok(c.body.equals(bytes), "the file's bytes, unchanged");
  const out = textOf(r);
  const [header, blank, ...rest] = out.split("\n");
  assert.match(header, /^\[extract_text\] scan\.pdf: pdf, 3 pages \(2 by OCR\), language fa, docling, 21 chars — warnings: page 2 is rotated$/);
  assert.equal(blank, "");
  assert.equal(rest.join("\n"), RESULT.text);
  assert.ok(!fs.existsSync(path.join(ws, "storage", "scan.pdf.txt")), "save defaults to false");
  assert.ok(events.some((e) => /extract_text: workspace\/storage\/scan\.pdf → pdf/.test(e)));
});

test("the header says length for media, cached, and when the service cut the text", () => {
  const h = extractHeader("memo.m4a", { ...RESULT, kind: "audio", format: "m4a", pages: undefined, ocrPages: undefined, seconds: 125, engine: { parser: "ffmpeg", speech: "whisper" }, cached: true, truncated: true, warnings: [] }, 10);
  assert.match(h, /audio \(m4a\), 2 min 5 s, language fa, ffmpeg \+ whisper, 10 chars, cached — warnings: the service cut the text short/);
});

test("save: true writes <path>.txt beside the file and says so", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "receipt.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const f = fakeFetch(() => json(200, { ...RESULT, kind: "image", format: "png", pages: undefined, ocrPages: undefined }));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const out = textOf(await t.call({ path: "workspace/storage/receipt.png", save: true }));
  assert.equal(fs.readFileSync(path.join(ws, "storage", "receipt.png.txt"), "utf8"), RESULT.text);
  assert.match(out, /Saved to workspace\/storage\/receipt\.png\.txt\./);
  assert.ok(out.endsWith(RESULT.text));
});

test("a file in the read-only library is read; its .txt goes to the agent's outputs/", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(lib, "knowledge", "deck.pptx"), "PK..");
  const f = fakeFetch(() => json(200, { ...RESULT, kind: "office", format: "pptx" }));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const out = textOf(await t.call({ path: "library/knowledge/deck.pptx", save: true }));
  assert.match(out, /Saved to outputs\/deck\.pptx\.txt\./);
  assert.equal(fs.readFileSync(path.join(agentDir, "outputs", "deck.pptx.txt"), "utf8"), RESULT.text);
  assert.ok(!fs.existsSync(path.join(lib, "knowledge", "deck.pptx.txt")));
});

test("text past the cap: only its start comes back, nothing is written unless save is asked", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "book.epub"), "PK..");
  const long = "word ".repeat(Math.ceil((TEXT_INLINE_MAX + 10) / 5));
  const f = fakeFetch(() => json(200, { ...RESULT, kind: "ebook", format: "epub", text: long }));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const out = textOf(await t.call({ path: "workspace/storage/book.epub" }));
  assert.ok(!fs.existsSync(path.join(ws, "storage", "book.epub.txt")), "a read never writes on its own");
  assert.match(out, /call extract_text again with save: true/);
  assert.ok(out.length < TEXT_HEAD_CHARS + 2_000, "only the start comes back");
  assert.ok(out.endsWith(long.slice(0, TEXT_HEAD_CHARS)));
  const saved = textOf(await t.call({ path: "workspace/storage/book.epub", save: true }));
  assert.equal(fs.readFileSync(path.join(ws, "storage", "book.epub.txt"), "utf8"), long);
  assert.match(saved, /all of it is in workspace\/storage\/book\.epub\.txt/);
});

test("save never overwrites: an existing <path>.txt is kept and the text goes to outputs/", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "scan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(ws, "storage", "scan.png.txt"), "my own notes");
  const f = fakeFetch(() => json(200, { ...RESULT, kind: "image", format: "png" }));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const out = textOf(await t.call({ path: "workspace/storage/scan.png", save: true }));
  assert.equal(fs.readFileSync(path.join(ws, "storage", "scan.png.txt"), "utf8"), "my own notes");
  assert.match(out, /Saved to outputs\/scan\.png\.txt\./);
  const again = textOf(await t.call({ path: "workspace/storage/scan.png", save: true }));
  assert.match(again, /Saved to outputs\/scan\.png\.\d+\.txt\./, "a third place, stamped, rather than over the second");
});

test("an error from the service is the tool's error, in its own words", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "x.bin"), "??");
  for (const [status, body, want] of [
    [415, { error: "not a format the service reads (application/x-msdownload)" }, /Text extraction failed: not a format the service reads/],
    [503, { error: { message: "the extraction service is busy, try again in a minute" } }, /busy, try again/],
    [500, {}, /answered 500/],
  ] as const) {
    const f = fakeFetch(() => json(status, body));
    const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
    const r = (await t.call({ path: "workspace/storage/x.bin" })) as { isError?: boolean; content: { type: string; text?: string }[] };
    assert.equal(r.isError, true, String(status));
    assert.match(textOf(r), want);
  }
});

test("a dropped line or a timeout is a tool error, not a crash", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "x.wav"), "RIFF");
  const t = buildTextTools({
    egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib,
    fetchImpl: (async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }) as typeof fetch,
  });
  const r = (await t.call({ path: "workspace/storage/x.wav" })) as { isError?: boolean; content: { type: string; text?: string }[] };
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no answer after 15 min/);
});

test("no FOLDRUN_EGRESS: it needs a platform run, and nothing is sent", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "scan.pdf"), "%PDF");
  const f = fakeFetch(() => json(200, RESULT));
  const t = buildTextTools({ egress: null, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const r = (await t.call({ path: "workspace/storage/scan.pdf" })) as { isError?: boolean; content: { type: string; text?: string }[] };
  assert.equal(r.isError, true);
  assert.match(textOf(r), /needs a platform run/);
  assert.equal(f.calls.length, 0);
});

test("a file over the size cap is refused before a byte leaves", async () => {
  const { ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(ws, "storage", "film.mp4"), Buffer.alloc(2048));
  const f = fakeFetch(() => json(200, RESULT));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl, maxFileBytes: 1024 });
  const r = (await t.call({ path: "workspace/storage/film.mp4" })) as { isError?: boolean; content: { type: string; text?: string }[] };
  assert.equal(r.isError, true);
  assert.match(textOf(r), /the largest file it takes is .*Nothing was sent/);
  assert.equal(f.calls.length, 0);
});

test("a path outside the agent's reach, a secret, or nothing at all is refused", async () => {
  const { root, ws, agentDir, lib } = layout();
  fs.writeFileSync(path.join(root, "outside.pdf"), "%PDF");
  fs.writeFileSync(path.join(ws, "secrets.json"), "{}");
  const f = fakeFetch(() => json(200, RESULT));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  for (const [p, want] of [
    [path.join(root, "outside.pdf"), /outside this workspace/],
    ["../../../outside.pdf", /outside this workspace/],
    ["workspace/secrets.json", /protected platform file/],
    ["workspace/storage/missing.pdf", /does not exist/],
    ["workspace/storage", /not a file/],
    ["", /needs `path`/],
  ] as const) {
    const r = (await t.call({ path: p })) as { isError?: boolean; content: { type: string; text?: string }[] };
    assert.equal(r.isError, true, p);
    assert.match(textOf(r), want, p);
  }
  assert.equal(f.calls.length, 0, "nothing was sent for any of them");
});

test("a path relative to the agent folder resolves there", async () => {
  const { ws, agentDir, lib } = layout();
  fs.mkdirSync(path.join(agentDir, "outputs"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "outputs", "shot.png"), "PNG");
  const f = fakeFetch(() => json(200, { ...RESULT, kind: "image", format: "png" }));
  const t = buildTextTools({ egress: EGRESS, agentDir, workspaceRoot: ws, libraryRoot: lib, fetchImpl: f.impl });
  const r = (await t.call({ path: "outputs/shot.png" })) as { isError?: boolean };
  assert.equal(r.isError, undefined);
  assert.match(f.calls[0].url, /name=shot\.png/);
});
