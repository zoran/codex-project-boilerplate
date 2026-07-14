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
smoke-tests it, and reports its location and statistics.

## Required Result

- no inherited `.git/`, remote, GitHub workflow metadata, environment secrets, installed dependency
  directories, build output, `.context-index/`, or user Codex state;
- portable `.codex/config.toml`, `.codex/agents/`, `.codex/README.md`, and the project launcher
  retained;
- each generated project keeps portable policy under `.codex/` while using the developer's normal
  user-level Codex installation and home;
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
- refusal when the outer project directory already exists and post-copy verification before handoff;
- refusal when the source has resettable process state or changes during generation;
- no source-boilerplate mutation or project-specific source trace from creating the new project.

Do not initialize Git, create a remote, commit, or push unless the user separately asks. Report the
generated path, package name, and verification result.
