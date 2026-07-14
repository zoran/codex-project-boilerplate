---
name: code-pattern-review
description:
  Read-only review of changed implementation or architecture for root-cause quality, cohesion,
  boundaries, naming, error handling, local conventions, tests, and maintainability. Use near
  handoff for non-trivial code, scripts, infrastructure, or workflow changes; not as a mandatory
  ceremony for unrelated documentation-only work.
---

# Code Pattern Review

Review the changed behavior in its repository context. Report findings; do not edit files.

## Review

1. Identify the changed files, their owners, and the invariant the change is meant to preserve.
2. Compare boundaries, naming, layout, error handling, and tests with nearby established patterns.
3. Prefer a fix at the producing or owning boundary over duplicated guards and caller workarounds.
4. Flag catch-all modules, speculative abstractions, hidden coupling, duplicated policy, and stale
   compatibility layers.
5. Treat file length as a cohesion signal for executable modules. Do not apply a universal line
   limit to HTML, templates, schemas, test corpora, fixtures, snapshots, generated files, or other
   context carriers.
6. Check that regression evidence covers the invariant and that durable docs changed only when the
   contract changed.

Return only material findings, ordered by severity. Include a file reference, concrete failure mode,
root-cause remedy, and smallest proving check. If none remain, say so and state any untested risk.
One targeted recheck is enough unless new evidence changes the risk.
