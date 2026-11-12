// An in-memory RecordsPort — the reference the contract suite is first run
// against, so the suite is known to describe the port and not Postgres.

import type { RecordsPort } from "../src/records.ts";
import type { RunRecord, RunSummary } from "../src/store.ts";
import type { TriggerEvent } from "../src/trigger-log.ts";
import type { FileRecord } from "../src/storage.ts";

interface Row {
  run: RunRecord;
  summary: RunSummary;
  live: boolean;
  stamp: number;
}

export function fakeRecords(): RecordsPort & { fenced: string[] } {
  const runs = new Map<string, Row>(); // tenant\0ws\0id
  const triggers = new Map<string, TriggerEvent[]>();
  const files = new Map<string, Map<string, FileRecord>>();
  const locks = new Map<string, Promise<unknown>>();
  let tick = 0; // two writes in one microsecond still differ
  const k = (t: string, w: string, id = "") => `${t}\0${w}\0${id}`;
  const inWs = (t: string, w: string) => [...runs.entries()].filter(([key]) => key.startsWith(k(t, w))).map(([, r]) => r);
  const newest = (a: Row, b: Row) => b.run.startedAt.localeCompare(a.run.startedAt) || b.run.id.localeCompare(a.run.id);
  const move = <V>(m: Map<string, V>, t: string, from: string, to: string) => {
    for (const key of [...m.keys()]) {
      if (!key.startsWith(k(t, from))) continue;
      m.set(key.replace(k(t, from), k(t, to)), m.get(key)!);
      m.delete(key);
    }
  };
  const steps = new Map<string, unknown>();
  const sk = (t: string, w: string, run: string, kind: string, ref: string) => `${k(t, w, run)}\0${kind}\0${ref}`;
  const fenced: string[] = [];
  // A workspace's small state (DocsPort): documents by kind and key, logs by kind.
  const docs = new Map<string, { data: unknown; at: number }>();
  const logs = new Map<string, { id: string; data: unknown }[]>();
  let logSeq = 0;
  const dk = (t: string, w: string, kind: string, key = "") => `${k(t, w)}${kind}\0${key}`;
  const lk = (t: string, w: string, kind: string) => `${k(t, w)}${kind}`;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const syncPort = {
    runGet: (t: string, w: string, id: string) => (runs.has(k(t, w, id)) ? structuredClone(runs.get(k(t, w, id))!.run) : null),
    runSummaries: (t: string, w: string) => inWs(t, w).sort(newest).map((r) => structuredClone(r.summary)),
    runLive: (t: string, w: string) => inWs(t, w).filter((r) => r.live).sort(newest).map((r) => structuredClone(r.run)),
  };
  return {
    fenced,
    stepStateOn: () => true,
    docsOn: () => true,
    docs: {
      get: (t, w, kind, key) => (docs.has(dk(t, w, kind, key)) ? structuredClone(docs.get(dk(t, w, kind, key))!.data) : undefined),
      put: (t, w, kind, key, data) => void docs.set(dk(t, w, kind, key), { data: structuredClone(data), at: Date.now() }),
      merge(t, w, kind, key, patch) {
        docs.set(dk(t, w, kind, key), { data: { ...obj(docs.get(dk(t, w, kind, key))?.data), ...structuredClone(patch) }, at: Date.now() });
      },
      raise(t, w, kind, key, field, atLeast, patch) {
        const prev = obj(docs.get(dk(t, w, kind, key))?.data);
        const next = Math.max(Number(prev[field] ?? 0) + 1, atLeast, 1);
        docs.set(dk(t, w, kind, key), { data: { ...prev, ...structuredClone(patch), [field]: next }, at: Date.now() });
        return next;
      },
      claim(t, w, kind, key, data, staleMs) {
        const prev = docs.get(dk(t, w, kind, key));
        if (prev && Date.now() - prev.at < staleMs) return false;
        docs.set(dk(t, w, kind, key), { data: structuredClone(data), at: Date.now() });
        return true;
      },
      drop(t, w, kind, key) {
        for (const id of [...docs.keys()]) if (key === null ? id.startsWith(dk(t, w, kind)) : id === dk(t, w, kind, key)) docs.delete(id);
      },
      dropPrefix(t, w, kind, prefix) {
        for (const id of [...docs.keys()]) if (id.startsWith(dk(t, w, kind, prefix))) docs.delete(id);
      },
      list: (t, w, kind) =>
        [...docs.entries()]
          .filter(([id]) => id.startsWith(dk(t, w, kind)))
          .map(([id, v]) => ({ key: id.slice(dk(t, w, kind).length), data: structuredClone(v.data) }))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      append(t, w, kind, data, keep) {
        const log = logs.get(lk(t, w, kind)) ?? [];
        log.push({ id: String(++logSeq), data: structuredClone(data) });
        logs.set(lk(t, w, kind), keep > 0 ? log.slice(-keep) : log);
      },
      tail: (t, w, kind, limit) => structuredClone([...(logs.get(lk(t, w, kind)) ?? [])].reverse().slice(0, limit)),
      replace(t, w, kind, id, data) {
        const row = (logs.get(lk(t, w, kind)) ?? []).find((r) => r.id === id);
        if (row) row.data = structuredClone(data);
      },
      prune(t, w, kind, ids) {
        logs.set(lk(t, w, kind), (logs.get(lk(t, w, kind)) ?? []).filter((r) => !ids.includes(r.id)));
      },
    },
    async: {
      stepGet: async (t, w, run, kind, ref) => (steps.has(sk(t, w, run, kind, ref)) ? structuredClone(steps.get(sk(t, w, run, kind, ref))) : undefined),
      stepPut: async (t, w, run, kind, ref, data) => void steps.set(sk(t, w, run, kind, ref), structuredClone(data)),
      stepDrop: async (t, w, run, kind, ref) => {
        const p = `${k(t, w, run)}\0${kind}\0`;
        for (const key of [...steps.keys()]) if (key.startsWith(p) && (ref === null || key === p + ref)) steps.delete(key);
      },
      runGet: async (t, w, id) => syncPort.runGet(t, w, id),
      runSummaries: async (t, w) => syncPort.runSummaries(t, w),
      runLive: async (t, w) => syncPort.runLive(t, w),
      runPut: async (t, w, run, summary, live) => void runs.set(k(t, w, run.id), { run: structuredClone(run), summary: structuredClone(summary), live, stamp: Date.now() * 1000 + tick++ }),
    },
    runPut: (t, w, run, summary, live) => void runs.set(k(t, w, run.id), { run: structuredClone(run), summary: structuredClone(summary), live, stamp: Date.now() * 1000 + tick++ }),
    runGet: (t, w, id) => (runs.has(k(t, w, id)) ? structuredClone(runs.get(k(t, w, id))!.run) : null),
    runDelete(t, w, id) {
      for (const key of [...steps.keys()]) if (key.startsWith(`${k(t, w, id)}\0`)) steps.delete(key);
      return runs.delete(k(t, w, id));
    },
    runSummaries: (t, w) => inWs(t, w).sort(newest).map((r) => structuredClone(r.summary)),
    runLive: (t, w) => inWs(t, w).filter((r) => r.live).sort(newest).map((r) => structuredClone(r.run)),
    runCount: (t, w) => inWs(t, w).length,
    runCounts(t) {
      const out: Record<string, number> = {};
      for (const key of runs.keys()) {
        const [tenant, ws] = key.split("\0");
        if (tenant === t) out[ws] = (out[ws] ?? 0) + 1;
      }
      return out;
    },
    runAll: (t, w) => inWs(t, w).sort(newest).map((r) => structuredClone(r.run)),
    runRecent: (t, w, flow, limit) => inWs(t, w).filter((r) => r.run.flow === flow).sort(newest).slice(0, limit).map((r) => structuredClone(r.run)),
    runsSince: (t, w, ms) => inWs(t, w).filter((r) => Date.parse(r.run.startedAt) >= ms).sort(newest).map((r) => structuredClone(r.run)),
    runsInContext: (t, w, key, before, test, limit) =>
      inWs(t, w)
        .filter((r) => r.summary.context?.key === key && (r.run.status === "completed" || r.run.status === "failed") && r.run.startedAt < before && !!r.run.finishedAt && r.run.finishedAt <= before && (r.run.test === true) === test)
        .sort(newest)
        .slice(0, limit)
        .map((r) => structuredClone(r.run)),
    openRunsOfCustomer: (t, customer) => [...runs.entries()].filter(([key, r]) => key.startsWith(`${t}\0`) && r.live && r.summary.customer === customer).length,
    runStamp: (t, w, id) => runs.get(k(t, w, id))?.stamp ?? null,
    triggerAppend(t, w, e) {
      const l = triggers.get(k(t, w)) ?? [];
      l.push(structuredClone(e));
      triggers.set(k(t, w), l.slice(-500));
    },
    triggerRead: (t, w, limit) => (triggers.get(k(t, w)) ?? []).slice(-limit).reverse(),
    fileList: (t, w) => [...(files.get(k(t, w))?.values() ?? [])].map((f) => ({ ...f })),
    filePut(t, w, f) {
      const m = files.get(k(t, w)) ?? new Map();
      m.set(f.path, { ...f });
      files.set(k(t, w), m);
    },
    fileDelete: (t, w, p) => files.get(k(t, w))?.delete(p) ?? false,
    workspaceDrop(t, w) {
      for (const key of [...runs.keys()]) if (key.startsWith(k(t, w))) runs.delete(key);
      triggers.delete(k(t, w));
      files.delete(k(t, w));
      for (const key of [...steps.keys()]) if (key.startsWith(k(t, w))) steps.delete(key);
      for (const key of [...docs.keys()]) if (key.startsWith(k(t, w))) docs.delete(key);
      for (const key of [...logs.keys()]) if (key.startsWith(k(t, w))) logs.delete(key);
    },
    workspaceMove(t, from, to) {
      move(runs, t, from, to);
      move(triggers, t, from, to);
      move(steps, t, from, to);
      move(docs, t, from, to);
      move(logs, t, from, to);
    },
    fileMove(t, from, to) {
      move(files, t, from, to);
    },
    async lock(name, fn) {
      const prev = locks.get(name) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => {
        fenced.push(name);
        return fn();
      });
      locks.set(name, run);
      try {
        return await run;
      } finally {
        if (locks.get(name) === run) locks.delete(name);
      }
    },
  };
}
