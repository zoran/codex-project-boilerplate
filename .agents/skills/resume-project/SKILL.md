---
name: resume-project
description:
  Recover durable repository context and continue work when the user says continue, resume, pick up,
  carry on, or equivalent, or when a fresh session must reconstruct active goals and next steps.
  Prefer current files and commands over remembered conversation state.
---

# Resume Project

1. Read the repository bootstrap, project manifest, optional bounded `docs/project-context.md`,
   current source, and relevant tests/configuration.
2. Inspect Git state and focused command output. Use available session/memory evidence when the user
   refers to earlier work; current files and command results win.
3. State the recovered objective, completed evidence, blockers, and next smallest coherent action.
4. Continue directly. If the optional project-context cache exists, replace stale goal, slice,
   decision, and next-action entries with the compact current truth. Otherwise keep recovered plans,
   status, and handoff context in the conversation instead of creating repository process documents.
5. Update product documentation only when a durable product or operational contract actually
   changed.

Apply the current `instructions.md`, including its code-first documentation and proportional
verification rules.
