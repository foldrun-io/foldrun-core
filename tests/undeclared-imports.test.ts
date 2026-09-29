// `foldrun check` warns when a tool's program imports a package nothing
// declares — the tool that runs on the laptop that happens to have openpyxl
// and dies on its first platform call.
//
//   node --test tests/undeclared-imports.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importNamesOf, nodeImports, pythonImports, undeclaredImports } from "../src/tool-programs.ts";

function withWorkspace(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imports-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, "acme/workspaces/desk", rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const tool = (name: string, run: string, extra = "") =>
  `---\ntransport: script\nname: ${name}\nrun: ${run}\ninterpreter: python3\ndescription: x\n${extra}---\n`;

test("python imports are read as top-level modules; relative ones are skipped", () => {
  const src = [
    "import os, sys as system",
    "import openpyxl.styles",
    "from bs4 import BeautifulSoup",
    "from . import sibling",
    "from .pkg import thing",
    "    import yaml  # inside a function",
    "x = 'import notreal'",
  ].join("\n");
  assert.deepEqual(pythonImports(src).sort(), ["bs4", "openpyxl", "os", "sys", "yaml"]);
});

test("node imports and requires, minus relative paths and node: builtins", () => {
  const src = `import sharp from "sharp";\nimport { x } from "./local.mjs";\nimport fs from "node:fs";\nconst a = require("@scope/pkg/sub");\nconst b = await import("lodash/fp");`;
  assert.deepEqual(nodeImports(src).sort(), ["@scope/pkg", "lodash", "sharp"]);
});

test("a distribution's import name, including the ones that differ", () => {
  assert.deepEqual(importNamesOf("openpyxl>=3"), ["openpyxl"]);
  assert.deepEqual(importNamesOf("beautifulsoup4"), ["bs4"]);
  assert.deepEqual(importNamesOf("Pillow==10"), ["PIL"]);
  assert.deepEqual(importNamesOf("python-dateutil"), ["dateutil"]);
});

test("the strata-desk case: a tool importing openpyxl with nothing declared is named", () => {
  withWorkspace(
    {
      "tools/build-xlsx.md": tool("build_xlsx", "workspace/scripts/build_xlsx.py"),
      "scripts/build_xlsx.py": "import os\nimport strata_lib\nfrom openpyxl import Workbook\n",
      "scripts/strata_lib.py": "import json\n",
    },
    () => {
      const found = undeclaredImports("acme", "desk");
      assert.deepEqual(found.map((f) => [f.name, f.modules]), [["build_xlsx", ["openpyxl"]]]);
      assert.equal(found[0].language, "python");
    },
  );
});

test("declared anywhere that reaches the tool — tool.md, requirements.txt, an agent, AGENTS.md — is enough", () => {
  const program = "from openpyxl import Workbook\nimport yaml\nimport requests\nimport bs4\n";
  withWorkspace(
    {
      "AGENTS.md": "---\nruntime:\n  packages: [requests]\n---\n",
      "agents/a/agent.md": "---\nname: a\nruntime:\n  packages: [beautifulsoup4]\n---\nx\n",
      "tools/sheet/tool.md": tool("sheet", "run.py", "runtime:\n  packages: [openpyxl]\n"),
      "tools/sheet/run.py": program,
      "tools/sheet/requirements.txt": "pyyaml\n",
    },
    () => assert.deepEqual(undeclaredImports("acme", "desk"), []),
  );
});

test("node: an undeclared package is named; the image's own modules and declared ones are not", () => {
  withWorkspace(
    {
      "tools/img/tool.md": "---\ntransport: script\nname: img\nrun: run.mjs\ndescription: x\nruntime:\n  npm: [sharp@^0.33]\n---\n",
      "tools/img/run.mjs": `import sharp from "sharp";\nimport { chromium } from "playwright";\nimport got from "got";\nimport fs from "node:fs";\nimport path from "path";\n`,
    },
    () => assert.deepEqual(undeclaredImports("acme", "desk").map((f) => f.modules), [["got"]]),
  );
});
