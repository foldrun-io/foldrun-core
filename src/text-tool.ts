// tools: [text] — a file in the sandbox, as text (12 Nov 2026).
//
// An agent handed a scanned contract, a photo of a receipt, a slide deck or
// a voice note used to have two bad choices: Read the bytes (an image goes to
// the model whole and costs what it costs; a .docx is a zip it cannot read;
// audio is nothing at all), or install an OCR stack mid-step and hope it
// knows Persian. `extract_text` hands the file to foldrun's own extraction
// service — Persian and English OCR, Docling for office files and PDFs,
// Whisper for speech — and gets text back.
//
// The service is not in the sandbox. Like ask_person and the colleagues'
// tools (operator.ts), the call goes out through the one live door a run pod
// has: the worker's egress proxy, at the lease address the pod already holds
// (FOLDRUN_EGRESS = http://<proxy>/e/<lease>). The proxy honours the door
// only for a lease granted `text: true` — a step whose agent holds the tool —
// and the lease names the account, so what the service is asked is billed
// and recorded against the right run.
//
//   POST {base}/text/{token}?name=<basename>&lang=<fa|en|auto>&ocr=<auto|always|never>
//   body: the file's bytes, application/octet-stream
//   200:  ExtractResult (below)            4xx/5xx: {error: string | {message}}
//
// No proxy (a `foldrun run` on a laptop, an in-process step) means no
// service: the tool says so instead of pretending.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkPaths, expandVirtual, type Roots } from "./confine.ts";
import { operatorEndpoint } from "./operator.ts";
import type { EventExtra } from "./step-exec.ts";

/** What the extraction service answers for one file. */
export interface ExtractResult {
  sha256: string;
  /** image | pdf | office | html | audio | video | text … — the service's word. */
  kind: string;
  /** The file format it read it as (png, pdf, docx, mp3 …). */
  format: string;
  text: string;
  pages?: number;
  /** The pages read by OCR: the platform sends their numbers; a count is
   *  taken too. */
  ocrPages?: number | number[];
  /** Audio and video: how long the recording is. */
  seconds?: number;
  confidence?: number;
  language?: string;
  engine: { parser: string; speech?: string };
  /** The service cut the text short. */
  truncated: boolean;
  warnings: string[];
  /** Answered from the service's cache (same bytes, same options). */
  cached: boolean;
  ms: number;
}

export type TextLang = "fa" | "en" | "auto";
export type TextOcr = "auto" | "always" | "never";

/** The granted name of the tool — the same on every path. */
export const TEXT_TOOL = "mcp__foldrun_text__extract_text";
export const TEXT_SERVER = "foldrun_text";
/** The largest file sent: anything bigger is refused before a byte leaves. */
export const TEXT_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** Text up to this many bytes (UTF-8) comes back whole in the tool result. */
export const TEXT_INLINE_MAX = 200 * 1024;
/** Longer text is saved to a file; this many characters of it come back. */
export const TEXT_HEAD_CHARS = 20_000;
/** Long recordings take minutes; past this the call is given up. */
export const TEXT_TIMEOUT_MS = 15 * 60_000;

type Emit = (type: "text" | "tool" | "info" | "error", text: string, extra?: EventExtra) => void;

/** The door's URL for one file. */
export function textDoorUrl(ep: { base: string; token: string }, q: { name: string; lang: TextLang; ocr: TextOcr }): string {
  const query = new URLSearchParams({ name: q.name, lang: q.lang, ocr: q.ocr });
  return `${ep.base}/text/${ep.token}?${query.toString()}`;
}

/** The one line above the text: what the file was, how much of it, in what
 *  language, and anything the service warned about. */
export function extractHeader(name: string, r: ExtractResult, chars: number): string {
  const parts: string[] = [`${r.kind}${r.format && r.format !== r.kind ? ` (${r.format})` : ""}`];
  const ocr = Array.isArray(r.ocrPages) ? r.ocrPages.length : typeof r.ocrPages === "number" ? r.ocrPages : 0;
  if (typeof r.pages === "number") parts.push(`${r.pages} page${r.pages === 1 ? "" : "s"}${ocr ? ` (${ocr} by OCR)` : ""}`);
  if (typeof r.seconds === "number") parts.push(`${fmtSeconds(r.seconds)}`);
  if (r.language) parts.push(`language ${r.language}`);
  if (typeof r.confidence === "number") parts.push(`confidence ${Math.round(r.confidence * 100) / 100}`);
  const engine = [r.engine?.parser, r.engine?.speech].filter(Boolean).join(" + ");
  if (engine) parts.push(engine);
  parts.push(`${chars.toLocaleString("en-US")} chars`);
  if (r.cached) parts.push("cached");
  const warnings = [...(r.warnings ?? []), ...(r.truncated ? ["the service cut the text short"] : [])];
  return `[extract_text] ${name}: ${parts.join(", ")}${warnings.length ? ` — warnings: ${warnings.join("; ")}` : ""}`;
}

