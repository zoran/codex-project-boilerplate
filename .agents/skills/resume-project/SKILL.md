---
name: resume-project
description:
  Recover durable repository context and continue work when the user says continue, resume, pick up,
  carry on, or equivalent, or when a fresh session must reconstruct active goals and next steps.
  Prefer current files and commands over remembered conversation state.
---

# Resume Project

1. Read the repository bootstrap, project manifest, optional bounded `docs/project-context.md`, and
   the current source and tests already named by those authorities.
2. Use known paths or `rg` for exact recovery. When no reliable exact anchor exists, ownership is
   unclear, or recovery depends on cross-file relationships, use
   `pnpm context:search -- "concept or relationship"` before broad repository exploration, then read
   every matched source used to reconstruct the work. A failed exact search is not a prerequisite.
3. Inspect Git state and focused command output. Use available session/memory evidence when the user
   refers to earlier work; current files and command results win.
4. Every resume and context-recovery point requires a whole-repository course check. Then state the
   recovered objective, completed evidence, touched owners/consumers, blockers, and next smallest
   coherent action.
5. Continue directly. If the optional project-context cache exists, replace stale goal, slice,
   decision, and next-action entries with the compact current truth. Otherwise keep recovered plans,
   status, and handoff context in the conversation instead of creating repository process documents.
6. Update product documentation only when a durable product or operational contract actually
   changed.

Apply the current `instructions.md`, including its code-first documentation and proportional
verification rules.
