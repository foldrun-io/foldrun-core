// Text beside a run's media inputs (12 Nov 2026). A run handed a photo, a
// scanned PDF, a slide deck or a voice note (FOL-163, run-inputs.ts) gets,
// at staging, `<file>.txt` beside each one the platform could read — OCR, the
// document's text, a transcript — so the step starts with text it can read
// for the price of text, instead of an image block, a zip it cannot open, or
// nothing at all for audio.
//
// Core does not extract anything: the platform does, through
// platform.extractText (foldrun's own extraction pods). No hook — a laptop,
// a self-hosted install without the service — means no .txt and no note in
// the prompt. Best effort and bounded, so staging never stalls a run or
// fails it: INPUT_TEXT_LIMITS.totalMs across every input (past it, the rest
// are skipped), a size cap per file, recordings of at most ten minutes
// (the platform refuses longer before Whisper is asked). A file that yields
// nothing gets one line in the trail saying why; a `.txt` is never written
// over an input or a file of that name (`wx`).

import fs from "node:fs";
import path from "node:path";
import type { RunInputFile } from "./storage.ts";
import type { ExtractTextAsk } from "./platform.ts";

export const INPUT_TEXT_LIMITS = {
  /** Every input's extraction together, at staging. */
  totalMs: 120_000,
  /** The largest input sent for its text. */
  fileBytes: 50 * 1024 * 1024,
  /** The longest recording transcribed (the platform holds it). */
  speechSeconds: 600,
} as const;

export type MediaKind = "image" | "pdf" | "office" | "audio" | "video";

/** The extensions taken, by kind. Text, data and code are not here: the step
 *  reads those as they are. */