const fmtSeconds = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s * 10) / 10} s`);

/** The line the system prompt gets for tools: [text]. */
export function textPromptLine(): string {
  return (
    "`extract_text` turns a file you can reach — an image, a scanned or text PDF, DOCX, PPTX, XLSX, EPUB, HTML, audio or video — " +
    "into text with foldrun's extraction service (Persian and English OCR, document parsing, speech recognition). " +
    "Give it the file's path (`workspace/…` for the workspace's folders); `lang` is fa, en or auto; `save: true` also writes `<path>.txt` beside the file. " +
    "Use it rather than reading a binary file yourself. A long recording can take minutes."
  );
}

/** The `extract_text` tool. `egress` is the step's FOLDRUN_EGRESS (null in
 *  process: the tool then refuses); the roots confine which files it may
 *  send and where it may write the `.txt`. `fetchImpl` is for tests. */
export function buildTextTools(opts: {
  egress: string | null | undefined;
  agentDir: string;
  workspaceRoot: string;
  libraryRoot: string;
  emit?: Emit;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxFileBytes?: number;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const roots: Roots = { agentDir: opts.agentDir, workspaceRoot: opts.workspaceRoot, libraryRoot: opts.libraryRoot };
  const maxBytes = opts.maxFileBytes ?? TEXT_MAX_FILE_BYTES;
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (t: string) => ({ ...text(t), isError: true });

  /** Where `raw` points, or why it may not be read. The file tools' own
   *  rule (confine.ts): the workspace and the library, never secrets or the
   *  run journal; `workspace/…` from the workspace root. */
  const resolve = (raw: string): { abs: string } | { error: string } => {
    const verdict = checkPaths("Read", { file_path: raw }, roots);
    if (!verdict.ok) return { error: (verdict.reason ?? `"${raw}" may not be read`).replace(/^Read was denied/, "extract_text was refused") };
    return { abs: expandVirtual(raw, roots)?.abs ?? path.resolve(roots.agentDir, raw) };
  };

  /** Write the text where the agent can find it: `<path>.txt` beside the
   *  file when the file tools would allow that write, else the agent's own
   *  outputs/. Never over an existing file (a person's notes, an earlier
   *  save): each place is created new or skipped, the last a stamped name.
   *  Returns the path as the agent should write it, or null. */
  const saveText = (raw: string, abs: string, body: string): { shown: string; abs: string } | null => {
    const besideRaw = `${raw}.txt`;
    const attempts: { shown: string; check: string }[] = [
      { shown: besideRaw, check: besideRaw },
      { shown: `outputs/${path.basename(abs)}.txt`, check: `outputs/${path.basename(abs)}.txt` },
      { shown: `outputs/${path.basename(abs)}.${Date.now()}.txt`, check: `outputs/${path.basename(abs)}.${Date.now()}.txt` },
    ];
    for (const a of attempts) {
      const verdict = checkPaths("Write", { file_path: a.check }, roots);
      if (!verdict.ok) continue;
      const target = expandVirtual(a.check, roots)?.abs ?? path.resolve(roots.agentDir, a.check);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body, { flag: "wx" });
        return { shown: a.shown, abs: target };
      } catch {
        /* the next place */
      }
    }
    return null;
  };

  const extract = tool(
    "extract_text",
    "Turn a file into text: an image or a scanned PDF (OCR, Persian and English), a text PDF, DOCX, PPTX, XLSX, EPUB or HTML (document parsing), audio or video (speech recognition). Returns a one-line header (kind, pages or length, language, warnings) and the text. Very long text returns its start; ask again with save: true to keep all of it in <path>.txt (the second call is answered from the cache).",
    {
      path: z.string().describe("The file, relative to your agent folder, or workspace/… for the workspace (workspace/storage/scan.pdf)"),
      lang: z.enum(["fa", "en", "auto"]).optional().describe("The language of the text or speech: fa, en, or auto (default) to detect it"),
      ocr: z.enum(["auto", "always", "never"]).optional().describe("auto (default): OCR only pages with no text layer; always: OCR every page; never: the text layer only"),
      save: z.boolean().optional().describe("Also write the text to <path>.txt beside the file, never over an existing file (default false)"),
    },
    async (args) => {
      const raw = String(args.path ?? "").trim();
      const lang: TextLang = args.lang === "fa" || args.lang === "en" ? args.lang : "auto";
      const ocr: TextOcr = args.ocr === "always" || args.ocr === "never" ? args.ocr : "auto";
      if (!raw) return fail("extract_text needs `path`: the file to turn into text.");
      const ep = operatorEndpoint(opts.egress);
      if (!ep) {
        return fail(
          "Text extraction needs a platform run: it is foldrun's extraction service, reached through the step's egress proxy, and this step has none (a local or in-process run). Nothing was sent.",
        );
      }
      const where = resolve(raw);
      if ("error" in where) return fail(where.error);
      let size: number;
      try {
        const st = fs.statSync(where.abs);
        if (!st.isFile()) return fail(`extract_text: "${raw}" is not a file.`);
        size = st.size;
      } catch {
        return fail(`extract_text: "${raw}" does not exist.`);
      }
      if (size === 0) return fail(`extract_text: "${raw}" is empty.`);
      if (size > maxBytes) {
        return fail(`extract_text: "${raw}" is ${fmtMb(size)}; the largest file it takes is ${fmtMb(maxBytes)}. Split it (pages, or a shorter clip) and extract the parts. Nothing was sent.`);
      }
      const name = path.basename(where.abs);
      const started = Date.now();
      let res: Response;
      try {
        res = await fetchImpl(textDoorUrl(ep, { name, lang, ocr }), {
          method: "POST",
          headers: { "content-type": "application/octet-stream", "content-length": String(size) },
          // Streamed, not read whole: a 200 MB recording stays on disk.
          body: Readable.toWeb(fs.createReadStream(where.abs)) as unknown as BodyInit,
          duplex: "half",
          signal: AbortSignal.timeout(opts.timeoutMs ?? TEXT_TIMEOUT_MS),
        } as RequestInit);
      } catch (err) {
        const e = err as { name?: string; message?: string };
        const why = e?.name === "TimeoutError" ? `no answer after ${Math.round((opts.timeoutMs ?? TEXT_TIMEOUT_MS) / 60_000)} min` : (e?.message ?? String(err));
        opts.emit?.("error", `extract_text: ${raw} — ${why}`);
        return fail(`Text extraction failed: ${why}.`);
      }
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body || typeof body.text !== "string") {
        const errField = body?.error;
        const message =
          typeof errField === "string"
            ? errField
            : errField && typeof (errField as { message?: unknown }).message === "string"
              ? String((errField as { message: string }).message)
              : res.ok
                ? "the extraction service answered without text"
                : `the extraction service answered ${res.status}`;
        opts.emit?.("error", `extract_text: ${raw} — ${message}`);
        return fail(`Text extraction failed: ${message}`);
      }
      const r = { ...(body as unknown as ExtractResult), warnings: Array.isArray(body.warnings) ? (body.warnings as unknown[]).map(String) : [] };
      const all = r.text;
      const header = extractHeader(name, r, all.length);
      opts.emit?.("info", `extract_text: ${raw} → ${r.kind}, ${all.length} chars in ${Date.now() - started} ms${r.cached ? " (cached)" : ""}`);

      if (Buffer.byteLength(all, "utf8") <= TEXT_INLINE_MAX) {
        if (!args.save) return text(`${header}\n\n${all}`);
        const saved = saveText(raw, where.abs, all);
        const note = saved ? `Saved to ${saved.shown}.` : `Could not save it beside the file or in outputs/.`;
        return text(`${header}\n${note}\n\n${all}`);
      }
      // Too long to hand back whole: the start comes back; the whole text is
      // written only when asked (save: true) — a read never writes on its own.
      const saved = args.save ? saveText(raw, where.abs, all) : null;
      const head = all.slice(0, TEXT_HEAD_CHARS);
      const total = all.length.toLocaleString("en-US");
      const note = saved
        ? `The text is ${total} characters, too long to return whole: all of it is in ${saved.shown} — read it in parts. The first ${head.length.toLocaleString("en-US")} follow.`
        : args.save
          ? `The text is ${total} characters, too long to return whole, and it could not be saved beside the file or in outputs/. The first ${head.length.toLocaleString("en-US")} follow.`
          : `The text is ${total} characters, too long to return whole. The first ${head.length.toLocaleString("en-US")} follow; call extract_text again with save: true to keep all of it in a file (the second call is answered from the cache).`;
      return text(`${header}\n${note}\n\n${head}`);
    },
  );
  return {
    server: createSdkMcpServer({ name: TEXT_SERVER, version: "1.0.0", tools: [extract] }),
    /** The tool's own function, for tests. */
    call: (args: { path: string; lang?: TextLang; ocr?: TextOcr; save?: boolean }) =>
      extract.handler({ path: args.path, lang: args.lang, ocr: args.ocr, save: args.save }, {}),
    toolNames: [TEXT_TOOL],
    promptLines: [textPromptLine()],
  };
}

const fmtMb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
