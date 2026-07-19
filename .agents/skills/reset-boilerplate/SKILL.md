---
name: reset-boilerplate
description:
  Restore this repository to a reusable, product-neutral boilerplate baseline. Use whenever the
  boilerplate itself was optimized, or when the user asks to reset, clean, sanitize, make pristine,
  remove goals/slices/planning/history, or prepare the boilerplate for commit, export, or reuse.
---

# Reset Boilerplate

Use the deterministic reset boundary:

```bash
pnpm boilerplate:reset
pnpm boilerplate:reset --apply
```

The first command is a read-only preview and exits non-zero while reset candidates exist. Review its
exact list before using `--apply`.

## Workflow

1. Confirm this is the `codex-project` boilerplate and inspect Git status, branch, and remotes.
2. Preview the reset. Do not broaden deletion beyond reported boilerplate process/generated state.
3. Apply after any optimization of the boilerplate itself and whenever the user requests a reset.
   The script removes goal/slice/planning/review/handoff artifacts, optional active project context,
   project transaction state, generated exports, and now-empty placeholder directories. It preserves
   the ignored setup-created `.context-index/`; use `pnpm context:clean` only when explicit vector
   cleanup is intended.
4. Preserve `.git`, source code, dependencies, portable `.codex` policy, and every ignored
   repository-root Codex runtime path, including authentication, sessions, history, memory, caches,
   plugins, runtime skills, and databases. Never delete project Codex state or rewrite Git history
   implicitly.
5. Ensure `docs/project.md` remains the concise, product-neutral central truth. Remove
   product-specific source manually only when the user explicitly placed it in scope; the reset
   script never guesses.
6. Run the reset preview again, then the complete deterministic `pnpm verify` gate. Full
   verification includes the clean-baseline check, must fail if resettable state remains, and stays
   read-only with respect to the preserved local vector space.
7. Commit or push only when the user explicitly requested those external mutations.

Keep the result in code and configuration. Do not create reset reports, completion docs, or
archives.
