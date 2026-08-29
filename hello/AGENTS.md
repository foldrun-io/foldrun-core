---
name: hello
description: A runnable demo — one agent, one flow, no network and no secrets.
foldrun_version: "0.1"
---

# hello

Everything here is deliberately small enough to run in one step. There are no
API keys and no network calls: the point is to prove the loop — an agent reads
what it was given, does the work, and writes back what it learned as a
conformant OKF document.

The one piece of code is `tools/wordcount/`, and it is the shape every script
tool should take: a `tool.md` holding the contract and a `run.py` holding the
program, in one folder. The definition names `run.py` and never the scope it
lives in, so the folder is correct copied into any workspace or installed at
the account. Code stays a real file — lint it, test it, run it by hand.
