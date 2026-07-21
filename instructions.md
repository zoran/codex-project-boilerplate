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

1. Start Codex from the repository root with the exact supported command
   `codex update && CODEX_HOME="$PWD" codex --cd "$PWD"`. The update is system-wide; the `&&` must
   prevent project startup after an update failure, and only the second command receives the
   project-local `CODEX_HOME`.
2. Run `bash scripts/setup/check-prereqs.sh`. Stop only when it reports a missing core requirement.
3. Read `README.md`, `docs/project.md`, and `docs/project-context.md` when the optional
   working-memory file exists.
4. Inspect the nearest source, tests, manifests, wrappers, and configuration for the requested work.
5. Establish the owning boundary before broad repository exploration. Use known paths or `rg` for
   exact names, symbols, and narrow questions. When no reliable exact anchor exists, ownership is
   unclear, or the task depends on broad orientation, unfamiliar terminology, or cross-file
   relationships, use `$context-retrieval` or `pnpm context:search -- "concept or relationship"`
   early, then read every matched source used for a claim or edit. A failed exact search is not a
   prerequisite.

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
unit. The repository root is intentionally the isolated Codex home. Mutable authentication, trust,
session, log, memory, cache, plugin, runtime-skill, history, installation, model, and database state
is reserved there by a shared root-relative classifier and matching `.gitignore` rules. It must
never enter active source, formatting, the semantic index, generated projects, staging, or exports.
Portable `.codex/config.toml`, `.codex/hooks.json`, `.codex/agents/*.toml`, and `.codex/README.md`
remain tracked. The repository-wide semantic index has one fixed ignored root `.context-index/`; it
may index active repository context, but it is never product source and cannot be redirected into a
product unit. `pnpm setup` materializes and smoke-tests it. Once bootstrapped, the locally trusted
project Stop hook refreshes changed sources once per Codex turn; semantic search retains on-demand
repair, while unrelated verification and pre-push stay read-only. This is neither a watcher nor a
per-tool refresh. New or changed hook definitions require local hash-bound approval through
`/hooks`; no script may approve them automatically. Path hygiene enforces these boundaries,
including Git-less staged exports.

Explicit indexing and semantic search also run bounded opportunistic maintenance under the existing
context lock. It preserves the selected database and model revision and removes only validated stale
generated artifacts; unsafe or ambiguous state fails closed. Incremental database pressure replaces
the complete selected generation atomically at the documented operation/affected-row thresholds,
reusing only vectors from a deep-validated generation and never during corruption repair.
`context:check`, ordinary verification, pre-push, and unrelated lifecycle commands remain strictly
read-only. The canonical details live in `docs/context-index.md`.

Git and Git-less source inventory use repository `.gitignore` rules plus a built-in pre-descent mask
from the same root-runtime authority. Host-global and repository-local Git exclude files cannot hide
active source. Private Root-CODEX_HOME, `.codex` runtime, index, and process state are rejected
before directory descent even when no Git metadata or usable source `.gitignore` exists. A temporary
local `.git/info/exclude` mask is migration-only: remove it as soon as the isolated effective-ignore
validator proves the tracked worktree `.gitignore` contract. Local masks never count as proof, never
enter portable output, and any active repository-local Git exclude rule blocks `pnpm goal:new`.
Source inventory, generator source-state checks, and `goal:new` bind root-owned Git metadata with
the canonical worktree and pin stat checks. Goal publication compares worktree content through a
fresh temporary index; policy-sensitive probes disable repository-local FSMonitor execution and
reject hidden index flags. A Git-less root beneath another repository remains Git-less. The staged
validator runs from the copied stage, derives its target from its own script rather than a
caller-selected stage path, and rechecks the bound directory identity through validation.

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
- Whole-repository course checks are mandatory after initial planning/discovery, at every resume or
  context-recovery point, after every significant implementation milestone, whenever scope or
  assumptions change, and before closure. Reconcile the objective and manifest with touched owners
  and consumers, product/runtime boundaries, security and operational effects, tests, documentation
  contracts, and unrelated worktree state. Update the in-session plan when the work has drifted; do
  not let a feature or fix become an isolated patch that weakens the surrounding system.
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
- The supported Codex home is the canonical repository root, never the user's global Codex home.
  Portable project defaults live in tracked `.codex/`; mutable authentication, trust, sessions,
  logs, memories, caches, plugins, runtime skills, history, installation/model metadata, and Codex
  databases remain ignored root runtime and must not enter Git or any project-source consumer.
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
edit those surfaces. Delegated agents report whole-repository impact to the primary but do not
commit or push; goal integration and publication remain primary-thread responsibilities.

