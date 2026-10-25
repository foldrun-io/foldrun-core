// Frontmatter edited as text, where it is written: at the top or inside one
// of the four job blocks. No node imports — the flow canvas (flow-patterns.ts)
// runs in the browser and edits frontmatter with it too.

/** A block header on its own line — an anchor and a trailing `# comment`
 *  allowed. */
const JOB_BLOCK = /^["']?(governance|guardrail|observability|evaluation)["']?\s*:\s*(&\S+\s*)?(#.*)?$/;
/** Any other block header: an inline map, an alias, a tag — a form these
 *  writers do not edit. */
const JOB_OTHER = /^["']?(governance|guardrail|observability|evaluation)["']?\s*:\s*\S/;
/** An inline map closed on its own line: `guardrail: {network: [a.com]}`. */
const JOB_ONE_LINE = /^["']?(governance|guardrail|observability|evaluation)["']?\s*:\s*\{.*\}\s*(#.*)?$/;

const indentOf = (l: string) => l.match(/^[ \t]*/)?.[0].length ?? 0;

export interface KeySpan {
  /** The key's line. */
  at: number;
  /** One past its last line. */
  end: number;
  /** What its line starts with. */
  indent: string;
  /** The block header's line, when it is inside one. */
  block: number | null;
}

/** Thrown for a key a writer cannot edit in place: one that is, or may be,
 *  inside a block not written one key per line (`guardrail: {…}`, an alias).
 *  Rewriting it would mean re-serialising the person's YAML, and adding the
 *  key at the top beside it would be a config/conflict — so the writer says
 *  what to write instead. */
export class InlineBlockError extends Error {
  status = 409;
  constructor(key: string, block: string) {
    super(`\`${key}\` may be inside \`${block}:\`, which is not written one key per line — write \`${block}:\` one key per line to change it here, or edit the file`);
  }
}

/** A comment or blank line: neither ends a block nor is one of its keys. */
const filler = (l: string) => l.trim() === "" || /^\s*#/.test(l);

/**
 * Where a key is written in frontmatter lines: at the top, or a direct child
 * of one of the four job blocks (`guardrail:` and so on). Every writer that
 * edits a key as text reads it here, so a file written in blocks is edited
 * where it is — never given a second, flat copy that check would refuse as
 * config/conflict. A key inside an inline block map throws InlineBlockError.
 */
export function keySpan(lines: string[], key: string): KeySpan | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const span = (at: number, indent: string, block: number | null): KeySpan => {
    let end = at + 1;
    // The key continues while lines are indented deeper, are an item of its
    // list written at its own indent (YAML allows `key:\n- a`), or are blank
    // lines and comments inside it.
    while (
      end < lines.length &&
      (filler(lines[end]) ||
        indentOf(lines[end]) > indent.length ||
        (indentOf(lines[end]) === indent.length && /^[ \t]*-(\s|$)/.test(lines[end])))
    ) end++;
    // Blank lines and comments at its foot, no deeper than the key, belong
    // to what follows.
    while (end > at + 1 && filler(lines[end - 1]) && (lines[end - 1].trim() === "" || indentOf(lines[end - 1]) <= indent.length)) end--;
    return { at, end, indent, block };
  };
  // A key may be quoted: `"network": none`.
  const named = `["']?${k}["']?\\s*:`;
  const top = lines.findIndex((l) => new RegExp(`^${named}`).test(l));
  if (top !== -1) return span(top, "", null);
  for (let h = 0; h < lines.length; h++) {
    const other = !JOB_BLOCK.test(lines[h]) && JOB_OTHER.exec(lines[h]);
    if (other) {
      // One closed line can be read: refuse only if the key is in it. Any
      // other form (a map over several lines, an alias) cannot be, so any
      // key not found at the top is refused rather than added beside it.
      if (!JOB_ONE_LINE.test(lines[h]) || new RegExp(`[{,]\\s*${named}`).test(lines[h])) throw new InlineBlockError(key, other[1]!);
      continue;
    }
    if (!JOB_BLOCK.test(lines[h])) continue;
    // Its children sit at the indent of its first indented line; a deeper
    // line of the same name belongs to one of them, not to the block.
    // Comments and blank lines, indented or not, do not end it.
    let child = -1;
    let merged = false;
    for (let n = h + 1; n < lines.length && (/^[ \t]/.test(lines[n]) || filler(lines[n])); n++) {
      if (filler(lines[n])) continue;
      if (child === -1) child = indentOf(lines[n]);
      if (indentOf(lines[n]) !== child) continue;
      const m = new RegExp(`^([ \t]+)${named}`).exec(lines[n]);
      if (m) return span(n, m[1]!, h);
      if (/^[ \t]+<<\s*:/.test(lines[n])) merged = true;
    }
    // `<<: *policy` may bring the key in from elsewhere: not one this text
    // edit can see, so it is refused rather than added beside it.
    if (merged) throw new InlineBlockError(key, JOB_BLOCK.exec(lines[h])![1]!);
  }
  return null;
}

/** A block header left with nothing under it is removed with its last key.
 *  Blank lines and comments between it and its next key do not count as
 *  nothing: the header stays while any indented key follows them. */
export function dropEmptyBlock(lines: string[], header: number): string[] {
  let n = header + 1;
  while (n < lines.length && filler(lines[n])) n++;
  const next = lines[n];
  return next === undefined || !/^[ \t]+\S/.test(next) ? [...lines.slice(0, header), ...lines.slice(header + 1)] : lines;
}
