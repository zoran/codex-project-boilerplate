---
name: project-implementation
description:
  Implement, debug, refactor, or produce implementation-ready technical design with root-cause
  analysis, stack-aware conventions, evidence-backed decisions, focused tests, and whole-system
  handoff. Use for application, script, infrastructure, architecture, framework, migration, or
  performance work; not for a final review or dependency-only maintenance.
---

# Project Implementation

## Authority Mode

For an implementation/fix request, edit within the requested scope. For architecture, design,
explanation, or diagnosis requested without implementation, remain read-only and return evidence,
tradeoffs, and an implementation-ready recommendation; do not turn advice into repository changes.

## Preflight

For non-trivial work, keep the objective, scope/non-goals, material risks or decisions, likely
owners/files, and verification in the conversation. Do not create a planning document. Read the
nearest package/build/test configuration and any directly relevant project document that already
exists. For complex multi-session work, update the single bounded `docs/project-context.md` only
when the repository workflow permits it; replace stale goal/slice state instead of appending a log.

## Workflow

1. Trace the behavior to its owning module, contract, data/state transition, or workflow. Fix the
   producer/invariant rather than scattering caller guards.
2. Detect the existing stack before framework-specific work:

   ```bash
   pnpm stack:detect
   ```

   Follow local language, framework, naming, error, dependency, and test conventions. Do not add a
   framework without a documented need.

   Follow the repository's Product Roots contract: root `src/` is the default implementation root; a
   real declared pnpm package activates `<unit>/src`; an evidenced Android Gradle module activates
   `<module>/src/main`. Arbitrary folders do not activate product behavior. When the user requests a
   web application, create or import the declared workspace package and its `src/` as part of that
   task instead of pre-creating an empty `apps/web`. Keep repo-wide vector state at root
   `.context-index/`, outside every product unit. Project setup is not complete until that vector
   space has been materialized and smoke-tested; normal verification remains read-only.

3. Check current official/primary sources only when a material decision depends on unstable or
   specialized behavior. Record the decision and tradeoff, not a research transcript.
4. Implement the smallest coherent owning-boundary change. Preserve unrelated compatible edits and
   avoid generic catch-all modules or speculative abstractions.
5. Keep maintained executable modules at or below 700 physical lines. Split an approaching module at
   cohesive ownership boundaries. Do not apply the quota to declarative/context, generated,
   test-corpus, fixture, snapshot, documentation, or style files.
6. Add regression evidence where the invariant should be enforced. Update documentation only when an
   externally consumed or durable project contract changed. The optional compact project-context
   cache is the sole task-state exception; never create per-task notes or archives.
7. Run the focused check during iteration, then the repository's complete deterministic gate before
   handoff.

## Completion

Report the outcome, changed boundaries, verification, material tradeoffs, and residual risks in the
final response. Use `$task-quality` for handoff, push preparation, explicit finish requests, or
elevated-risk changes—not as a mandatory extra workflow for every edit.