const BY_EXT: Record<string, MediaKind> = {
  ...Object.fromEntries(["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "heic", "heif"].map((e) => [e, "image" as const])),
  pdf: "pdf",
  ...Object.fromEntries(["docx", "doc", "pptx", "ppt", "xlsx", "xls", "odt", "odp", "ods", "rtf", "epub"].map((e) => [e, "office" as const])),
  ...Object.fromEntries(["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "wma", "amr"].map((e) => [e, "audio" as const])),
  ...Object.fromEntries(["mp4", "mov", "mkv", "webm", "avi", "m4v", "3gp", "mpeg", "mpg"].map((e) => [e, "video" as const])),
};

/** The kind a file's name says, or null for anything not sent for text. */
export function mediaKindByName(name: string): MediaKind | null {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return ext ? (BY_EXT[ext] ?? null) : null;
}

/** What a file's first bytes say it is — the containers, not the codecs. */
export type Sniffed = "png" | "jpeg" | "gif" | "webp" | "tiff" | "bmp" | "pdf" | "zip" | "ole" | "rtf" | "mp3" | "wav" | "ogg" | "flac" | "aac" | "amr" | "asf" | "avi" | "isobmff" | "ebml" | "mpeg-ps";

export function sniff(head: Buffer): Sniffed | null {
  const at = (off: number, sig: number[]) => head.length >= off + sig.length && sig.every((b, i) => head[off + i] === b);
  const ascii = (off: number, s: string) => head.length >= off + s.length && head.toString("latin1", off, off + s.length) === s;
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(0, "GIF8")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (ascii(0, "RIFF") && ascii(8, "AVI ")) return "avi";
  if (at(0, [0x49, 0x49, 0x2a, 0x00]) || at(0, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(0, "BM")) return "bmp";
  if (ascii(0, "%PDF")) return "pdf";
  if (at(0, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (at(0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (ascii(0, "{\\rtf")) return "rtf";
  if (ascii(0, "ID3") || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe6) === 0xe2)) return "mp3";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xf6) === 0xf0) return "aac";
  if (ascii(0, "OggS")) return "ogg";
  if (ascii(0, "fLaC")) return "flac";
  if (ascii(0, "#!AMR")) return "amr";
  if (at(0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])) return "asf";
  if (ascii(4, "ftyp")) return "isobmff";
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (at(0, [0x00, 0x00, 0x01, 0xba])) return "mpeg-ps";
  return null;
}

/** The containers each kind may arrive in. */
const FITS: Record<MediaKind, ReadonlySet<Sniffed>> = {
  image: new Set(["png", "jpeg", "gif", "webp", "tiff", "bmp", "isobmff"]),
  pdf: new Set(["pdf"]),
  office: new Set(["zip", "ole", "rtf"]),
  audio: new Set(["mp3", "wav", "ogg", "flac", "aac", "amr", "asf", "isobmff", "ebml"]),
  video: new Set(["isobmff", "ebml", "avi", "asf", "mpeg-ps", "ogg"]),
};

/** The kind, when the name and the first bytes agree on one; else null. */
export function mediaKind(name: string, head: Buffer): MediaKind | null {
  const byName = mediaKindByName(name);
  if (!byName) return null;
  const s = sniff(head);
  return s && FITS[byName].has(s) ? byName : null;
}

/** Inputs whose text may be put beside them: the media ones, small enough,
 *  with no input already taking `<path>.txt`. What the prompt's note marks. */
export function textCandidates(files: RunInputFile[]): RunInputFile[] {
  const names = new Set(files.map((f) => f.path));
  return files.filter((f) => mediaKindByName(f.path) && f.size <= INPUT_TEXT_LIMITS.fileBytes && !names.has(`${f.path}.txt`));
}

export interface TextBesideInputs {
  tenant: string;
  workspace: string;
  runId: string;
  files: RunInputFile[];
  /** The staged inputs folder (stageRunInputs' `intoDir`). */
  dir: string;
  extract: (ask: ExtractTextAsk) => Promise<{ text: string; warnings?: string[] }>;
  /** One line for the run's trail. */
  emit: (line: string) => void;
  /** Overrides, for tests. */
  totalMs?: number;
  fileBytes?: number;
}

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Write `<file>.txt` beside each media input the platform can read. Never
 * throws for one file, and never runs past `totalMs`: what is left then is
 * named in one line. Returns the .txt paths written (relative to `dir`) and
 * the lines emitted.
 */
export async function textBesideInputs(o: TextBesideInputs): Promise<{ wrote: string[]; notes: string[] }> {
  const totalMs = o.totalMs ?? INPUT_TEXT_LIMITS.totalMs;
  const fileBytes = o.fileBytes ?? INPUT_TEXT_LIMITS.fileBytes;
  const notes: string[] = [];
  const note = (line: string) => {
    notes.push(line);
    try {
      o.emit(line);
    } catch {
      /* the trail's problem, not the run's */
    }
  };
  const wrote: string[] = [];
  const late: string[] = [];
  const names = new Set(o.files.map((f) => f.path));
  const clock = new AbortController();
  // NOT unref'd: this function awaits the deadline, so the timer must keep
  // the process alive until it fires (cleared in finally, at most totalMs).
  // Unref'd, a hung extractor in a process with nothing else to do — the
  // CLI's `foldrun run`, a test — let the event loop empty and the await
  // never settle (the dev gate, 12 Nov 2026: "Promise resolution is still
  // pending but the event loop has already resolved").
  const timer = setTimeout(() => clock.abort(), totalMs);
  try {
    for (const f of o.files) {
      const byName = mediaKindByName(f.path);
      if (!byName) continue;
      const target = `${f.path}.txt`;
      if (names.has(target)) {
        note(`inputs: ${f.path} → no text (${target} is an input of its own)`);
        continue;
      }
      if (clock.signal.aborted) {
        late.push(f.path);
        continue;
      }
      if (f.size > fileBytes) {
        note(`inputs: ${f.path} → no text (larger than ${Math.round(fileBytes / 1048576)} MB)`);
        continue;
      }
      const abs = path.join(o.dir, f.path);
      const out = `${abs}.txt`;
      try {
        if (fs.existsSync(out)) {
          note(`inputs: ${f.path} → no text (${target} is already there)`);
          continue;
        }
        const bytes = fs.readFileSync(abs);
        if (!mediaKind(f.path, bytes.subarray(0, 64))) {
          note(`inputs: ${f.path} → no text (its bytes are not ${/^[aeiou]/.test(byName) ? "an" : "a"} ${byName} file)`);
          continue;
        }
        // Raced against the budget: an extractor that ignores its signal (or
        // hangs) must not hold the step's start past it; an answer arriving
        // after the deadline is dropped, never written.
        const r = await new Promise<Awaited<ReturnType<typeof o.extract>>>((resolve, reject) => {
          if (clock.signal.aborted) return reject(new Error("the budget ran out"));
          const onAbort = () => reject(new Error("the budget ran out"));
          clock.signal.addEventListener("abort", onAbort, { once: true });
          o.extract({ tenant: o.tenant, workspace: o.workspace, runId: o.runId, name: path.basename(f.path), bytes, signal: clock.signal })
            .then(resolve, reject)
            .finally(() => clock.signal.removeEventListener("abort", onAbort));
        });
        if (clock.signal.aborted) {
          late.push(f.path);
          continue;
        }
        if (!r.text.trim()) {
          note(`inputs: ${f.path} → no text (none found)`);
          continue;
        }
        fs.writeFileSync(out, r.text.endsWith("\n") ? r.text : `${r.text}\n`, { flag: "wx" });
        wrote.push(target);
      } catch (err) {
        if (clock.signal.aborted) {
          late.push(f.path);
          continue;
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        note(`inputs: ${f.path} → no text (${code === "EEXIST" ? `${target} is already there` : short((err as Error)?.message ?? String(err)) || "the extraction failed"})`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (late.length) note(`inputs: ${late.join(", ")} → no text (the ${Math.round(totalMs / 1000)} s for inputs' text ran out)`);
  if (wrote.length) note(`inputs: text beside ${wrote.length} file${wrote.length === 1 ? "" : "s"} — ${wrote.join(", ")}`);
  return { wrote, notes };
}
