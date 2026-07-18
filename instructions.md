# Project Instructions

This file is the single committed workflow authority for the repository. Other entry documents
repeat only the guardrails needed to remain safe when opened alone; resolve workflow detail here.

## Production-Ready Means Code That Works

Deliver correct behavior at the owning boundary, regression evidence, secure defaults, and the
smallest durable explanation another developer actually needs. Production-ready does not mean
maximizing plans, project-management files, reviewers, gates, or prose.

Normal implementation should primarily change product code, tests, and necessary configuration.
Repository process artifacts are overhead unless the user explicitly requests one as a deliverable.

## Session Start

1. Run `bash scripts/setup/check-prereqs.sh`. Stop only when it reports a missing core requirement.
2. Read `README.md`, `docs/project.md`, and `docs/project-context.md` when the optional
   working-memory file exists.
3. Inspect the nearest source, tests, manifests, wrappers, and configuration for the requested work.
4. Use exact search first. Use semantic context search only when the owning boundary is unclear,
   then read every matched source file before editing or making claims.

Current files and command output outrank remembered conversation context.

## Product Roots

The repository root is the Codex and tooling workspace. Root `src/` is the required default product
root. Additional product units are activated only by repository evidence:

- a real package matched by `pnpm-workspace.yaml`, with its own `package.json` and `src/`, owns
  `<unit>/src` as implementation and the package directory as its product surface;
- a Gradle settings declaration plus a real module build file, Android manifest, and `src/main/`
  activates an Android product unit whose implementation root is `<module>/src/main`;
- arbitrary directories, examples, tooling, and name-like folders do not become product units.

When the user requests a web application, create or import the appropriate declared workspace
package and its source root as part of that task. Do not keep an empty `apps/web` in a neutral
project merely to imply a stack. Stack, web, SEO, sitemap, image, API, and adaptive verification use
this same Product Roots contract automatically.

Keep `.codex`, `.agents`, `AGENTS.md`, process state, and other Codex tooling outside every product
unit. The repository-wide semantic index has one fixed ignored location at root `.context-index/`;
it may index active repository context, but it is never product source and cannot be redirected into
a product unit. `pnpm setup` materializes and smoke-tests it; later searches refresh it
incrementally, while unrelated verification and pre-push stay read-only. Path hygiene enforces these
boundaries, including Git-less staged exports.

## Compact Project Memory

For non-trivial work, keep a concise in-session preflight covering the outcome, scope/non-goals,
material risks or decisions, likely owners, and verification. Do not write that preflight into the
repository.

If complex work must survive multiple sessions and the big picture cannot be recovered safely from
the manifest, code, tests, Git, and session history, create or update the single optional
`docs/project-context.md`. It is a compact working-memory cache, not a diary. Keep only:

- the current goal and its success condition;
- one current slice with a concrete outcome;
- essential invariants, constraints, and still-active decisions;
- blockers and the few next actions needed to resume.

Replace obsolete content instead of appending history. When the work finishes, move only genuinely
durable facts into code, tests, configuration, `docs/project.md`, or another canonical product
document, then delete the working file. Do not create separate goal, slice, task, status, progress,
handoff, review, audit, research, or completion-report files, and do not archive completed working
context.

`docs/project.md` is different: it is the always-read central truth for product intent, scope,
system shape, constraints, and durable decisions. Working context can specialize the current goal
but cannot override the manifest. If they disagree, resolve the durable truth in the manifest before
implementing further.

## Implementation

- Trace behavior to the failed invariant, producer, state transition, or contract. Fix that owner
  instead of adding duplicate caller guards.
- Run `pnpm stack:detect` before selecting or changing an application stack. Existing project
  evidence wins; never add a framework, service, database, or provider speculatively.
- Follow the active ecosystem's naming, layout, error, dependency, and test conventions.
- Prefer cohesive domain responsibilities and narrow contracts over generic `utils`, `common`, or
  catch-all modules.
- Keep maintained executable modules at or below 700 physical lines. Split an approaching module at
  cohesive ownership boundaries. Do not apply the quota to HTML, docs, styles, SQL, test corpora,
  fixtures, snapshots, generated output, or declarative context.
- Preserve compatible user changes and avoid destructive Git operations.
- Add or update tests at the boundary that owns the invariant. Tests are the default durable proof
  of implementation behavior.
