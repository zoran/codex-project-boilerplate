---
name: task-quality
description:
  Verify, prepare for push, close, or hand off completed project work with proportional
  deterministic checks and one bounded findings pass. Also supports an explicitly read-only final
  review without changing files or planning state. Use near completion, not for ordinary
  implementation or a specialized domain review.
---

# Task Quality

## Authority Mode

Choose the mode from the user's request:

- **Review-only:** when asked to inspect, review, audit, diagnose, or report without changes. Do not
  edit files, accept risk for the owner, or perform external mutations. Run only checks needed to
  support the review.
- **Finish/handoff:** when completing an authorized implementation, preparing a push, or explicitly
  closing work. Fix findings only inside the original change scope.

## Workflow

1. Identify the requested outcome, changed files, owning boundaries, and risk surfaces.
2. Perform a whole-repository course check: confirm the implemented scope still matches the
   requested outcome and durable project truth, and account for touched owners/consumers, risk
   boundaries, tests, docs, and unrelated worktree changes. Keep this comparison in the
   conversation; do not create a completion artifact.
3. Run focused regressions first. In finish/handoff mode, run the complete deterministic project
   gate:

   ```bash
   pnpm verify
   ```

   A targeted review-only request does not imply a complete gate. Run network-dependent maintenance
   only when the task is a release/dependency check.

4. Perform one bounded review for regressions, root-cause quality, maintainability, docs drift, and
   whole-system impact. Invoke `$security-review` for affected trust, authentication, authorization,
   secret, personal-data, dependency, shell, CI, infrastructure, or runtime surfaces,
   `$code-pattern-review` for implementation/architecture changes, and specialized content/image/
   search review only when those surfaces changed. Keep findings in the conversation; do not create
   review, audit, or handoff documents.
5. Classify findings by severity, relevance, reproducibility, and acceptance impact. In
   finish/handoff mode, fix material, relevant, and reproducible findings within scope; only the
   owner or documented project policy can accept material residual risk. In review-only mode, report
   findings without changing or accepting them. Re-run only affected checks, then one final complete
   gate if implementation changed.
6. Stop when checks pass and no unresolved finding remains that is high-severity, relevant, and
   reproducible. Continue a broad loop only for a failing deterministic command, a new high-severity
   issue, or an explicit user request.
7. When user or repository policy requires publication after goal completion, commit exactly the
   verified goal-owned changes and push the current branch to its configured upstream. Treat unsafe
   scoping, missing upstream/authentication, or a rejected push as a visible blocker. Never absorb
   unrelated changes, bypass hooks, force-push, or rewrite history to manufacture closure.
8. Do not open a subsequent goal until `pnpm goal:new` passes its executable fail-closed publication
   precondition. The gate must prove a clean non-ignored worktree and exact equality between the
   named branch and its locally recorded configured remote-tracking upstream; prose is not
   publication evidence, and the preceding push owns remote authentication.

## Handoff

Lead with the outcome. Include verification, important decisions, accepted residual risks, and the
next useful step only when one remains.
