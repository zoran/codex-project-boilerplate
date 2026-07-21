---
name: create-project-from-boilerplate
description:
  Create a clean sibling project from this boilerplate when the user supplies a project name.
  Exclude Git history, local runtime/cache state, boilerplate planning history, GitHub metadata, and
  boilerplate-only material while preserving portable project policy and reusable tooling.
---

# Create Project From Boilerplate

Require a user-provided project name. Do not invent one.

Run:

`mise exec --locked -- node .agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs --name "<Project Name>"`

Run `mise install --locked` and then
`mise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts` in the source workspace
first. Creation uses the source's locked runtime and pinned formatter to make generated Markdown
deterministic.

Project creation must never edit the source boilerplate or add the requested project name to source
tests, documentation, or policy. The generator requires a clean reset baseline, snapshots the full
source Git status including ignored entries, rechecks both before publication, and discards staging
if the source changes. Use neutral fixture names for generator regression coverage.

The default transfer uses the source repository's tracked files plus the required `mise.toml` and
`mise.lock` runtime contract, which staged validation checks before publication. Other local drafts
and ignored state cannot enter the new project. Use `--include-untracked` only when the user
explicitly asks to transfer a working-tree snapshot.

Use `--directory <folder>` only when the user requests a specific outer project-folder name. The
default target preserves a safe single-segment project name and creates the workspace at
`<apps>/<Project Name>/code`. Names that are not safe path segments fall back to a lowercase slug.
The fixed final folder is always `code`; do not repeat the project name below it. Package identity
is derived from the outer project folder, not from the `code` folder. The `code` folder is the Codex
and tooling workspace; it must contain a real `src/` default Product Root. A real package matched by
`pnpm-workspace.yaml` with its own `package.json` and `src/` activates another product unit; an
evidenced Android Gradle module activates `<module>/src/main`. Arbitrary folders do not activate.
When the user later requests a web application, create or import the declared workspace package and
its `src/` as part of that task instead of pre-creating an empty `apps/web`. Agent policy, skills,
instructions, and process state remain outside every product unit. The repository-wide vector space
has one fixed, ignored location at root `.context-index/` and is never product source. Generation
does not copy or download vector state; the generated project's required `pnpm setup` creates it,
smoke-tests it, and reports its location and statistics. The portable project Stop hook then keeps
changed sources current once per Codex turn after local hash-bound approval through `/hooks`.

## Required Result

- no inherited `.git/`, remote, GitHub workflow metadata, environment secrets, installed dependency
  directories, build output, `.context-index/`, or source-project Codex runtime state;
- portable `.codex/config.toml`, `.codex/hooks.json`, `.codex/agents/`, `.codex/README.md`, the
  project launcher, and both Stop-hook scripts retained;
- each generated project documents `codex update && CODEX_HOME="$PWD" codex --cd "$PWD"` exactly:
  the update remains system-wide, while the generated repository root is the isolated home for its
  mutable Codex runtime;
- root-bound ignore and source-inventory policy exclude authentication, sessions, logs, caches,
  plugins, runtime skills, history, metadata, and Codex databases while retaining portable
  `.codex/config.toml`, hooks, roles, and documentation;
- Git-less inventory carries the same built-in pre-descent mask so private root/runtime trees are
  never entered without Git metadata; temporary `.git/info/exclude` migration masks are not contract
  evidence and can be removed once the worktree `.gitignore` validator passes; host and local Git
  excludes cannot hide active source, while source-state probes bind root-owned Git metadata with
  the canonical worktree and pin stat checks; goal publication compares content through a fresh
  temporary index; policy-sensitive probes disable repository-local FSMonitor execution and reject
  hidden index flags; a Git-less nested root remains Git-less;
- staged validation runs from its copied validator, accepts no caller-selected stage path, and keeps
  its canonical stage-directory identity stable through validation;
- the executable `goal:new` publication gate retained and required before any subsequent goal; it
  fails closed unless the non-ignored worktree is clean and the named branch exactly matches a
  locally verifiable configured remote-tracking upstream, with no active repository-local Git
  exclude rule remaining;
- whole-repository course checks required after planning/discovery, at every resume or context-
  recovery point, after every significant implementation milestone, on scope/assumption changes, and
  before closure;
- a real default `src/` Product Root retained by portable export, with declared pnpm and evidenced
  Android units recognized by the same contract and guarded against nested `.codex`, `.agents`,
  agent instruction files, retrieval indexes, and process state;
- no planning history, status, review, audit, or handoff artifacts and no boilerplate-only
  project-creation skill; later complex multi-session work may use one bounded, overwritten
  `docs/project-context.md`, never per-slice files or archives;
- a small code-first documentation surface with project name, package identity, and core workflow
  rewritten consistently;
- a setup command that materializes the generated project's own root `.context-index/` vector space
  and fails unless the database and smoke search are usable;
- threshold-driven atomic context-database generation replacement with verified reuse, plus
  automatic no-reuse repair for corruption and older ignored manifest schemas;
- an always-read primary-agent workflow that uses exact search for known anchors, semantic retrieval
  early for broad orientation or unclear cross-file ownership, and direct matched-source reads
  before claims or edits;
- exactly one validated Stop hook that is inert before bootstrap, uses the mise-pinned runtime
  afterward, refreshes incrementally through the sanitized worker, and keeps local hook trust out of
  portable source;
- refusal when the outer project directory already exists and post-copy verification before handoff;
- refusal when the source has resettable process state or changes during generation;
- no source-boilerplate mutation or project-specific source trace from creating the new project.

Do not initialize Git, create a remote, commit, or push unless the user separately asks. Report the
generated path, package name, and verification result.
