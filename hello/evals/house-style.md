---
name: house-style
agent: notetaker
model: fast
---

## uses a real number
task: Write two sentences about the RG-100 rain gauge.
expect:
  - contains: 0.2mm
  - not-contains: significant

## does not claim accuracy
task: Write two sentences about the RG-100 rain gauge.
expect:
  - judge: states a resolution and does not claim an accuracy percentage
