// FOL-275: which language a person is answered in. The account says what
// agents produce (`language: fa`); a person who writes in English is
// answered in English. One line ahead of the message on the step a
// person's message reaches, and only when someone set a language.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askedLanguage, detectLanguage, replyLanguage, replyLanguageLine } from "../src/reply-language.ts";

test("by writing system: Persian, Arabic and Urdu apart by their own letters; others by script", () => {
  assert.equal(detectLanguage("این تست را درست کن"), "fa");
  // "سلام" has no letter only Persian or only Arabic has: the setting decides.
  assert.equal(detectLanguage("سلام", "fa"), "fa");
  assert.equal(detectLanguage("سلام"), "ar");
  assert.equal(detectLanguage("كيف حالك", "fa"), "ar", "Arabic's own letters say Arabic whatever the setting");
  assert.equal(detectLanguage("ما هو الخطأ في هذا الملف"), "ar");
  assert.equal(detectLanguage("یہ ٹیسٹ ٹھیک کرو"), "ur");
  assert.equal(detectLanguage("Почему тест падает?"), "ru");
  assert.equal(detectLanguage("为什么测试失败"), "zh");
  assert.equal(detectLanguage("テストを直して"), "ja");
  assert.equal(detectLanguage("테스트를 고쳐줘"), "ko");
});

test("Latin letters: English unless two signs of another; code, paths and links do not count", () => {
  assert.equal(detectLanguage("test if this task is in cloud"), "en", "the owner's message, 24 Nov");
  assert.equal(detectLanguage("fix it"), "en");
  assert.equal(detectLanguage("warum ist der Test nicht grün"), "de");
  assert.equal(detectLanguage("pourquoi le test est rouge, je ne sais pas"), "fr");
  assert.equal(detectLanguage("el test no pasa, ¿por qué?"), "es");
  // Persian prose with file names and code in Latin letters is Persian.
  assert.equal(detectLanguage("فایل src/runner.ts را باز کن و تابع `executeStep` را درست کن"), "fa");
  // Too little to tell.
  assert.equal(detectLanguage("?"), null);
  assert.equal(detectLanguage("```\nnpm test\n```"), null);
});

test("an ask in so many words wins, and the last ask wins", () => {
  assert.equal(askedLanguage("explain this, and reply in Persian please"), "fa");
  assert.equal(askedLanguage("answer in Farsi. actually, answer in English"), "en");
  assert.equal(askedLanguage("این را به انگلیسی جواب بده"), "en");
  assert.equal(askedLanguage("written in English"), null, "describing text is not an ask");
  assert.equal(replyLanguage("explain this file, reply in Persian"), "fa");
  // Not an ask: negated, or quoted (a label the person is asking about) — Codex.
  assert.equal(askedLanguage("Do not reply in Persian"), null);
  assert.equal(askedLanguage("don't answer in English here"), null);
  assert.equal(askedLanguage("دکمه‌ی “continue in English mode” چه می‌کند؟"), null);
  assert.equal(replyLanguage("دکمه‌ی “continue in English mode” چه می‌کند؟"), "fa");
  assert.equal(askedLanguage("به انگلیسی جواب نده"), null);
});

test("a message is read from its end: a client's English notes ahead of a Persian question do not decide it", () => {
  const notes = "(Earlier in this session, on this computer: you fixed the failing test and ran it.)";
  assert.equal(replyLanguage(`${notes}\n\nحالا تست‌ها را اجرا کن`), "fa");
  assert.equal(replyLanguage(`(قبلاً: تست را درست کردی)\n\nnow run the tests`), "en");
  // The last paragraph says nothing (a pasted command): the one before it does.
  assert.equal(replyLanguage("این خطا را ببین\n\n```\nTypeError: x is undefined\n```"), "fa");
  // A pasted error after a Persian question: the question decides (Codex).
  assert.equal(replyLanguage("چرا این خطا می‌آید؟\n\nTypeError: Cannot read properties of undefined (reading 'x')\n    at run (src/a.ts:3:9)"), "fa");
  assert.equal(replyLanguage("Why did this fail?\nTypeError: x is undefined"), "en", "the question above the error line counts");
  // A long unbroken token is read in linear time (Codex).
  const t0 = Date.now();
  replyLanguage("a".repeat(200_000));
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  // An ask ahead of a long code block still counts (Codex).
  assert.equal(replyLanguage("Please reply in Persian\n\n```js\n" + "const x = 1;\n".repeat(800) + "```"), "fa");
  // A file name in Persian letters does not make an English message Persian.
  assert.equal(replyLanguage("Fix گزارش.ts please"), "en");
  assert.equal(replyLanguageLine("test if this task is in cloud"), "Reply language: English (en)");
  assert.equal(replyLanguageLine("این تست را درست کن"), "Reply language: Persian (fa)");
  assert.equal(replyLanguageLine("ok"), "Reply language: English (en)");
  assert.equal(replyLanguageLine("?"), null);
  assert.equal(replyLanguageLine("سلام", "fa-IR"), "Reply language: Persian (fa)");
});

