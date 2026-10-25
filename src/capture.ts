// A tool call's content, from a step's event to the file beside its run
// (FOL-54 step 4), masked twice: the step's own secrets by value (the
// runner's redact, from redactionsFor), then anything shaped like a
// credential or a private key — a key the agent read from a file or a page
// is not in the vault, and is still a key. Masked first, cut second, so a
// secret on the cap's edge is never kept half. Recording never fails the step.

import { redactText } from "./scan.ts";
import { writeCapturedCall, CAPTURE_CAP } from "./store.ts";
import { isFileValue, fileContent, isApiValue, apiConfigOf, isClientCertValue, clientCertOf } from "./secrets.ts";
import type { CallIo } from "./step-exec.ts";

/** How much past the cap a step sends, so masking sees a secret whole
 *  before the cut (a value longer than this is a file secret, which is also
 *  masked line by line). */
export const CAPTURE_SLACK = 4096;

/**
 * What the step's scrub replaces: every secret value it holds → its name,
 * longest first. An `@file` secret (a key, a certificate) by its content, not
 * its stored form; a multi-line value also line by line, because a file is
 * read back a line at a time (the Read tool numbers each); and every value
 * also as it appears inside JSON, where `"` `\` and newlines are escaped — a
 * tool's input is JSON. Values under 8 characters are skipped: a two-letter
 * secret would redact half the language, and anything that short is not one.
 */
export function redactionsFor(secrets: Record<string, string | undefined>): [string, string][] {
  const out = new Map<string, string>();
  const add = (v: string, name: string) => {
    if (v.length >= 8 && !out.has(v)) out.set(v, name);
  };
  for (const [name, raw] of Object.entries(secrets)) {
    if (typeof raw !== "string") continue;
    // An API connection's header values are each a secret in their own right
    // (a token, Basic credentials) — and a Basic header's password too.
    // An exported client certificate's passphrase and private key reach the
    // sandbox as files: each is masked, whole and line by line.
    if (isClientCertValue(raw)) {
      const c = clientCertOf(raw);
      for (const v of [c.passphrase, c.key]) {
        if (!v) continue;
        add(v, name);
        add(v.trim(), name);
        const escaped = JSON.stringify(v).slice(1, -1);
        if (escaped !== v) add(escaped, name);
        for (const line of v.split(/\r?\n/)) if (line.trim().length >= 16) add(line.trim(), name);
      }
    }
    if (isApiValue(raw)) {
      // Each as written and as JSON would escape it, like every value here.
      const both = (v: string) => {
        add(v, name);
        const escaped = JSON.stringify(v).slice(1, -1);
        if (escaped !== v) add(escaped, name);
      };
      for (const v of Object.values(apiConfigOf(raw).headers ?? {})) {
        both(v);
        const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(v.trim());
        if (basic) {
          both(basic[1]!);
          const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
          if (decoded.includes(":")) both(decoded.slice(decoded.indexOf(":") + 1));
        }
      }
    }
    for (const v of isFileValue(raw) ? [raw, fileContent(raw)] : [raw]) {
      add(v, name);
      add(v.trim(), name);
      const escaped = JSON.stringify(v).slice(1, -1);
      if (escaped !== v) add(escaped, name);
      if (/\r?\n/.test(v.trim())) {
        for (const line of v.split(/\r?\n/)) {
          const l = line.trim();
          if (l.length >= 16) add(l, name);
        }
      }
    }
  }
  return [...out.entries()].sort((a, b) => b[0].length - a[0].length);
}

// A private key's whole block — scan.ts names a key header and leaves the
// body, which is right for a finding and wrong for a stored output.
// Unterminated too: a key cut short, or printed without its END line, is
// masked to the end of the text.
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$(?![\s\S]))/g;

/** Masked, then cut to the cap. */
export function maskCall(text: string, redactSecrets: (text: string) => string): { text: string; cut: boolean } {
  const masked = redactText(redactSecrets(text)).replace(PRIVATE_KEY, "[redacted:private key]");
  return masked.length > CAPTURE_CAP ? { text: masked.slice(0, CAPTURE_CAP), cut: true } : { text: masked, cut: false };
}

export function recordCallIo(
  workspaceRoot: string,
  runId: string,
  callId: string,
  tool: string,
  io: CallIo,
  /** The step's own scrub: its resolved secret values → `[redacted:NAME]`. */
  redactSecrets: (text: string) => string,
): boolean {
  try {
    const input = io.input === undefined ? null : maskCall(io.input, redactSecrets);
    const output = io.output === undefined ? null : maskCall(io.output, redactSecrets);
    writeCapturedCall(workspaceRoot, runId, {
      id: callId,
      tool,
      // Which part was cut, each on its own: in the sandbox (the whole was
      // longer than what was sent) or here, after masking.
      ...(input ? { input: input.text, ...(io.inputChars !== undefined ? { inputChars: io.inputChars } : {}), ...(input.cut || (io.inputChars ?? 0) > io.input!.length ? { inputCut: true } : {}) } : {}),
      ...(output ? { output: output.text, ...(io.outputChars !== undefined ? { outputChars: io.outputChars } : {}), ...(output.cut || (io.outputChars ?? 0) > io.output!.length ? { outputCut: true } : {}) } : {}),
      ...(io.truncated || input?.cut || output?.cut ? { truncated: true } : {}),
    });
    return true;
  } catch (err) {
    console.error(`[capture] ${tool} (${callId}) for ${runId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
