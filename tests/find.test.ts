// The Find palette's ranking: what a query matches, in what order, under
// which heading. The server search and the palette share these rules.

import test from "node:test";
import assert from "node:assert/strict";
import { scoreHit, rank, groupHits, pagesFor, type FindHit } from "../web/components/find-model.ts";

const hit = (kind: FindHit["kind"], title: string, subtitle?: string): FindHit => ({ kind, title, subtitle, href: "#" });

test("a title prefix outranks a title substring, which outranks a subtitle match", () => {
  assert.ok(scoreHit("lead", "leads-desk") > scoreHit("lead", "seo-leads"));
  assert.ok(scoreHit("lead", "seo-leads") > scoreHit("lead", "writer", "writes lead paragraphs"));
  assert.equal(scoreHit("lead", "writer", "nothing here"), 0);
});

test("an exact title wins; a word-start substring beats a buried one", () => {
  assert.ok(scoreHit("desk", "desk") > scoreHit("desk", "desk-two"));
  assert.ok(scoreHit("desk", "leads-desk") > scoreHit("desk", "mydesk"));
  // A prefix is still the stronger claim.
  assert.ok(scoreHit("desk", "deskless") > scoreHit("desk", "leads-desk"));
});

test("a subsequence is the floor: found, never ahead of a real match", () => {
  assert.ok(scoreHit("ldsk", "leads-desk") > 0);
  assert.ok(scoreHit("ldsk", "leads-desk") < scoreHit("ldsk", "ldsk-tools"));
  // Two characters is too short to guess with.
  assert.equal(scoreHit("lk", "leads-desk"), 0);
});

test("an empty query matches everything at one weight", () => {
  assert.equal(scoreHit("", "anything"), 1);
  assert.equal(scoreHit("   ", "anything"), 1);
});

test("rank drops misses, orders best first, and caps each heading", () => {
  const hits = [
    hit("agent", "writer"),
    hit("agent", "checker", "checks the writer's draft"),
    hit("flow", "weekly"),
    ...Array.from({ length: 9 }, (_, i) => hit("run", `writer-run-${i}`)),
  ];
  const out = rank(hits, "writer", 3);
  assert.equal(out[0].title, "writer");
  assert.equal(out.filter((h) => h.kind === "run").length, 3);
  assert.ok(out.some((h) => h.title === "checker"));
  assert.equal(out.some((h) => h.title === "weekly"), false);
  // The subtitle-only match sits behind every title match.
  assert.equal(out.at(-1)?.title, "checker");
});

test("groups follow the heading order and skip empty headings", () => {
  const groups = groupHits([hit("run", "r"), hit("workspace", "w"), hit("page", "p")]);
  assert.deepEqual(groups.map((g) => g.kind), ["workspace", "run", "page"]);
  assert.equal(groups[0].label, "Workspaces");
});

test("pages carry the tenant query on every link, and a workspace's pages come first", () => {
  const pages = pagesFor("leads", "tenant=acme");
  assert.ok(pages[0].title.startsWith("leads ·"));
  assert.ok(pages.every((p) => p.href.includes("tenant=acme")));
  assert.ok(pages.some((p) => p.href === "/dashboard/leads/assets?kind=tools&tenant=acme"));
  assert.ok(pagesFor(null, "").every((p) => !p.href.includes("?tenant")));
});
