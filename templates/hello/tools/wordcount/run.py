#!/usr/bin/env python3
"""Count words and sentences in a piece of text."""
import argparse, json, re

p = argparse.ArgumentParser()
p.add_argument("--text", required=True)
a = p.parse_args()

# Not every period ends a sentence. "0.2mm" is one token, and splitting on the
# period inside it reported two sentences where a reader sees one — which sent
# a real run round three rewrites chasing a count that was wrong.
sentences = [s for s in re.split(r"(?<![0-9])[.!?]+(?:\s|$)", a.text) if s.strip()]
print(json.dumps({"words": len(a.text.split()), "sentences": len(sentences)}))