test("a whole run: account language fa, an English message → the line says English; a Persian one → Persian; a later step and an unset language get none", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-reply-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevStub = process.env.FOLDRUN_STUB_STEP;
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_STUB_STEP = "1";
  try {
    const { createFlowRun, driveRun } = await import("../src/runner.ts");
    const { readRun, writeRun } = await import("../src/store.ts");
    const { runContext } = await import("../src/conversation.ts");
    const acct = path.join(root, "acme");
    const ws = path.join(acct, "workspaces", "desk");
    for (const a of ["coder", "next"]) {
      fs.mkdirSync(path.join(ws, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", a, "agent.md"), `---\nname: ${a}\n---\n\nYou are Agent (ایجنت).\n`);
    }
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    fs.writeFileSync(path.join(acct, "AGENTS.md"), "---\nlanguage: fa\nregion: ir\n---\n\nEach message carries a line `Reply language: …`; it comes before any default language you were given.\n");
    const turn = async (text: string, ctx: string) => {
      const steps = [
        { agent: "coder", instruction: text, group: 1, optional: false },
        { agent: "next", instruction: "polish", group: 2, optional: false },
      ];
      const made = createFlowRun("acme", "desk", steps, "chat", "queued", [], null, {}, undefined, undefined, { context: runContext(ctx), input: { text } });
      made.status = "running";
      writeRun("acme", "desk", made);
      await driveRun("acme", "desk", made, null, []);
      const done = readRun("acme", "desk", made.id)!;
      const said = (i: number) => done.steps[i]!.events.filter((e) => e.text.startsWith("stub Reply language")).map((e) => e.text);
      return { first: said(0), second: said(1) };
    };
    const en = await turn("test if this task is in cloud", "c-en");
    assert.deepEqual(en.first, ["stub Reply language: English (en)"]);
    assert.deepEqual(en.second, [], "only the step the person's message reaches");
    const fa = await turn("این تسک در کلود اجرا می‌شود؟", "c-fa");
    assert.deepEqual(fa.first, ["stub Reply language: Persian (fa)"]);
    // No language set anywhere: the prompt is what it always was.
    fs.writeFileSync(path.join(acct, "AGENTS.md"), "---\nname: acme\n---\n");
    const none = await turn("test if this task is in cloud", "c-none");
    assert.deepEqual(none.first, []);
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevStub === undefined) delete process.env.FOLDRUN_STUB_STEP;
    else process.env.FOLDRUN_STUB_STEP = prevStub;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rescuer answers in the person's language: the English failure appended to its instruction does not count (Codex)", async () => {
  const { replyLineFor } = await import("../src/runner.ts");
  const fa = { language: "fa", from: "account" as const, lines: [] };
  const instruction = "این تست را درست کن\n\n<rescue>\nYou are taking this step over: [[coder]] attempted it and failed. Its failure, for whatever it is worth:\nThe step timed out after 900 seconds.\n</rescue>";
  assert.equal(replyLineFor({ conversationTurn: true, instruction }, fa), "Reply language: Persian (fa)");
  assert.equal(replyLineFor({ conversationTurn: false, instruction }, fa), null, "not a person's turn");
  assert.equal(replyLineFor({ conversationTurn: true, instruction }, { language: "en", from: "default", lines: [] }), null, "no language set");
});
