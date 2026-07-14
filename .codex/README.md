# Codex Project Config

This repository separates portable project policy from user-level Codex state:

- tracked `.codex/config.toml`: project-scoped approval, sandbox, network, search, instruction,
  model, reasoning, service-tier, feature, and TUI defaults;
- tracked `.codex/agents/*.toml`: built-in subagent-role overrides pinned to the installed catalog's
  second model tier, inheriting the primary's default `xhigh` or explicit `max`/`ultra` effort, with
  no stronger or weaker model fallback;
- the user's normal Codex home: CLI installation, update detection, authentication, trust, sessions,
  logs, memory data, plugins, caches, and other mutable user state.

Start Codex directly from the repository root; no project runtime is required:

```bash
env -u NO_COLOR codex --cd "$PWD"
```

After explicit repository trust, Codex automatically loads this config while continuing to use the
user's normal Codex home. This keeps standalone update detection intact and avoids coupling Codex to
the project's Node.js or package manager. The repository does not write credentials or trust
records, auto-trust a clone, or set `CODEX_HOME`.

`bash scripts/setup/start-codex.sh` is an optional convenience wrapper for the same host-level
start. It selects this repository root and rejects conflicting root or policy overrides, but it does
not require mise, Node.js, pnpm, or project dependencies.

The repository root is intentionally the Codex and tooling workspace. Root `src/` is the default
Product Root; real declared pnpm packages and evidenced Android modules may add their contracted
source roots. Project policy, skills, instruction files, the fixed root `.context-index/` vector
space, and mutable agent state remain outside every product unit. Project `pnpm setup` materializes
and validates that vector space; starting Codex itself does not mutate project state.

The tracked project config intentionally carries portable defaults that may differ between projects.
It contains no credentials, provider secrets, telemetry targets, notification commands, trust
entries, absolute personal paths, local domains, or other machine-local/private values. Repository
validation reads the tracked policy and path layout only; it never reads user credentials or session
data.

After changing a project's portable model, subagent tier, reasoning, feature, or TUI defaults, run
`mise exec --locked -- pnpm codex:validate`. Security-boundary values remain fixed by the repository
policy unless that policy and its regression are deliberately changed.

Clean project initialization and portable export retain `.codex/config.toml`, `.codex/agents/`,
this README, and the launcher while excluding ignored local state. They also retain and validate the
separate Product Roots contract and default `src/` boundary. They never copy the user's Codex home.

Repository-owned skills live only under `.agents/skills/`. `.codex/skills/.system/`, when present in
the user-level cache, is Codex-provided content rather than project source.

See [Project Instructions](../instructions.md) for the project workflow.
