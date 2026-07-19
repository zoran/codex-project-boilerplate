# AGENTS.md

This repository is a production-ready, code-first Codex project base. Process artifacts are not
deliverables: implementation, tests, and runnable configuration should dominate normal project work.

## Start

1. Start Codex from the repository root with `codex update && CODEX_HOME="$PWD" codex --cd "$PWD"`.
2. Run `bash scripts/setup/check-prereqs.sh`; stop only if a core requirement is missing.
3. Read the workflow authority in [Project Instructions](instructions.md), setup and use in
   [README](README.md), the durable project truth in the [Project Manifest](docs/project.md), and
   `docs/project-context.md` when that optional working cache exists.
4. Trust current files and command output over remembered context. Use known paths or `rg` for exact
   names, symbols, and narrow questions. When no reliable exact anchor exists, ownership is unclear,
   or the task depends on broad orientation, unfamiliar terminology, or cross-file relationships,
   use `$context-retrieval` or `pnpm context:search -- "concept or relationship"` before broad
   repository exploration, then read every matched source used for a claim or edit.

## Entry-Point Guardrails

- Treat root `src/` as the required default Product Root. A real pnpm workspace package with its own
  `package.json` activates `<unit>/src`; an evidenced Android Gradle module activates
  `<module>/src/main`. Arbitrary folders do not become product roots. When the user asks to create
  or attach a web application, create or import the declared workspace package and its `src/` then;
  do not pre-create an empty `apps/web` in a neutral project.
- Keep `.codex`, `.agents`, agent instructions, retrieval indexes, process state, and other Codex
  tooling outside every product unit. `CODEX_HOME="$PWD"` intentionally keeps mutable Codex runtime
  state at the repository root, where root-bound ignore and source-inventory policy exclude it from
  Git, indexing, formatting, staging, and export. Portable config, hooks, roles, and documentation
  remain tracked under `.codex/`. Git and Git-less inventory use the same built-in pre-descent mask
  before entering any private runtime tree. The repo-wide semantic vector state has exactly one
  local, ignored home at root `.context-index/`; it is not product source. `pnpm setup` is complete
  only after that vector space is current and passes its database smoke search. Once bootstrapped,
  the trusted project Stop hook refreshes changed sources at turn boundaries; semantic search
  retains on-demand repair, while verification and pre-push stay read-only. Approve new hook hashes
  locally through `/hooks`.
- Treat `docs/project.md` as the always-read truth for intent and durable decisions. Normal task
  state stays in the conversation; complex multi-session work may use one bounded, overwritten
  `docs/project-context.md`, which cannot override the manifest or become a diary or archive.
- Semantic retrieval is an ordinary discovery route for the main thread as well as delegated agents;
  it does not require a failed `rg` attempt first. Do not run it as ceremony, and never treat a
  result snippet as authority without reading the matched source.
- Whole-repository course checks are mandatory after initial planning/discovery, at every resume or
  context-recovery point, after every significant implementation milestone, whenever scope or
  assumptions change, and before closure. Reconcile the objective and durable project truth with
  every touched owner, consumer, risk, test boundary, and unrelated worktree change. Adjust the plan
  before continuing when implementation has drifted; features and fixes must remain cohesive parts
  of the project instead of isolated patches.
- Change documentation only for a real user-facing, operational, API, architecture, security, or
  durable project contract; a code change does not need prose merely to prove it happened.
- Fix root causes at the owning boundary and add focused regression evidence.
- Keep maintained executable modules at or below 700 physical lines. Do not apply this generic
  file-length quota to non-code or context carriers.
- Use useful subagents with bounded, non-overlapping scopes. Project roles pin the current
  second-tier model (`gpt-5.6-terra`) and inherit the primary's `xhigh` default or explicit
  `max`/`ultra` effort. The primary alone edits `.codex/config.toml`, `.codex/agents/**`, these
  instructions, `.agents/skills/**`, `.codex/skills/**`, and skill metadata.
- Run focused checks while working and the complete deterministic `pnpm verify` once before handoff.
  Repeat only after relevant fixes or new high-severity evidence.
- A goal is complete only after its implementation, focused evidence, required reviews, reset when
  applicable, and complete gate are green. The primary then commits exactly the goal-owned changes
  and pushes the current branch to its configured upstream. Missing safe scoping, upstream, or
  authentication is a visible blocker; never mix unrelated changes or rewrite history to force it.
- Before any subsequent goal is opened, run `mise exec --locked -- pnpm goal:new`. This executable
  precondition fails closed unless the worktree is clean and the current branch exactly matches a
  locally verifiable configured remote-tracking upstream; documentation alone is not publication
  evidence.
- After changing the boilerplate itself, use `$reset-boilerplate` with `--apply` before the final
  gate. Complete verification enforces the clean reusable baseline.
- Never commit secrets or machine-local state. Keep portable Codex defaults in tracked `.codex/`
  files; authentication, trust, sessions, logs, caches, plugins, runtime skills, and databases stay
  in the ignored repository-root Codex runtime and never enter portable project source.

These guardrails are repeated intentionally so a direct entry remains safe. Their complete
definitions and the rest of the workflow are owned by [instructions.md](instructions.md).
