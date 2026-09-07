# Security

## Reporting

Email **hello@foldrun.io** with "security" in the subject. Please do not open
a public issue for anything exploitable.

Tell us what you found, how to reproduce it, and what an attacker gets. You
will get an acknowledgement within three working days and an assessment
within seven. If it is real we will fix it, publish the fix with a note in
the changelog, and credit you unless you would rather we did not.

## What is in scope

This package runs a language model's output as instructions, on a machine,
with tools. Its security properties are therefore about **confinement**, and
those are the ones worth reporting against:

- **Escaping the workspace.** A step reads and writes one directory. A path,
  a symlink or a tool argument that reaches outside it — the host, another
  account's files, the platform's own state — is a vulnerability.
- **Reading a secret it was not given.** A step's declared secrets reach it;
  nothing else should, and a secret's *value* should not appear in a run
  record, an output or a log line.
- **Escaping the sandbox.** A step executes in a container (and on the
  hosted platform, gVisor). A way out of it is a vulnerability. Note that
  the container's own seccomp sandbox is deliberately off — the outer
  sandbox is the boundary, and the two fight.
- **A tool doing more than it says.** The gallery tools' arguments are
  written by a model. An argument that becomes a shell, a file write outside
  `outputs/`, or a request to a host the caller did not name, is a bug.

## What is not a vulnerability

- A model doing something unwise it was *asked* to do. The agent's
  instructions are the operator's; the runtime confines them, it does not
  second-guess them.
- Reaching the public internet from a step. Steps are allowed to; restrict
  it at the network layer or with the platform's egress proxy.
- A missing rate limit or budget on a self-hosted install. `budget:` and
  `timeout:` exist; not setting them is a configuration choice.
- Anything requiring an attacker who can already write the workspace's
  markdown. Whoever writes the agent files is the operator.
