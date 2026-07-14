# AGENTS.md

This repository is a production-ready, code-first Codex project base. Process artifacts are not
deliverables: implementation, tests, and runnable configuration should dominate normal project work.

## Start

1. Start the user-level Codex CLI from the repository root with `env -u NO_COLOR codex --cd "$PWD"`.
2. Run `bash scripts/setup/check-prereqs.sh`; stop only if a core requirement is missing.
3. Read [Project Instructions](instructions.md), [README](README.md), the
   [Project Manifest](docs/project.md), and `docs/project-context.md` when that optional compact
   working-memory file exists.
4. Inspect only the task-relevant source, tests, manifests, and configuration. Use `rg` for exact
   discovery and semantic context search only when ownership or wording is unknown.

## Core Rules

- Treat root `src/` as the required default Product Root. A real pnpm workspace package with its own
  `package.json` activates `<unit>/src`; an evidenced Android Gradle module activates
  `<module>/src/main`. Arbitrary folders do not become product roots. When the user asks to create
  or attach a web application, create or import the declared workspace package and its `src/` then;
  do not pre-create an empty `apps/web` in a neutral project.
- Keep `.codex`, `.agents`, agent instructions, retrieval indexes, process state, and other Codex
  tooling outside every product unit. The repo-wide semantic vector state has exactly one local,
  ignored home at root `.context-index/`; it is not product source. `pnpm setup` is complete only
  after that vector space is current and passes its database smoke search.
- Keep normal-task plans, progress, review notes, and handoffs in the conversation. For complex
  multi-session work, one optional `docs/project-context.md` may hold the current goal, current
  slice, essential decisions, and next steps within its enforced size budget. Replace stale content;
  never create per-slice files, journals, or archives.
- Change documentation only for a real user-facing, operational, API, architecture, or durable
  project contract. A code change does not need a documentation change merely to prove work
  happened.
- Treat `docs/project.md` as the always-read central truth for intent and durable decisions. Keep it
  within its enforced budget; the optional working context cannot override it.
- Fix root causes at the owning boundary and add focused regression evidence.
- Use useful subagents with bounded, non-overlapping scopes. Project roles pin the current
  second-tier model (`gpt-5.6-terra`) and inherit the primary's `xhigh` default or explicitly
  selected `max`/`ultra` effort.
- The primary alone edits `.codex/config.toml`, `.codex/agents/**`, these instructions,
  `.agents/skills/**`, `.codex/skills/**`, and skill metadata.
- Run focused checks while working and the complete deterministic `pnpm verify` once before handoff.
  Repeat only after relevant fixes or new high-severity evidence.
- After changing the boilerplate itself, use `$reset-boilerplate` with `--apply` before the final
  gate. Complete verification enforces the clean reusable baseline.
- Keep portable Codex defaults in tracked `.codex/` files. Installation, credentials, trust,
  sessions, logs, and caches remain in the user's normal Codex home.

The complete authority and workflow are in [instructions.md](instructions.md).
