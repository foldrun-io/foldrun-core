// Which language to answer a person in (FOL-275). `language:` says what an
// agent produces on its own account; a person who writes to it is answered
// in the language they wrote in (owner, 24 Nov 2026: "we don't force any
// languages"). Prose saying so lost to an account default of Persian and a
// Persian persona: an English message was answered in Persian. One line
// ahead of the message — `Reply language: English (en)` — is what the model
// follows, and it is the line account prose already names.
//
// Detection is by writing system first, then a few common words for the
// languages written in Latin letters. It is a guess about one message, said
// as a guess: a message too short to tell gives no line, and the agent goes
// by its other instructions.

import { languageName } from "./language.ts";

const LETTER = /\p{L}/gu;

/** Code, links and paths say nothing about the language a person writes in. */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/(?:^|\s)[~.]?\/[^\s]+/g, " ")
    // A file name says nothing either, whatever letters it has ("Fix گزارش.ts" — Codex):
    // word by word, so a long unbroken token costs its length once, not its square.
    .split(/(\s+)/)
    .map((w) => (FILE_NAME.test(w) ? " " : w))
    .join("");
}
const FILE_NAME = /\.[A-Za-z][A-Za-z0-9]{0,7}(?:[^A-Za-z0-9]|$)/;
/** Only the end of a long message is read: the person's words are there, and the work stays bounded. */
const READ_CHARS = 8000;

/** Text a program printed — an error, a stack frame, a log line, a prompt — not the person writing. */
const MACHINE_LINE = /^\s*(?:[A-Z][A-Za-z]*(?:Error|Exception|Warning)\b|Traceback\b|at\s+\S+|npm (?:ERR|WARN)|error(?:\[|:)|warning(?:\[|:)|fatal:|\$ |> |\d{4}-\d\d-\d\d[T ]\d\d:)/;
/** A paragraph without the lines a program printed ("Why did this fail?" above a TypeError keeps its question — Codex). */
function ownLines(paragraph: string): string {
  return paragraph.split("\n").filter((l) => !MACHINE_LINE.test(l)).join("\n");
}

/** Quoted text is someone else's words (a label, a message), not an ask. */
const unquoted = (text: string) => text.replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|'[^'\n]{3,}'/g, " ");

const SCRIPTS: Array<[RegExp, (s: string, hint: string | null) => string]> = [
  // Persian has پ چ ژ گ and its own ی and ک; Urdu its own letters; Arabic
  // its ة and its own ي ك ى. A word with none of them ("سلام") is either:
  // the account's own language decides, when it is one of them.
  [/\p{Script=Arabic}/u, (s, hint) => (/[ٹڈڑںےھ]/.test(s) ? "ur" : /[پچژگیک]/.test(s) ? "fa" : /[ةيكى]/.test(s) ? "ar" : hint === "fa" || hint === "ur" ? hint : "ar")],
  [/\p{Script=Hebrew}/u, () => "he"],
  [/\p{Script=Cyrillic}/u, (s) => (/[іїєґ]/i.test(s) ? "uk" : "ru")],
  [/\p{Script=Greek}/u, () => "el"],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, () => "ja"],
  [/\p{Script=Hangul}/u, () => "ko"],
  [/\p{Script=Han}/u, (s) => (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s) ? "ja" : "zh")],
  [/\p{Script=Devanagari}/u, () => "hi"],
  [/\p{Script=Thai}/u, () => "th"],
];

