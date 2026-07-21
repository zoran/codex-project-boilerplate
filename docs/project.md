# Project Manifest

This is the always-read, concise central source of truth for product intent, scope, system shape,
and durable decisions.

Agent workflow authority: `instructions.md`. Replace pending manifest entries before implementation
depends on assumptions.

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
- The supported start is exactly `codex update && CODEX_HOME="$PWD" codex --cd "$PWD"`. The update
  is system-wide; the canonical repository root is the isolated Codex home for the subsequent
  project session.
- Mutable authentication, trust, sessions, logs, memories, caches, plugins, runtime skills, history,
  installation/model metadata, and Codex databases stay in ignored repository-root Codex runtime.
  Portable Codex policy remains committed under `.codex/`, including config, hooks, agent roles, and
  documentation. Shared source-inventory and root-bound ignore policy keep mutable state out of Git,
  indexing, formatting, generation, staging, and export.
- Git and Git-less inventory use the same built-in pre-descent mask before entering private root
  runtime, `.codex` runtime, index, or process-state trees. Temporary `.git/info/exclude` migration
  masks are not contract evidence and may be removed before commit once isolated validation proves
  the worktree `.gitignore` alone. Host and local Git excludes cannot hide active source, and any
  active repository-local Git exclude rule blocks `pnpm goal:new`.
- Source inventory, generator state capture, and goal publication bind root-owned Git metadata with
  the canonical worktree and pin stat checks. Goal publication compares content through a fresh
  temporary index; policy-sensitive probes disable repository-local FSMonitor execution and reject
  hidden index flags. Git-less nested roots remain Git-less. A staged validator derives its target
  from its own copied script instead of a caller-selected stage path and preserves the bound
  directory identity throughout validation.
- Generated projects use `<apps>/<Project Name>/code`: the project name is the outer folder, `code`
  is the fixed workspace root, and package identity is derived from the outer project folder.
- Within that workspace, root `src/` is the required default Product Root. A real declared pnpm
  workspace package may add `<unit>/src`, and an evidenced Android Gradle module may add
  `<module>/src/main`; arbitrary folders do not become product units. A requested web application is
  created or imported as a workspace package when needed, not pre-created in the neutral base.
- Codex policy, agent skills, instructions, retrieval indexes, and process state remain outside
  every product unit. Repo-wide semantic vector state is fixed at ignored root `.context-index/` and
  is neither product source nor part of generated or exported portable source.
- Initial setup materializes that vector state. The locally hash-trusted project Stop hook refreshes
  changed sources at Codex turn boundaries, semantic search retains on-demand repair, and normal
  verification, pre-push, and boilerplate reset do not mutate or remove a legitimate index.
- Explicit indexing and semantic search perform bounded, lock-safe opportunistic maintenance of
  validated stale generations and model-cache revisions. Incremental pressure triggers an atomic
  complete-generation replacement at 20 operations or 100,000 affected rows; threshold replacement
  reuses only deep-validated vectors, while corruption and old-schema repair reuse none. Context
  status/check, verification, and pre-push remain strictly read-only; unsafe state fails closed.
- Main-thread and delegated discovery use known paths or exact search for reliable anchors and use
  semantic retrieval early for broad orientation, unfamiliar terminology, unclear ownership, or
  cross-file relationships. Retrieval results remain pointers whose matched sources must be read.
- Whole-repository course checks are mandatory after planning/discovery, at every resume or context
  recovery, after every significant implementation milestone, on scope/assumption changes, and
  before closure. They reconcile the active objective with durable truth, touched owners and
  consumers, risks, tests, and unrelated worktree state so fixes remain integrated rather than
  isolated.
- After a goal's implementation, evidence, required reviews, applicable reset, and complete gate are
  green, the primary commits exactly that goal's changes and pushes the current branch to its
  configured upstream. Unsafe scoping, missing upstream/authentication, or a rejected push blocks
  publication without authorizing force-push or history rewriting.
- `pnpm goal:new` is the executable fail-closed entry gate for every subsequent goal. It creates no
  process artifact and permits goal creation only when the non-ignored worktree is clean and the
  named branch exactly matches a locally verifiable configured remote-tracking upstream. It rejects
  any active repository-local Git exclude rule and does not contact the remote; the preceding push
  owns authentication and publication.
- Project creation is source-read-only: resettable process state blocks generation, and the source
  Git state must remain unchanged through publication.
- This manifest is authoritative for project intent and durable decisions. An optional
  `docs/project-context.md` may add current goal/slice state but cannot override the manifest.
- Maintained executable modules have a 700-physical-line maximum. Documentation, styles, declarative
  context, generated output, test corpora, fixtures, and snapshots stay outside this generic
  file-length quota.

## Maintenance

Keep active truth instead of appending decision history. Change this file only when users, outcomes,
scope, non-goals, system shape, constraints, architecture direction, security posture, provider, or
delivery assumptions materially change. Do not record task plans, progress, reviews, or command
history. Retain only durable truth here.
