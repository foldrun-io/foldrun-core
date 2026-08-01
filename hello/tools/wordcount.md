---
transport: script
name: wordcount
description: Count the words and sentences in a piece of text. Use it to check a draft before saving it.
run: workspace/scripts/wordcount.py
interpreter: python3
args:
  text: The text to measure
---

A script tool rather than a granted shell: the agent calls it by name with a
typed argument and never composes a command line. Runs in a container.
