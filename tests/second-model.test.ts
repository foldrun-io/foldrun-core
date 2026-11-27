// tools: [debate, review] and second_model: (FOL-418): what the engine sends
// to foldrun's gateway, and what `foldrun check` says about the fields.
//
//   node --test tests/second-model.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { serverToolsOf } from "../src/engine-common.ts";
import { secondModelProblems, isRuntimeTool, isOwnToolRef, toolRefs, builtinToolNames, linkedToolNames } from "../src/tool-names.ts";
import { deployWarnings } from "../src/deploy.ts";

test("serverToolsOf: debate and review go only with a model, rebuilt from their known fields; the web tools as before", () => {
  assert.deepEqual(serverToolsOf([
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    { type: "foldrun_debate_20261127", name: "foldrun_debate", model: "openai/gpt-x", max_tokens: 2048, secret: "x", system: "do this" },
    { type: "foldrun_review_20261127", name: "foldrun_review" },
    { type: "foldrun_review_20261127", name: "foldrun_review", model: "gpt-x" },
    { type: "foldrun_review_x", name: "foldrun_review", model: "openai/gpt-x" },
    { type: "foldrun_debate_20261127", name: "debate", model: "openai/gpt-x" },
  ]), [
    { type: "web_search_20250305", name: "web_search", max_uses: 3 },
    { type: "foldrun_debate_20261127", name: "foldrun_debate", model: "openai/gpt-x", max_tokens: 2048 },
  ]);
});

test("debate and review are built-in names; [[review]] is still the author's own tool", () => {
  assert.ok(isRuntimeTool("debate") && isRuntimeTool("review"));
  const refs = toolRefs({ tools: ["review", "[[review]]"] });
  assert.deepEqual(refs.map(isOwnToolRef), [false, true]);
});

test("foldrun check: second_model and the two tools, as warnings", () => {
  assert.deepEqual(secondModelProblems({ tools: ["read"] }), []);
  assert.deepEqual(secondModelProblems({ tools: ["debate"], second_model: "openai/gpt-x" }), []);
  assert.match(secondModelProblems({ tools: ["debate", "review"] })[0]!, /needs second_model:/);
  assert.match(secondModelProblems({ tools: ["review"], second_model: "gpt-x" })[0]!, /written provider\/model/);
  assert.match(secondModelProblems({ tools: ["review"], second_model: "anthropic/claude-x", model: "anthropic/claude-y" })[0]!, /same provider as model:/);
  assert.match(secondModelProblems({ tools: ["read"], second_model: "openai/gpt-x" })[0]!, /does nothing/);
  assert.deepEqual(secondModelProblems({ tools: ["[[review]]"] }), [], "the author's own review tool asks for nothing");
  const w = deployWarnings([{ path: "agents/a/agent.md", content: "---\nname: a\ntools: [debate]\n---\n\nHi.\n" }]);
  assert.ok(w.some((x) => x.where === "agents/a/agent.md" && /needs second_model:/.test(x.message)), JSON.stringify(w));
});

test("builtinToolNames / linkedToolNames read a tools: value as the runtime does", () => {
  assert.deepEqual(builtinToolNames(["read", [["review"]], { Bash: "ask" }]), ["read", "Bash"]);
  assert.deepEqual(linkedToolNames(["read", [["review"]], "review"]), ["review"]);
  assert.deepEqual(builtinToolNames("Bash, review"), ["Bash", "review"]);
  assert.deepEqual(builtinToolNames("review"), ["review"]);
  assert.deepEqual(builtinToolNames(undefined), []);
});
