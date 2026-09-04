// The list search rule: every word must appear, any order, any case; the
// URL form drops the page and the empty query.

import test from "node:test";
import assert from "node:assert/strict";
import { matchesQuery, filterByQuery, withQuery } from "../web/components/list-search-model.ts";

test("every term must appear, in any order and case", () => {
  assert.equal(matchesQuery("Leads enricher · haiku · verify_email", "enricher haiku"), true);
  assert.equal(matchesQuery("Leads enricher · haiku", "HAIKU leads"), true);
  assert.equal(matchesQuery("Leads enricher · haiku", "enricher sonnet"), false);
  assert.equal(matchesQuery("anything", "   "), true);
});

test("filterByQuery keeps the array when the query is blank", () => {
  const rows = [{ n: "writer" }, { n: "checker" }];
  assert.equal(filterByQuery(rows, "", (r) => r.n), rows);
  assert.deepEqual(filterByQuery(rows, "check", (r) => r.n), [{ n: "checker" }]);
});

test("withQuery sets q, drops the page, keeps the rest, and clears cleanly", () => {
  assert.equal(withQuery("kind=tools&page=3&tenant=acme", "sql "), "?kind=tools&tenant=acme&q=sql");
  assert.equal(withQuery("?q=old&page=2", ""), "");
  assert.equal(withQuery("", "x y"), "?q=x+y");
});