- Check current official or primary sources only when a material decision depends on changing or
  specialized behavior. Record the decision, not the research transcript.

## Documentation Has A High Bar

Update an existing document, or create the smallest new one, only when at least one condition holds:

- the user explicitly requested documentation as an output;
- externally consumed usage, API, operational, migration, or support behavior changed;
- a durable product, architecture, security, data, provider, or deployment decision cannot be
  recovered reliably from code, tests, configuration, or an existing canonical document.

Prefer `docs/project.md` for project intent and constraints, the root README for setup/use, and an
existing focused document for an established surface. A new document needs a distinct audience,
owner, and maintenance reason.

Never create repository documentation merely to record a task plan, agent activity, command output,
review checklist, audit pass, progress update, implementation diary, handoff, or completion summary.
Keep those in the conversation. Do not add empty directory READMEs, speculative architecture docs,
or duplicated policy. A code-only change is allowed and expected when no durable contract changed;
the sole task-state exception is the bounded project-context lifecycle defined above.

## Security And Privacy

- Never commit credentials, tokens, private keys, personal paths, private data, local trust state,
  or machine-specific context.
- Define caller identity, authorization, input/resource limits, output/error behavior, logging, and
  exposure before implementing a public API. Abuse controls are project decisions, not boilerplate.
- Keep generated/local state, secrets, symlinks, dependencies, archives, and build output outside
  retrieval and portable exports.
- Project scripts must not inspect or modify the user's Codex home. Portable project defaults live
  in `.codex/`; mutable installation, auth, trust, sessions, logs, and caches do not.
- Use a focused security review only when changes affect trust, auth, secrets, user data,
  dependencies, shell execution, CI, infrastructure, or runtime configuration.

## Subagents

Use subagents only when separable discovery, implementation, or review materially improves the
result. Give each a bounded, non-overlapping scope and keep integration with the primary.

Project roles under `.codex/agents/` use the current second-tier model (`gpt-5.6-terra`) and inherit
the primary's reasoning effort (`xhigh` by default, or explicitly selected `max`/`ultra`). If that
tier is unavailable or no longer second in the installed catalog, keep the work with the primary and
report the mismatch.

The primary owns `.codex/config.toml`, `.codex/agents/**`, `AGENTS.md`, this file,
`.agents/skills/**`, `.codex/skills/**`, and skill/subagent metadata. Subagents may inspect but not
edit those surfaces.

## Context And Skills

- Exact names, paths, symbols, and strings: use `rg` or `rg --files`.
- Unknown wording, ownership, or cross-file concepts: use `pnpm context:search -- "query"`, then
  read only the returned sources relevant to the decision. The CLI defaults to five compact matches
  with three snippet lines each.
- Semantic results are discovery pointers, never authority; read every matched source used for a
  claim or edit. The Product Roots section owns the index boundary and lifecycle.
- Repository-owned skills live under `.agents/skills/`. A skill needs a distinct reusable workflow;
  do not duplicate general policy into every skill.

## Verification

Run the smallest focused regression while iterating. Use `pnpm verify:changed` for quick routing
when useful. Before handoff or push, run the complete deterministic `pnpm verify` gate once.

After any optimization of the boilerplate itself, run `pnpm boilerplate:reset --apply` first. The
full gate includes a read-only baseline check and refuses remaining goals, slices, process history,
generated exports, project context, local vector state, or dependency transaction state. This reset
never rewrites Git history or deletes `.codex` session/history/runtime state.

The complete gate covers syntax/format, tests, build/typecheck when present, repository contracts,
secrets, dependencies, and relevant product surfaces. Network-volatile registry or advisory checks
belong in `pnpm verify:external`, not every task gate. Pre-push remains read-only and validates the
objects being pushed.

Perform one bounded completion review after deterministic checks. Add specialized security,
code-pattern, content, image, or search review only for surfaces that actually changed. Fix
material, relevant, reproducible findings; do not create review documents or repeat broad review
loops without a failing check, new high-severity evidence, or an explicit user request.

## Done

Work is done when the requested behavior exists, focused evidence covers the changed invariant, the
complete gate passes, and no relevant high-severity finding remains. Report the result in the final
response; do not add a repository handoff document unless the user explicitly requested one.