## Context And Skills

- Exact names, paths, symbols, and strings: use `rg` or `rg --files`.
- When no reliable exact anchor exists, use semantic retrieval early for broad orientation,
  unfamiliar terminology, unknown ownership, behavior distributed across files, cross-file impact,
  or ambiguous exact results. A failed `rg` attempt is not required first.
- Ask a concrete responsibility, behavior, data-flow, or relationship question with
  `pnpm context:search -- "concept or relationship"`; do not submit a generic task dump. The CLI
  defaults to five compact matches with three snippet lines each.
- Read every matched source used for a claim or edit, then return to exact search and direct source
  inspection. Results are discovery pointers, never authority. Do not invoke semantic search merely
  to prove that the index was used.
- The Product Roots section owns the index boundary and lifecycle.
- Repository-owned skills live under `.agents/skills/`. A skill needs a distinct reusable workflow;
  do not duplicate general policy into every skill.

## Verification

Run the smallest focused regression while iterating. Use `pnpm verify:changed` for quick routing
when useful. Before handoff or push, run the complete deterministic `pnpm verify` gate once.

After any optimization of the boilerplate itself, run `pnpm boilerplate:reset --apply` first. The
full gate includes a read-only baseline check and refuses remaining goals, slices, process history,
generated exports, project context, or dependency transaction state. The reset preserves the ignored
setup-created `.context-index/` so verification stays read-only and the Stop hook can remain
incremental; use `pnpm context:clean` only for an explicit index deletion. The reset never rewrites
Git history or deletes repository-root Codex runtime state.

The complete gate covers syntax/format, tests, build/typecheck when present, repository contracts,
secrets, dependencies, and relevant product surfaces. Network-volatile registry or advisory checks
belong in `pnpm verify:external`, not every task gate. Pre-push remains read-only and validates the
objects being pushed.

A goal is complete only when its requested outcome, owning-boundary implementation, focused
evidence, required reviews, applicable reset, and complete gate are all green. At that point the
primary commits exactly the goal-owned changes and pushes the current branch to its configured
upstream. If unrelated changes cannot be safely separated, no upstream is configured, authentication
is unavailable, or the push is rejected, report the goal-closure blocker instead of broadening the
commit, bypassing checks, force-pushing, or rewriting history.

Before opening any subsequent goal, run `mise exec --locked -- pnpm goal:new`. This command is the
supported new-goal entry gate rather than a task-state document: it performs no fetch, commit, or
push and creates no planning artifact. It fails closed unless it can prove that the canonical
project is on a named branch with a clean non-ignored worktree, a commit, a configured upstream, and
zero commits ahead or behind its locally recorded remote-tracking ref. A missing repository,
detached branch, local-branch pseudo-upstream, missing remote/upstream, dirty worktree, malformed
Git result, or local/upstream difference blocks the new goal. The gate does not contact the remote;
the required preceding push owns authentication and updates the local remote-tracking publication
evidence. Ignored project-local Codex runtime and `.context-index/` do not count as unfinished work.

Perform one bounded completion review after deterministic checks. Add specialized security,
code-pattern, content, image, or search review only for surfaces that actually changed. Fix
material, relevant, reproducible findings; do not create review documents or repeat broad review
loops without a failing check, new high-severity evidence, or an explicit user request.

## Done

Work is done when the requested behavior exists, focused evidence covers the changed invariant, the
complete gate passes, no relevant high-severity finding remains, and required goal-closure
commit/push work has succeeded or is reported as an external blocker. Report the result in the final
response; do not add a repository handoff document unless the user explicitly requested one.