// A handful of words each language uses constantly and the others rarely.
const WORDS: Record<string, string[]> = {
  en: ["the", "is", "and", "to", "of", "it", "this", "that", "what", "how", "why", "please", "can", "you", "with", "for", "are", "do", "does", "not", "my", "i", "if", "fix", "add", "make", "test", "check", "run"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ich", "ein", "eine", "mit", "für", "bitte", "wie", "warum", "kannst", "du", "auf", "zu"],
  fr: ["le", "les", "et", "est", "une", "des", "pas", "je", "vous", "pour", "avec", "pourquoi", "comment", "peux", "tu", "ce", "qui", "dans"],
  es: ["el", "los", "las", "y", "es", "una", "que", "por", "para", "con", "no", "puedes", "cómo", "por qué", "este", "esto", "del"],
  pt: ["os", "as", "é", "um", "uma", "não", "para", "com", "você", "como", "isso", "este", "do", "da", "por favor"],
  it: ["il", "gli", "è", "un", "una", "che", "non", "per", "con", "puoi", "come", "perché", "questo", "della", "di"],
  nl: ["het", "een", "en", "is", "niet", "ik", "je", "met", "voor", "kun", "hoe", "waarom", "dit", "van"],
  tr: ["ve", "bir", "bu", "için", "ile", "değil", "ne", "ben", "nasıl", "neden", "mi", "mı", "lütfen"],
};
const MARKS: Record<string, RegExp> = { de: /ß/, es: /ñ|¿|¡/, pt: /[ãõ]/, tr: /[ğış]/ };

/** The language one piece of a person's writing is in, as a base tag (`en`, `fa`), or null when it cannot be told. */
export function detectLanguage(text: string, hint: string | null = null): string | null {
  const p = prose(text);
  const letters = p.match(LETTER) ?? [];
  if (letters.length < 2) return null;
  // A writing system that is not Latin wins when it is a real part of the
  // message: identifiers and file names in Latin letters ride along in any
  // language.
  for (const [re, which] of SCRIPTS) {
    const n = letters.filter((l) => re.test(l)).length;
    if (n >= 2 && n / letters.length >= 0.15) return which(p, hint);
  }
  const words = p.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (!words.some((w) => /\p{Script=Latin}/u.test(w))) return null;
  let best = "en";
  let bestScore = 0;
  for (const [tag, list] of Object.entries(WORDS)) {
    const set = new Set(list);
    let score = words.filter((w) => set.has(w)).length + (MARKS[tag]?.test(p) ? 2 : 0);
    if (tag === "en") score += 0.5; // ties go to English
    if (score > bestScore) {
      best = tag;
      bestScore = score;
    }
  }
  // Another language needs two signs of itself; one shared word is not enough.
  return best !== "en" && bestScore < 2 ? "en" : best;
}

// "answer in English", "reply in Persian please", "به فارسی جواب بده".
const NAMES: Record<string, string> = { farsi: "fa", persian: "fa", english: "en", arabic: "ar", german: "de", french: "fr", spanish: "es", portuguese: "pt", italian: "it", dutch: "nl", turkish: "tr", russian: "ru", ukrainian: "uk", chinese: "zh", japanese: "ja", korean: "ko", hindi: "hi", urdu: "ur", hebrew: "he", greek: "el", thai: "th" };
const ASK_EN = /\b(?:reply|answer|respond|write|talk|speak|continue)(?:\s+(?:to\s+me|back|only))?\s+in\s+([a-z]+)\b/gi;
/** "do not reply in", "don't answer in", "never write in": not an ask. */
const NEGATED_EN = /\b(?:not|don't|dont|never|no)\s+(?:\w+\s+){0,2}$/i;
const PERSIAN_NAMES: Record<string, string> = { "فارسی": "fa", "انگلیسی": "en", "عربی": "ar" };
// "جواب نده" / "ننویس" is the opposite of an ask.
const ASK_FA = /(?:به|با)\s*(فارسی|انگلیسی|عربی)\s*(?:جواب|پاسخ|بنویس|حرف)(?!\s*(?:نده|نزن|ندهید))|(فارسی|انگلیسی|عربی)\s*(?:جواب|پاسخ)\s*بده/g;

/** A language the person asked to be answered in, in so many words; the last ask wins. */
export function askedLanguage(text: string): string | null {
  return askedIn(prose(text));
}

function askedIn(prosed: string): string | null {
  const p = unquoted(prosed);
  let found: { at: number; tag: string } | null = null;
  for (const m of p.matchAll(ASK_EN)) {
    if (NEGATED_EN.test(p.slice(Math.max(0, m.index! - 40), m.index!))) continue;
    const tag = NAMES[m[1]!.toLowerCase()];
    if (tag && (!found || m.index! >= found.at)) found = { at: m.index!, tag };
  }
  for (const m of p.matchAll(ASK_FA)) {
    const tag = PERSIAN_NAMES[(m[1] ?? m[2])!];
    if (tag && (!found || m.index! >= found.at)) found = { at: m.index!, tag };
  }
  return found?.tag ?? null;
}

/**
 * The language to answer a message in: one the person asked for, else the
 * one they wrote in. A message is read from its end — notes a client put
 * ahead of the person's words (what happened elsewhere in the session) are
 * not the person writing — going back a paragraph at a time while the last
 * says nothing (a pasted command, "ok").
 */
export function replyLanguage(message: string, hint: string | null = null): string | null {
  // Code is taken out of the whole message first (every pattern here is linear), then only the end is read:
  // a long code block cannot push the person's own words out (Codex).
  const all = prose(message);
  const end = all.length > READ_CHARS ? all.slice(-READ_CHARS) : all;
  const asked = askedIn(all.length > READ_CHARS * 4 ? all.slice(-READ_CHARS * 4) : all);
  if (asked) return asked;
  const parts = end.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    // What a program printed (a pasted error) is passed over: the person's own words decide.
    const own = ownLines(parts[i]!);
    if (!own.trim()) continue;
    const tag = detectLanguage(own, hint);
    if (tag) return tag;
  }
  return null;
}

/**
 * The line put ahead of a person's message — `Reply language: English (en)`
 * — or null when the language cannot be told. `setting`: the `language:`
 * the agent works in, which only breaks a tie its letters cannot.
 */
export function replyLanguageLine(message: string, setting: string | null = null): string | null {
  const tag = replyLanguage(message, setting ? setting.split("-")[0]!.toLowerCase() : null);
  return tag ? `Reply language: ${languageName(tag)} (${tag})` : null;
}
