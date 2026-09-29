// What a stored file may be shown as rather than saved: pictures, video,
// audio and PDF — never anything that runs script in a page.
import test from "node:test";
import assert from "node:assert/strict";
import { previewType } from "../src/storage.ts";

test("pictures, video, audio and PDF preview; pages and SVG never do", () => {
  assert.equal(previewType("covers/a.PNG"), "image/png");
  assert.equal(previewType("clip.webm"), "video/webm");
  assert.equal(previewType("x/y/report.pdf"), "application/pdf");
  assert.equal(previewType("voice.mp3"), "audio/mpeg");
  assert.equal(previewType("take.FLAC"), "audio/flac");
  assert.equal(previewType("clip.mkv"), "video/x-matroska");
  assert.equal(previewType("brand.woff2"), "font/woff2");
  assert.equal(previewType("logo.ai"), "application/pdf", "Illustrator files are PDF inside");
  assert.equal(previewType("fav.ico"), "image/x-icon");
  for (const f of ["report.html", "page.htm", "logo.svg", "notes.md", "data.json", "run.js", "noext"]) {
    assert.equal(previewType(f), null, `${f} is downloaded, never shown`);
  }
});
