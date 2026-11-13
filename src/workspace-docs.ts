// Where a workspace's small state lives (FOL-126): rows through the records
// port when the platform registered one that has them, the folder otherwise.
//
// Two answers, because a switch must never lose what is already written:
// `docStore` is where a WRITE goes (rows only while `records.docs_store` is
// on), `docRows` is what a READ also asks (rows whenever the port has them,
// on or off). Every caller reads both places and keeps the newer; nothing is
// copied between them.

import { records, type DocsPort } from "./records.ts";

/** Rows to read: the port's, whatever the switch says. Null on a laptop, the
 *  CLI, and for a workspace whose records are still files. */
export function docRows(tenant: string, workspace: string): DocsPort | null {
  return records(tenant, workspace)?.docs ?? null;
}

/** Rows to write to, or null: write the folder. */
export function docStore(tenant: string, workspace: string): DocsPort | null {
  const port = records(tenant, workspace);
  if (!port?.docs || !port.docsOn?.()) return null;
  return port.docs;
}

/** A read that must not take the caller down with the database: these are
 *  logs and markers beside the work, never the work. */
export function quietly<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
