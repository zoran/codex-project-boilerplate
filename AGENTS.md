# AGENTS.md

This repository is a production-ready, code-first Codex project base. Process artifacts are not
deliverables: implementation, tests, and runnable configuration should dominate normal project work.

## Start

1. Start the user-level Codex CLI from the repository root with `env -u NO_COLOR codex --cd "$PWD"`.
2. Run `bash scripts/setup/check-prereqs.sh`; stop only if a core requirement is missing.
3. Read the workflow authority in [Project Instructions](instructions.md), setup and use in
   [README](README.md), the durable project truth in the [Project Manifest](docs/project.md), and
   `docs/project-context.md` when that optional working cache exists.
4. Trust current files and command output over remembered context. Inspect only task-relevant
   source, tests, manifests, and configuration; use `rg` first and semantic search only when needed.

## Entry-Point Guardrails

- Treat root `src/` as the required default Product Root. A real pnpm workspace package with its own
  `package.json` activates `<unit>/src`; an evidenced Android Gradle module activates
  `<module>/src/main`. Arbitrary folders do not become product roots. When the user asks to create
  or attach a web application, create or import the declared workspace package and its `src/` then;
  do not pre-create an empty `apps/web` in a neutral project.
- Keep `.codex`, `.agents`, agent instructions, retrieval indexes, process state, and other Codex
  tooling outside every product unit. The repo-wide semantic vector state has exactly one local,
  ignored home at root `.context-index/`; it is not product source. `pnpm setup` is complete only
  after that vector space is current and passes its database smoke search.
- Treat `docs/project.md` as the always-read truth for intent and durable decisions. Normal task
  state stays in the conversation; complex multi-session work may use one bounded, overwritten
  `docs/project-context.md`, which cannot override the manifest or become a diary or archive.
- Change documentation only for a real user-facing, operational, API, architecture, security, or
  durable project contract; a code change does not need prose merely to prove it happened.
- Fix root causes at the owning boundary and add focused regression evidence.
- Use useful subagents with bounded, non-overlapping scopes. Project roles pin the current
  second-tier model (`gpt-5.6-terra`) and inherit the primary's `xhigh` default or explicit
  `max`/`ultra` effort. The primary alone edits `.codex/config.toml`, `.codex/agents/**`, these
  instructions, `.agents/skills/**`, `.codex/skills/**`, and skill metadata.
- Run focused checks while working and the complete deterministic `pnpm verify` once before handoff.
  Repeat only after relevant fixes or new high-severity evidence.
- After changing the boilerplate itself, use `$reset-boilerplate` with `--apply` before the final
  gate. Complete verification enforces the clean reusable baseline.
- Never commit secrets or machine-local state. Keep portable Codex defaults in tracked `.codex/`
  files; installation, credentials, trust, sessions, logs, and caches remain in the user's normal
  Codex home.

These guardrails are repeated intentionally so a direct entry remains safe. Their complete
definitions and the rest of the workflow are owned by [instructions.md](instructions.md).
