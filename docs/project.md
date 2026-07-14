# Project Manifest

This is the always-read, concise central source of truth for product intent, scope, system shape,
and durable decisions. Replace pending entries before implementation depends on assumptions.

## Definition

No product has been defined yet.

## Users And Outcome

- Target users: pending.
- Problem and desired outcome: pending.
- Success evidence: pending.

## Scope

- In scope: pending.
- Non-goals: do not infer a runtime, framework, provider, deployment target, data model, or trust
  boundary before requirements justify it.

## System Shape

- Key domains and ownership boundaries: project policy, project creation, context retrieval, setup,
  dependency maintenance, and deterministic verification.
- Primary flow: create or open a project, load the compact project truth, inspect relevant source,
  implement at the owning boundary, and verify proportionally.
- Durable state: source, tests, configuration, and this manifest. Generated indexes, caches,
  sessions, and temporary project context are not durable product truth.

## Constraints And Decisions

- Keep the project neutral until the user supplies requirements.
- Portable Codex policy is committed under `.codex/`; mutable installation, authentication, trust,
  sessions, logs, and caches stay in the user's normal Codex home.
- Generated projects use `<apps>/<Project Name>/code`: the project name is the outer folder, `code`
  is the fixed workspace root, and package identity is derived from the outer project folder.
- Within that workspace, root `src/` is the required default Product Root. A real declared pnpm
  workspace package may add `<unit>/src`, and an evidenced Android Gradle module may add
  `<module>/src/main`; arbitrary folders do not become product units. A requested web application is
  created or imported as a workspace package when needed, not pre-created in the neutral base.
- Codex policy, agent skills, instructions, retrieval indexes, and process state remain outside
  every product unit. Repo-wide semantic vector state is fixed at ignored root `.context-index/`;
  generation and export keep it out of portable source, `pnpm setup` materializes and validates it,
  and normal verification remains read-only while enforcing the separation.
- Project creation is source-read-only: resettable process state blocks generation, and the source
  Git state must remain unchanged through publication.
- Prefer code, tests, and configuration as the source of implementation truth.
- This manifest is authoritative for project intent and durable decisions. An optional
  `docs/project-context.md` may add current goal/slice state but cannot override the manifest.

## Maintenance

Keep active truth only within the enforced 100-line, 700-word, 8-KiB budget. Update existing entries
instead of appending decision history. Change this file only when users, outcomes, scope, non-goals,
system shape, constraints, architecture direction, security posture, provider, or delivery
assumptions materially change. Do not record task plans, progress, reviews, or command history.
Complex multi-session work may temporarily use one bounded `docs/project-context.md`; if it
conflicts with this manifest, resolve the conflict here deliberately. Remove the working context
when its goal is complete and retain only durable truth here.
