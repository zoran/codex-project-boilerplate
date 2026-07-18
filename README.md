# Codex Project Boilerplate

This is a neutral, code-first base for Codex projects. It provides portable project policy, local
semantic retrieval for large repositories, dependency and verification tooling, and strict
project/runtime isolation without imposing a product stack or a documentation-heavy workflow.

## Create A Project

Ask Codex to use `$create-project-from-boilerplate` and provide a project name. The generator
creates a clean `<apps>/<Project Name>/code` workspace without repeating the project name below
`code`. That workspace keeps Codex policy, agent skills, and reusable tooling at the root while
creating `src/` as the required default product root. It excludes Git history, GitHub metadata,
planning artifacts, installed dependencies, caches, secrets, and user Codex state. Before
publication, it verifies that the source boilerplate still has a clean reset baseline and exactly
the same Git worktree state as before generation.

Generated projects contain only the core human documentation needed to begin: a short bootstrap,
this README, the workflow authority, and the project manifest. Architecture, operations, API, and
other docs are added only when the product has a real durable contract to document.

Product Roots are enforced during generation, export, and normal verification. A real declared pnpm
workspace package activates `<unit>/src`; an evidenced Android Gradle module activates
`<module>/src/main`. Arbitrary folders do not activate product checks. A requested web application
is created or imported as such a workspace package at that time; the neutral base does not
pre-create `apps/web`. `.codex`, `.agents`, `AGENTS.md`, retrieval indexes, and process state are
rejected inside every product unit.

## Start Codex

Install a current user-level [Codex CLI](https://developers.openai.com/codex/cli/) and
[mise](https://mise.jdx.dev/installing-mise.html), then start Codex independently of project
runtimes:

```bash
env -u NO_COLOR codex --cd "$PWD"
```

Install the exact project-local Node.js and pnpm artifacts separately:

```bash
mise install --locked
mise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts
mise exec --locked -- pnpm setup
```

`pnpm setup` is complete only after it has created and validated the local vector space at the fixed
root path `.context-index/`. On first use it may download the pinned local embedding model; its
final output reports the path, indexed file counts, embedding/reuse statistics, and a successful
database smoke search. A failed vector bootstrap means project setup is incomplete.

The optional `bash scripts/setup/start-codex.sh` launcher performs the same host-level start. The
repository never redirects `CODEX_HOME`; installation, authentication, trust, sessions, logs, and
caches remain in the user's normal Codex home.

## Project Authority

The repository keeps each kind of context in one owning surface:

- [Project Instructions](instructions.md) own the complete agent workflow. `AGENTS.md` intentionally
  repeats only the non-negotiable guardrails needed for a safe direct entry.
- The [Project Manifest](docs/project.md) owns product intent, scope, constraints, and durable
  decisions. Memory, generated indexes, and optional working context cannot replace it.
- `docs/project-context.md`, when present, is only a bounded current-goal cache for complex
  multi-session work; source, tests, and configuration remain the implementation truth.

Plans, progress, reviews, and handoffs stay in the conversation. Normal work produces code and
regression evidence; documentation changes only for a real durable contract. Use focused checks
while iterating and `pnpm verify` as the complete deterministic handoff gate.

## Commands

Prefix project commands with `mise exec --locked --` when running outside an activated mise shell.

```bash
pnpm setup
pnpm verify
pnpm verify:changed
pnpm verify:external
pnpm context:search -- "query"
pnpm context:clean
pnpm deps:report
pnpm project:export
```

The locked runtime artifacts support Linux x64/arm64 (glibc and musl), macOS arm64, and Windows x64.
Intel macOS is intentionally not supported because pnpm 11 does not publish the required Darwin x64
standalone artifact.

Use `rg` for exact discovery. Setup creates one repo-wide, ignored root `.context-index/` vector
space, separate from every Product Root; semantic search incrementally refreshes it when sources
change and can recreate it after an explicit cleanup. It combines active code, tests, configuration,
skills, durable docs, and compact project context, and returns five short matches by default. It is
only a discovery aid; agents still read the relevant matched source before making claims or edits.
