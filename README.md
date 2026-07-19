# Codex Project Boilerplate

This is a neutral, code-first base for Codex projects. It provides portable project policy, local
semantic retrieval for large repositories, dependency and verification tooling, and strict
project/runtime isolation without imposing a product stack or a documentation-heavy workflow.

## Create A Project

Ask Codex to use `$create-project-from-boilerplate` and provide a project name. The generator
creates a clean `<apps>/<Project Name>/code` workspace without repeating the project name below
`code`. That workspace keeps Codex policy, agent skills, and reusable tooling at the root while
creating `src/` as the required default product root. It excludes Git history, GitHub metadata,
planning artifacts, installed dependencies, caches, secrets, and source-project Codex runtime.
Before publication, it verifies that the source boilerplate still has a clean reset baseline and
exactly the same Git worktree state as before generation.

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

Install a current host [Codex CLI](https://developers.openai.com/codex/cli/) and
[mise](https://mise.jdx.dev/installing-mise.html), then run the supported start command from the
repository root exactly as shown:

```bash
codex update && CODEX_HOME="$PWD" codex --cd "$PWD"
```

The system-wide `codex update` intentionally runs before project isolation. The `&&` prevents Codex
from starting when that update fails. The second command sets `CODEX_HOME="$PWD"`, isolating
authentication, trust, sessions, logs, memories, caches, plugins, runtime skills, history,
installation/model metadata, and Codex databases inside this repository. Root-bound `.gitignore`
rules and the shared source inventory keep that mutable state out of Git, indexing, formatting,
project generation, staging, and export. Portable project configuration remains tracked under
`.codex/`, including `config.toml`, `hooks.json`, agent roles, and documentation.

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

After bootstrap, the project-local Codex Stop hook refreshes changed indexed sources once at the end
of each turn through the mise-pinned Node.js runtime. It is not a watcher and does not run after
individual tool calls. Semantic search keeps its on-demand repair fallback; deterministic
verification and pre-push remain read-only. Codex requires local, hash-bound approval for a new or
changed project hook, which can be reviewed and granted through `/hooks`.

The optional `bash scripts/setup/start-codex.sh` launcher validates the portable project and runtime
isolation boundaries, runs the system-wide update without project `CODEX_HOME`, and starts Codex
only after success with `CODEX_HOME` and `--cd` fixed to the canonical repository root. It does not
require the project Node.js runtime and does not approve project hooks; new or changed hook hashes
still require explicit local `/hooks` approval.

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

After a verified goal, the primary commits its exact changes and pushes the current branch. Before
opening a subsequent goal, `pnpm goal:new` supplies the executable publication precondition: it
fails closed unless the non-ignored worktree is clean and the named branch exactly matches its
locally recorded configured remote-tracking upstream. It does not contact the remote, fetch, commit,
push, or create planning state; the preceding push owns remote authentication and publication.

## Commands

Prefix project commands with `mise exec --locked --` when running outside an activated mise shell.

```bash
pnpm setup
pnpm verify
pnpm verify:changed
pnpm verify:external
pnpm goal:new
pnpm context:search -- "query"
pnpm context:clean
pnpm deps:report
pnpm project:export
```

The locked runtime artifacts support Linux x64/arm64 (glibc and musl), macOS arm64, and Windows x64.
Intel macOS is intentionally not supported because pnpm 11 does not publish the required Darwin x64
standalone artifact.

Use known paths or `rg` for exact discovery. When no reliable exact anchor exists, ownership is
unclear, or work depends on broad orientation, unfamiliar terminology, or cross-file relationships,
semantic search is the normal early discovery route; a failed `rg` attempt is not required first.
Setup creates one repo-wide, ignored root `.context-index/` vector space, separate from every
Product Root; the trusted Stop hook incrementally refreshes it at turn boundaries, and semantic
search can repair freshness or recreate state after an explicit cleanup. It combines active code,
tests, configuration, skills, durable docs, and compact project context, and returns five short
matches by default. Results are only discovery pointers; agents still read every matched source used
for a claim or edit.
