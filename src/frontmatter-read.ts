// The frontmatter of a markdown text, as the runtime reads it (store.ts readFrontmatter reads a file with the same
// parser). A light entry point for foldrun code, which must not load all of core to read one agent's fields (FOL-240).
import { configMatter } from "./matter.ts";

export function frontmatterOf(text: string): Record<string, unknown> {
  return (configMatter(text).data ?? {}) as Record<string, unknown>;
}
