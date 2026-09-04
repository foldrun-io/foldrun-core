---
transport: script
name: wordcount
description: Count the words and sentences in a piece of text. Use it to check a draft before saving it.
run: run.py
args:
  text: The text to measure
---

A folder tool: this definition and the code it runs are one directory, so they
cannot drift apart or be copied separately. `run:` names the file beside it and
never the scope it lives in — the same folder is correct in a workspace's
`tools/` or installed at the account, and the loader qualifies the path.

A script tool rather than a granted shell: the agent calls it by name with a
typed argument and never composes a command line. Runs in a container.

`run.py` is a real file, so it can be linted, tested and run by hand:

```console
python3 tools/wordcount/run.py --text "Two sentences. Like this."
```
