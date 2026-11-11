// What a model is shown when an agent opens a file (FOL-163): Chat
// Completions carries text alone in a tool message, so an image a tool
// returned follows the tool messages in one user message, labelled with its
// call; a PDF goes only where the endpoint takes Chat's `file` part; and
// whatever cannot be shown is said to the model in its place, never silently
// dropped. Responses carries both, PDFs from a tool included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toChatCompletions, toResponses, NOT_SHOWN, translatorSpecFor } from "../src/translator.ts";

const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }, title: "q4.pdf" };
const req = (userContent: unknown[]) => ({
  model: "m",
  messages: [
    { role: "user", content: "read the inputs" },
    { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: { file_path: "inputs/photo.png" } }, { type: "tool_use", id: "call_b", name: "Read", input: { file_path: "inputs/q4.pdf" } }] },
    { role: "user", content: userContent },
  ],
});
const results = [
  { type: "tool_result", tool_use_id: "call_a", content: [{ type: "text", text: "photo.png" }, img] },
  { type: "tool_result", tool_use_id: "call_b", content: [pdf] },
];

test("chat: tool messages first, then one user message with the image, labelled by its call; the PDF said not shown", () => {
  const out = toChatCompletions(req(results), { stream: false }) as { messages: { role: string; content: unknown; tool_call_id?: string }[] };
  const roles = out.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-3), ["tool", "tool", "user"], "every result of the turn, then the lifted media");
  const [a, b, u] = out.messages.slice(-3);
  assert.equal(a!.tool_call_id, "call_a");
  assert.match(String(a!.content), /photo\.png\n\[the file it returned is attached in the next message\]/);
  assert.equal(b!.content, NOT_SHOWN.pdf, "the model is told, not left with 'ok'");
  const parts = u!.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(parts[0]!.text, "What the tool call call_a returned:");
  assert.equal(parts[1]!.type, "image_url");
  assert.match(parts[1]!.image_url!.url, /^data:image\/png;base64,/);
});

test("chat: a PDF goes as a file part where the endpoint takes one; images off means the model is told", () => {
  const withPdf = toChatCompletions(req(results), { stream: false, media: { pdf: true } }) as { messages: { role: string; content: unknown }[] };
  const u = withPdf.messages.at(-1)!.content as { type: string; file?: { filename: string; file_data: string } }[];
  const file = u.find((p) => p.type === "file")!;
  assert.equal(file.file!.filename, "q4.pdf");
  assert.match(file.file!.file_data, /^data:application\/pdf;base64,JVBERi0=/);

  const noImages = toChatCompletions(req(results), { stream: false, media: { images: false } }) as { messages: { role: string; content: unknown }[] };
  const tools = noImages.messages.filter((m) => m.role === "tool");
  assert.match(String(tools[0]!.content), new RegExp(NOT_SHOWN.image.replace(/[[\]]/g, "\\$&")));
  assert.equal(noImages.messages.at(-1)!.role, "tool", "nothing lifted: no user message after");

  const top = toChatCompletions({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "see" }, pdf, img] }] }, { stream: false, media: { images: false } }) as { messages: { content: { text?: string }[] }[] };
  const texts = top.messages.at(-1)!.content.map((p) => p.text);
  assert.deepEqual(texts, ["see", NOT_SHOWN.pdf, NOT_SHOWN.image], "top-level files are said in their place too");
});

test("responses: images and PDFs a tool returned are both carried; off means told", () => {
  const out = toResponses(req(results), { stream: false }) as { input: { type?: string; call_id?: string; output?: unknown }[] };
  const outs = out.input.filter((x) => x.type === "function_call_output");
  const pdfOut = outs.find((x) => x.call_id === "call_b")!.output as { type: string; filename?: string; file_data?: string }[];
  assert.equal(pdfOut[0]!.type, "input_file");
  assert.equal(pdfOut[0]!.filename, "q4.pdf");
  const imgOut = outs.find((x) => x.call_id === "call_a")!.output as { type: string }[];
  assert.deepEqual(imgOut.map((p) => p.type), ["input_text", "input_image"]);

  const off = toResponses(req(results), { stream: false, media: { pdf: false } }) as { input: { type?: string; call_id?: string; output?: unknown }[] };
  assert.equal(off.input.find((x) => x.type === "function_call_output" && x.call_id === "call_b")!.output, NOT_SHOWN.pdf);
});

test("a preset's media reaches the translator spec", () => {
  const spec = translatorSpecFor({ format: "openai", baseUrl: "https://example.test/v1", token: "t", headers: {}, name: "no-such-preset" });
  assert.equal(spec!.media, undefined, "unknown preset: the format's defaults");
});

test("chat: results of one turn split over two user messages — every tool message first, then one user message with the media (Codex review)", () => {
  const split = {
    model: "m",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: {} }, { type: "tool_use", id: "call_b", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: [img] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_b", content: "b's text" }, { type: "text", text: "and then" }] },
    ],
  };
  const out = toChatCompletions(split, { stream: false }) as { messages: { role: string; content: unknown; tool_call_id?: string }[] };
  assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "user"]);
  const last = out.messages.at(-1)!.content as { type: string; text?: string }[];
  assert.equal(last[0]!.text, "What the tool call call_a returned:");
  assert.equal(last[1]!.type, "image_url");
  assert.equal(last.at(-1)!.text, "and then");
});
