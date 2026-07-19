# Codex Project Config

This repository separates portable project policy from mutable repository-root Codex runtime:

- tracked `.codex/config.toml`: project-scoped approval, sandbox, network, search, instruction,
  model, reasoning, service-tier, feature, and TUI defaults;
- tracked `.codex/hooks.json`: one project-local Stop hook whose command is reviewed and approved
  locally by content hash through `/hooks`;
- tracked `.codex/agents/*.toml`: built-in subagent-role overrides pinned to the installed catalog's
  second model tier, inheriting the primary's default `xhigh` or explicit `max`/`ultra` effort, with
  no stronger or weaker model fallback; roles follow the same exact-versus-semantic retrieval triage
  as the primary thread and read matched sources directly;
- ignored repository-root Codex runtime: authentication, trust, sessions, logs, memory data, plugins,
  caches, runtime skills, history, installation/model metadata, and Codex databases.

Run the supported command exactly from the repository root; no project runtime is required:

```bash
codex update && CODEX_HOME="$PWD" codex --cd "$PWD"
```

The first command performs the system-wide CLI update without project isolation. The `&&` prevents
startup after an update failure. Only the second command sets the canonical repository root as
`CODEX_HOME`, so each project owns its mutable Codex runtime without polluting a global user home.
Root-bound ignore rules and the shared source inventory exclude that state from Git and all portable
or source-consuming workflows. The repository never writes credentials or trust into tracked
configuration and never auto-trusts a clone or approves a hook.

`bash scripts/setup/start-codex.sh` is an optional convenience wrapper for the same ordered start. It
runs the update with `CODEX_HOME` unset, then sets `CODEX_HOME` and `--cd` to the canonical repository
root. It rejects conflicting root or policy overrides and requires neither mise, Node.js, pnpm, nor
project dependencies.

The repository root is intentionally the Codex and tooling workspace. Root `src/` is the default
Product Root; real declared pnpm packages and evidenced Android modules may add their contracted
source roots. Project policy, skills, instruction files, the fixed root `.context-index/` vector
space, and mutable agent state remain outside every product unit. Project `pnpm setup` materializes
and validates that vector space. Before bootstrap the Stop hook exits without touching Node.js,
mise, or index state; afterward it uses the mise-pinned Node.js runtime to refresh changed sources
once per turn. It is not a persistent watcher or a per-tool hook.

The tracked project config intentionally carries portable defaults that may differ between projects.
It contains no credentials, provider secrets, telemetry targets, notification commands, trust
entries, absolute personal paths, local domains, or other machine-local/private values. Repository
validation reads the tracked policy and path layout only; it never reads user credentials or session
data.

After changing a project's portable model, subagent tier, reasoning, feature, TUI, or hook defaults,
run `mise exec --locked -- pnpm codex:validate`. Review and approve a changed hook hash separately
through `/hooks`. Security-boundary values remain fixed by repository policy unless that policy and
its regression are deliberately changed.

Clean project initialization and portable export retain `.codex/config.toml`, `.codex/hooks.json`,
`.codex/agents/`, this README, and the hook and launcher scripts while excluding repository-root
Codex runtime. They also retain and validate the separate Product Roots contract and default `src/`
boundary. They never copy authentication, sessions, databases, or local hook trust state.

Repository-owned skills live only under `.agents/skills/`. Root `skills/`, when created by Codex, is
ignored runtime content rather than project source.

See [Project Instructions](../instructions.md) for the project workflow.
