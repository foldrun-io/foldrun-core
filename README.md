# @foldrun/core

The runtime behind the [`foldrun`](https://www.npmjs.com/package/foldrun) CLI:
the code that reads a folder of markdown as agents, flows, tools, skills,
knowledge and evals, then runs it.

Most people want the CLI, not this package:

```sh
npm install -g foldrun
```

Install `@foldrun/core` directly only if you are embedding the runtime — a
server that runs workspaces, a test harness, a different front end.

```sh
npm install @foldrun/core
```

```js
import { listAgents, listFlows, workspaceTools, missingToolPrograms } from "@foldrun/core";
```

What it exposes, broadly: parsing and validating a workspace (`listAgents`,
`listFlows`, `workspaceTools`, `parseToolDef`), running one (`runner`),
evaluating it (`evals`), the account library and secret vault, the file store,
the queue and scheduler, and the checks the CLI reports.

The format itself — every frontmatter field, the flow grammar and where it
deliberately stops — is specified in `SPEC.md` alongside the source, not here.
This package's job is to implement it.

Requires Node 22 or newer. Apache-2.0.
