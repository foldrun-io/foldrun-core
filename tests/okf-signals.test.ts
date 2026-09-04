// Do the v0.2 decision signals reach the point of decision?
//
// v0.1 frontmatter described a concept — what it is, what it points at. v0.2
// adds fields you use to decide something about a concept *before* reading it:
// who produced it, whether it has been verified, whether it is still current.
// The argument for putting them in frontmatter is that most interactions never
// reach the body, so relevance and trust have to be judgeable cheaply.
//
// That argument only holds if the signals survive as far as the index. They
// did not. `generated` was parsed into OkfDoc and surfaced nowhere, and the
// only trust mark emitted was the negative one — so a fact an agent invented
// and a note a person had reviewed were rendered identically, and the
// distinction the field exists to make was unavailable exactly where a
// consumer makes it.
//
//   node --test tests/okf-signals.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import {
  buildIndex, readBundle, provenanceMarks, stampGenerated, PRODUCER, UNKNOWN_ACTOR,
  dateIssues, conformanceIssues, stampBundle,
} from "../packages/core/src/okf.ts";
import { buildMemoryIndex } from "../packages/core/src/store.ts";

function withBundle(files: Record<string, string>, run: (dir: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-signals-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** What an agent wrote during a run — stampGenerated's output shape. */
const AGENT_WRITTEN = `---
type: Fact
title: Q3 revenue
generated:
  by: foldrun/0.1.0
---

Revenue was 4.2M.
`;

/** What a person wrote and a person checked. */
const HUMAN_REVIEWED = `---
type: Fact
title: Pricing
generated:
  by: human:matt
verified:
  - by: human:matt
---

Base price is 400.
`;

/** Written by an agent, then confirmed by a script rather than a person. */
const MACHINE_CONFIRMED = `---
type: Fact
title: Row count
generated:
  by: foldrun/0.1.0
verified:
  - by: process:checker
---

11,402 rows.
`;

const line = (index: string, title: string) =>
  index.split("\n").find((l) => l.includes(title)) ?? "";

// The regression, stated at the level that matters: not "is the field parsed"
// but "can a consumer tell these apart without opening either file".
test("an agent's invention and a person's reviewed note are distinguishable in the index", () => {
  withBundle({ "memory/q3.md": AGENT_WRITTEN, "memory/pricing.md": HUMAN_REVIEWED }, (root) => {
    const dir = path.join(root, "memory");
    const index = buildIndex(readBundle(dir), "Memory", true);

    const agent = line(index, "Q3 revenue");
    const human = line(index, "Pricing");

    assert.match(agent, /machine-written/);
    assert.match(agent, /unverified/);
    assert.doesNotMatch(human, /machine-written/);
    assert.match(human, /human-reviewed/);
    assert.notEqual(agent.replace("Q3 revenue", ""), human.replace("Pricing", ""));
  });
});

test("the same is true of the index a model reads mid-run", () => {
  withBundle({ "memory/q3.md": AGENT_WRITTEN, "memory/pricing.md": HUMAN_REVIEWED }, (root) => {
    const index = buildMemoryIndex(path.join(root, "memory")) ?? "";
    assert.match(line(index, "Q3 revenue"), /machine-written/);
    assert.match(line(index, "Pricing"), /human-reviewed/);
  });
});

// The three tiers have to be three visible states. Rendering two of them as
// silence is what made trust something you could only detect the absence of.
test("machine-confirmed is not rendered the same as human-reviewed", () => {
  withBundle({ "memory/rows.md": MACHINE_CONFIRMED, "memory/pricing.md": HUMAN_REVIEWED }, (root) => {
    const dir = path.join(root, "memory");
    const index = buildIndex(readBundle(dir), "Memory", true);
    assert.match(line(index, "Row count"), /machine-confirmed/);
    assert.match(line(index, "Pricing"), /human-reviewed/);
  });
});

test("every concept states a trust tier, so it can be filtered rather than inferred", () => {
  withBundle(
    { "memory/q3.md": AGENT_WRITTEN, "memory/pricing.md": HUMAN_REVIEWED, "memory/rows.md": MACHINE_CONFIRMED },
    (root) => {
      const dir = path.join(root, "memory");
      const index = buildIndex(readBundle(dir), "Memory", true);
      for (const title of ["Q3 revenue", "Pricing", "Row count"]) {
        assert.match(line(index, title), /unverified|machine-confirmed|human-reviewed/);
      }
    },
  );
});

// A person is the default assumption, and every mark is charged to a line whose
// job is to be cheap. Only the machine case earns one.
test("human authorship is not marked — silence means a person", () => {
  assert.deepEqual(provenanceMarks({ generatedBy: "human:matt", trust: "human-reviewed" }), [
    "human-reviewed",
  ]);
  assert.deepEqual(provenanceMarks({ generatedBy: null, trust: "unverified" }), ["unverified"]);
});

// "Reviewed" answers a weaker question than it appears to. Undated, a fact
// checked in 2019 and one checked last week render identically, so the tier
// says "did anyone ever look" while reading as "can I rely on this".
const VERIFIED_AT = (at: string) => `---
type: Fact
title: Margin
verified:
  - { by: human:kliu@acme, at: ${at} }
---

0.42
`;

test("a verification carries the date it happened", () => {
  withBundle({ "memory/m.md": VERIFIED_AT("2026-07-01T16:00:00Z") }, (root) => {
    const [doc] = readBundle(path.join(root, "memory"));
    assert.equal(doc.verifiedAt, "2026-07-01T16:00:00.000Z");
    assert.deepEqual(doc.verified, [{ by: "human:kliu@acme", at: "2026-07-01T16:00:00.000Z" }]);
  });
});

test("the date reaches the index, so recency is filterable", () => {
  withBundle({ "memory/recent.md": VERIFIED_AT("2026-07-01T16:00:00Z") }, (root) => {
    const dir = path.join(root, "memory");
    assert.match(line(buildIndex(readBundle(dir), "Memory", true), "Margin"), /human-reviewed 2026-07-01/);
  });
});

test("the newest verification wins when several are recorded", () => {
  withBundle(
    {
      "memory/m.md": `---
type: Fact
title: Margin
verified:
  - { by: process:checker, at: 2024-01-01T00:00:00Z }
  - { by: human:kliu@acme, at: 2026-07-01T16:00:00Z }
  - { by: process:checker, at: 2025-05-05T00:00:00Z }
---

0.42
`,
    },
    (root) => {
      const [doc] = readBundle(path.join(root, "memory"));
      assert.equal(doc.verifiedAt, "2026-07-01T16:00:00.000Z");
      assert.equal(doc.trust, "human-reviewed");
    },
  );
});

test("an undated verification still states the tier, without inventing a date", () => {
  withBundle(
    { "memory/u.md": "---\ntype: Fact\ntitle: Undated\nverified:\n  - by: human:matt\n---\n\nx\n" },
    (root) => {
      const dir = path.join(root, "memory");
      const [doc] = readBundle(dir);
      assert.equal(doc.verifiedAt, null);

      const l = line(buildIndex(readBundle(dir), "Memory", true), "Undated");
      assert.match(l, /human-reviewed/);
      assert.doesNotMatch(l, /\d{4}-\d{2}-\d{2}/);
    },
  );
});

test("`generated.at` is captured, and a v0.1 timestamp stands in for it", () => {
  withBundle(
    {
      "memory/new.md": "---\ntype: Fact\ntitle: New\ngenerated: { by: foldrun/0.1.0, at: 2026-06-30T14:00:00Z }\n---\n\nx\n",
      "memory/old.md": "---\ntype: Fact\ntitle: Old\ntimestamp: 2026-01-02\n---\n\nx\n",
    },
    (root) => {
      const docs = readBundle(path.join(root, "memory"));
      const byTitle = Object.fromEntries(docs.map((d) => [d.title, d]));
      assert.equal(byTitle.New.generatedAt, "2026-06-30T14:00:00.000Z");
      assert.equal(byTitle.Old.generatedAt, "2026-01-02T00:00:00.000Z");
    },
  );
});

test("a v0.1 document with no `generated` is not claimed to be machine-written", () => {
  withBundle({ "memory/old.md": "---\ntype: Fact\ntitle: Old\ntimestamp: 2026-01-02\n---\n\nA.\n" }, (root) => {
    const dir = path.join(root, "memory");
    const index = buildIndex(readBundle(dir), "Memory", true);
    assert.doesNotMatch(line(index, "Old"), /machine-written/);
  });
});

// "Is it still current" is the fourth decision signal, and it was being thrown
// away for the spelling the spec itself uses. YAML turns an unquoted
// 2026-12-31 into a Date; readDoc tested `typeof === "string"` and dropped it.
// The tests quoted their dates, so they agreed with the bug.
const DATED = (d: string) => `---
type: Fact
title: Prices
stale_after: ${d}
sources:
  - id: s
    resource: https://x.example/s
    last_modified: 2026-06-15
---

400.
`;

test("an unquoted stale_after is honoured — the spec writes them unquoted", () => {
  withBundle({ "memory/p.md": DATED("2026-12-31") }, (root) => {
    const [doc] = readBundle(path.join(root, "memory"), new Date("2027-01-05"));
    assert.equal(doc.staleAfter, "2026-12-31");
    assert.equal(doc.stale, true, "past its stale_after and not marked stale");
  });
});

test("a quoted stale_after still works", () => {
  withBundle({ "memory/p.md": DATED('"2026-12-31"') }, (root) => {
    const [doc] = readBundle(path.join(root, "memory"), new Date("2027-01-05"));
    assert.equal(doc.staleAfter, "2026-12-31");
    assert.equal(doc.stale, true);
  });
});

test("a document still inside its window is not stale", () => {
  withBundle({ "memory/p.md": DATED("2026-12-31") }, (root) => {
    const [doc] = readBundle(path.join(root, "memory"), new Date("2026-08-01"));
    assert.equal(doc.stale, false);
  });
});

test("a source's last_modified is an ISO day, not a stringified Date", () => {
  withBundle({ "memory/p.md": DATED("2026-12-31") }, (root) => {
    const [doc] = readBundle(path.join(root, "memory"));
    assert.equal(doc.sources[0].lastModified, "2026-06-15");
  });
});

// Both index builders read one definition of the signals. They wrap different
// prose around it deliberately, but a signal added to one must not be missing
// from the other — that drift is what the whole class of bug here looks like.
test("both index builders agree about the signals", () => {
  withBundle({ "memory/q3.md": AGENT_WRITTEN }, (root) => {
    const dir = path.join(root, "memory");
    const onDisk = line(buildIndex(readBundle(dir), "Memory", true), "Q3 revenue");
    const inContext = line(buildMemoryIndex(dir) ?? "", "Q3 revenue");
    for (const mark of provenanceMarks(readBundle(dir)[0])) {
      assert.ok(onDisk.includes(mark), `on-disk index is missing "${mark}"`);
      assert.ok(inContext.includes(mark), `run-time index is missing "${mark}"`);
    }
  });
});

// §sources: an entry's own usage_window overrides the document's, and an entry
// without one inherits it. Only the entry's was read, so a window declared once
// at the top framed nothing — and both ends went through String(), which turns
// YAML's Date back into "Mon Jun 15 2026 10:00:00 GMT+1000".
test("a shared usage_window is inherited, and an entry's own overrides it", () => {
  withBundle(
    {
      "memory/s.md": `---
type: Fact
title: Traffic
usage_window: { from: 2026-01-01, to: 2026-06-30 }
sources:
  - id: inherits
    resource: https://x.example/a
    usage_count: 10
  - id: overrides
    resource: https://x.example/b
    usage_count: 20
    usage_window: { from: 2026-07-01, to: 2026-07-31 }
---

x
`,
    },
    (root) => {
      const [doc] = readBundle(path.join(root, "memory"));
      const by = Object.fromEntries(doc.sources.map((s) => [s.id, s]));
      assert.deepEqual(by.inherits.usageWindow, { from: "2026-01-01", to: "2026-06-30" });
      assert.deepEqual(by.overrides.usageWindow, { from: "2026-07-01", to: "2026-07-31" });
    },
  );
});

// The spec: "A single verifier MAY be written as one { by, at } mapping without
// the list dash. Consumers MUST treat a bare mapping as a one-element list."
test("a bare verified mapping is treated as a one-element list", () => {
  withBundle(
    { "memory/b.md": "---\ntype: Fact\ntitle: Bare\nverified: { by: human:matt, at: 2026-07-01T09:00:00Z }\n---\n\nx\n" },
    (root) => {
      const [doc] = readBundle(path.join(root, "memory"));
      assert.deepEqual(doc.verified, [{ by: "human:matt", at: "2026-07-01T09:00:00.000Z" }]);
      assert.equal(doc.trust, "human-reviewed");
    },
  );
});

// §7 defines three actor forms and only `human:` is a person. The mark used to
// test for a literal "producer/" prefix — but the producer's *name* is the
// first segment, so the spec's own reference_agent/gemini-2.5-pro missed,
// process: missed, and so did this platform's own PRODUCER. The feature fired
// for nothing that any producer actually writes.
test("every non-human actor form is recognised as machine-written", () => {
  for (const by of [
    "foldrun/0.1.0", // what stampGenerated writes
    "reference_agent/gemini-2.5-pro", // the spec's own example
    "process:finance-nightly", // §7's automated process
  ]) {
    assert.deepEqual(
      provenanceMarks({ generatedBy: by, trust: "unverified" }),
      ["machine-written", "unverified"],
      `${by} should read as machine-written`,
    );
  }
});

test("a person, and an unknown author, are not called machine-written", () => {
  assert.deepEqual(provenanceMarks({ generatedBy: "human:matt", trust: "unverified" }), ["unverified"]);
  // A v0.1 timestamp says when, never who — which is not the same as knowing
  // a machine did it.
  assert.deepEqual(provenanceMarks({ generatedBy: UNKNOWN_ACTOR, trust: "unverified" }), ["unverified"]);
});

test("what stampGenerated writes is what provenanceMarks recognises", () => {
  withBundle({ "memory/m.md": "---\ntype: Fact\ntitle: Learned\n---\n\nx\n" }, (root) => {
    const dir = path.join(root, "memory");
    assert.equal(stampGenerated(path.join(dir, "m.md"), "analyst"), true);
    const [doc] = readBundle(dir);
    assert.equal(doc.generatedBy, PRODUCER);
    assert.deepEqual(provenanceMarks(doc), ["machine-written", "unverified"]);
  });
});

// `at:` accepted anything. That matters because every use of these values is a
// comparison — `stale` is `today >= stale_after`, `latestAt` picks the newest
// verification with `>` — and both are string comparisons only meaningful on
// ISO. "yesterday" sorted above every real timestamp, since lowercase letters
// beat digits, so one sloppy value silently made "most recently verified"
// return the wrong entry and the index rendered "human-reviewed yesterday".
const AT = (at: string) => `---
type: Fact
title: Dated
verified:
  - { by: human:x, at: ${at} }
---

x
`;

test("an ISO instant and a bare day are both accepted, and normalised", () => {
  withBundle({ "memory/a.md": AT("2026-07-01T09:00:00Z") }, (root) => {
    assert.equal(readBundle(path.join(root, "memory"))[0].verifiedAt, "2026-07-01T09:00:00.000Z");
  });
  withBundle({ "memory/a.md": AT("2026-07-01") }, (root) => {
    assert.equal(readBundle(path.join(root, "memory"))[0].verifiedAt, "2026-07-01T00:00:00.000Z");
  });
});

test("a value that is not a date is dropped rather than compared", () => {
  for (const bad of ["yesterday", "01/07/2026", "July 1 2026"]) {
    withBundle({ "memory/a.md": AT(bad) }, (root) => {
      const [doc] = readBundle(path.join(root, "memory"));
      assert.equal(doc.verifiedAt, null, `${bad} must not become a comparable value`);
      // The tier still holds — who checked it is known even when the when is not.
      assert.equal(doc.trust, "human-reviewed");
    });
  }
});

test("a dropped date is reported, never swallowed", () => {
  withBundle({ "memory/a.md": AT("yesterday") }, (root) => {
    const issues = dateIssues(path.join(root, "memory"));
    assert.deepEqual(issues, [{ file: "a.md", field: "verified[0].at", value: "yesterday" }]);
  });
});

test("every date-bearing field is checked, at any depth", () => {
  withBundle(
    {
      "memory/deep/a.md": `---
type: Fact
title: Deep
stale_after: soon
generated: { by: human:x, at: whenever }
usage_window: { from: never, to: 2026-01-01 }
sources:
  - resource: https://x.example/a
    last_modified: recently
---

x
`,
    },
    (root) => {
      const fields = dateIssues(path.join(root, "memory")).map((i) => i.field).sort();
      assert.deepEqual(fields, [
        "generated.at",
        "sources[0].last_modified",
        "stale_after",
        "usage_window.from",
      ]);
    },
  );
});

// Conformance is the spec's three rules and nothing more. A bad date is still
// a conformant bundle — the spec says nothing about a date's shape — so the
// two questions stay in two functions.
test("an unusable date is not a conformance failure", () => {
  withBundle({ "memory/a.md": AT("yesterday") }, (root) => {
    assert.deepEqual(conformanceIssues(path.join(root, "memory")), []);
  });
});

// What an agent writes has to come out conformant without the agent knowing
// the format. The hook that does that walked one flat directory and excluded
// index.md by name — so it missed every concept in a nested section, skipped
// the workspace bundle entirely, and stamped log.md, writing a concept's
// frontmatter onto a reserved file §9 gives its own structure. Nothing
// reported the last one: a conformance check skips reserved names by
// definition, so the file is malformed only to the readers that parse it.
test("stamping covers a nested section and leaves reserved files alone", () => {
  withBundle(
    {
      "memory/flat.md": "# Learned\n\nA.\n",
      "memory/campaigns/nested.md": "# Learned\n\nB.\n",
      "memory/index.md": '---\nokf_version: "0.2"\n---\n\n# Memory\n',
      "memory/log.md": "# Log\n\n## 2026-08-01\n\n- **Creation** [flat](flat.md)\n",
    },
    (root) => {
      const dir = path.join(root, "memory");
      assert.deepEqual(stampBundle(dir, "writer").sort(), ["campaigns/nested.md", "flat.md"]);

      for (const rel of ["flat.md", "campaigns/nested.md"]) {
        const { data } = matter(fs.readFileSync(path.join(dir, rel), "utf8"));
        assert.equal(data.type, "Memory", `${rel} should be typed`);
        assert.equal((data.generated as { by: string }).by, PRODUCER);
        assert.equal((data.generated as { agent: string }).agent, "writer");
      }

      // The spec's two keep their own structure.
      assert.deepEqual(
        Object.keys(matter(fs.readFileSync(path.join(dir, "index.md"), "utf8")).data),
        ["okf_version"],
      );
      assert.deepEqual(
        Object.keys(matter(fs.readFileSync(path.join(dir, "log.md"), "utf8")).data),
        [],
        "log.md must not be given a concept's frontmatter",
      );
    },
  );
});

test("a claim the author already made is never overwritten", () => {
  withBundle(
    { "memory/mine.md": "---\ntype: Decision\ngenerated:\n  by: human:matt\n---\n\nA.\n" },
    (root) => {
      const dir = path.join(root, "memory");
      assert.deepEqual(stampBundle(dir, "writer"), []);
      const { data } = matter(fs.readFileSync(path.join(dir, "mine.md"), "utf8"));
      assert.equal((data.generated as { by: string }).by, "human:matt");
      assert.equal(data.type, "Decision");
    },
  );
});

// Attribution is dropped rather than guessed when a run had several agents and
// the file sits at workspace scope — any of them could have written it.
test("an unattributable write records the producer and no agent", () => {
  withBundle({ "memory/shared.md": "# Learned\n\nC.\n" }, (root) => {
    const dir = path.join(root, "memory");
    stampBundle(dir, null);
    const { data } = matter(fs.readFileSync(path.join(dir, "shared.md"), "utf8"));
    assert.equal((data.generated as { by: string }).by, PRODUCER);
    assert.ok(!("agent" in (data.generated as object)), "no agent should be invented");
    // Still machine-written for every reader.
    assert.deepEqual(provenanceMarks(readBundle(dir)[0]), ["machine-written", "unverified"]);
  });
});

// Models write `name:` whether or not you ask them to — a real run did it one
// line after being told to add no frontmatter at all. It reads fine here,
// because readDoc falls back to it, and reads as a slug to anyone else,
// because OKF defines no such field.
test("an agent's `name:` is moved to OKF's `title:` when stamped", () => {
  withBundle({ "memory/a.md": "---\nname: Rain gauge resolution\n---\n\nA.\n" }, (root) => {
    const dir = path.join(root, "memory");
    stampBundle(dir, "writer");

    const { data } = matter(fs.readFileSync(path.join(dir, "a.md"), "utf8"));
    assert.equal(data.title, "Rain gauge resolution");
    assert.ok(!("name" in data), "`name` is not a key the format defines");
    assert.equal(readBundle(dir)[0].title, "Rain gauge resolution");
  });
});

test("a title the author chose is never replaced by their name", () => {
  withBundle(
    { "memory/a.md": "---\nname: slug-ish\ntitle: The real one\n---\n\nA.\n" },
    (root) => {
      const dir = path.join(root, "memory");
      stampBundle(dir, "writer");
      const { data } = matter(fs.readFileSync(path.join(dir, "a.md"), "utf8"));
      assert.equal(data.title, "The real one");
    },
  );
});
