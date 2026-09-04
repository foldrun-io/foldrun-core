// The evaluator loop's exit condition.
//
// `until: APPROVED` used to be a substring test, so a reviewer writing
// "APPROVED once the tribunal sentence is corrected" ended the loop with the
// correction unmade. That is not a hypothetical: a factual error rode a
// conditional approval past a review gate and was caught two steps later by a
// publisher that should never have seen it. The marker now has to stand on a
// line of its own — something a model does deliberately and cannot do by
// accident mid-sentence.
//
//   node --test tests/until-marker.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { saysUntilMarker } from "../packages/core/src/runner.ts";

test("a bare marker on its own line passes", () => {
  assert.equal(saysUntilMarker("Looks good to me.\nAPPROVED", "APPROVED"), true);
  assert.equal(saysUntilMarker("APPROVED\n\nNotes: tighten the intro.", "APPROVED"), true);
});

test("case and trailing punctuation do not matter", () => {
  assert.equal(saysUntilMarker("approved", "APPROVED"), true);
  assert.equal(saysUntilMarker("**APPROVED.**", "APPROVED"), true);
  assert.equal(saysUntilMarker("  Approved  ", "APPROVED"), true);
});

// The regression. Each of these contains the word and is not an approval.
test("a conditional approval does NOT pass", () => {
  for (const conditional of [
    "APPROVED once the two NSW tribunal sentences are corrected.",
    "Approved if you fix line 90.",
    "This is approved after the citation is replaced.",
    "I would have APPROVED it, but the date is wrong.",
    "Not approved.",
  ]) {
    assert.equal(saysUntilMarker(conditional, "APPROVED"), false, conditional);
  }
});

test("an empty or missing result never passes", () => {
  assert.equal(saysUntilMarker(null, "APPROVED"), false);
  assert.equal(saysUntilMarker("", "APPROVED"), false);
});

// A marker that is itself empty means the author asked for no condition.
test("an empty marker is not a gate", () => {
  assert.equal(saysUntilMarker("anything", "  "), true);
});
