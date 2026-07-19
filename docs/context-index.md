# Context Index

The built-in context index is a local, CLI-only discovery aid for repositories that outgrow exact
search alone. It uses local Transformers.js embeddings and LanceDB storage in the single fixed,
ignored root directory `.context-index/`. This is the repository-wide vector space: it is separate
from every Product Root and cannot be redirected into `src/`, a workspace package, or an Android
module. It is not a source of truth, hosted service, daemon, UI, or paid provider.

## Use

```bash
pnpm context:search -- "concept or relationship"
pnpm context:check
pnpm context:index
pnpm context:clean
```

`pnpm setup` is the required initial materialization point. Setup builds the vector database,
downloads the pinned local embedding model when it is not cached, performs a real smoke search, and
prints the fixed `.context-index/` path plus freshness and build statistics. Setup fails when that
vector space is not current and usable.

After that bootstrap, `.codex/hooks.json` registers exactly one project-local Codex Stop hook. It
runs once at the end of a turn, enters the mise-pinned Node.js runtime, and calls the same lock-,
transaction-, and repair-safe incremental freshness path used by normal retrieval. It is not a
persistent watcher and does not run after individual tool calls. Before `.context-index/` exists,
the shell boundary exits successfully without invoking Node.js, mise, or index code.

Codex requires project hooks to be reviewed and approved locally by content hash through `/hooks`.
Hook and native worker output pass through the context worker sanitizer, so failures remain visible
without exposing absolute local paths. The Stop handler reports failure as a `systemMessage` but
returns success to Codex, preventing an unresolvable Stop loop; explicit maintenance remains
available through `context:index` and `context:check`. The production shell boundary clears every
ambient `CONTEXT_INDEX_*` redirect, test, scope, tuning, offline, and internal-worker variable
before entering mise, so a caller environment cannot move, narrow, or bypass sanitization for the
project index.

`context:search` is the normal semantic query entry point. Use it early for a concrete conceptual,
ownership, data-flow, or relationship question when no reliable exact anchor exists, terminology is
unfamiliar, or behavior and impact cross files; a failed `rg` attempt is not required first. It
verifies freshness, incrementally repairs stale or damaged state on demand, and returns five ranked
matches with three compact snippet lines by default; after an explicit cleanup it can also recreate
the state. It is useful only when the caller then reads every matched source used for a claim or
edit. `context:index` is an explicit maintenance/diagnostic command, not a routine development step.

`context:check` validates and, by default, repairs stale or corrupt generated state. Use
`pnpm context:check -- --no-repair --status-only` for a read-only structural status check.

Normal verification and pre-push are read-only with respect to the vector space and do not load the
embedding model or refresh the index. Setup intentionally performs the initial build and later setup
runs are incremental no-ops when the state is already current. An ignored model cache around tens of
megabytes is acceptable for a project base that may become a large project; repeated rebuild cost,
query memory, and search quality are the important constraints.

Boilerplate reset also preserves a legitimate ignored setup-created index. Use `context:clean` only
when index deletion is intentional; generated projects and portable exports still exclude all vector
and model state and bootstrap their own index.

The deterministic regression suite uses injected embeddings. Run `pnpm context:test:integration`
explicitly to exercise the cached real model and warm-offline CLI path.

## Source Boundary

- In Git worktrees, index tracked files plus non-ignored untracked active source. This combines
  active code, tests, configuration, skills, durable product docs, and the optional bounded
  `docs/project-context.md` working-memory cache.
- Exclude Git metadata, dependencies, build/generated output, process artifacts, local runtime,
  model/index state, binary/oversized files, secrets, sensitive path patterns, and every reserved
  repository-root Codex runtime path. This exclusion is unconditional because the supported project
  start always uses `CODEX_HOME="$PWD"`; it must not depend on the caller's current environment.
- Skip symlinks before reads.
- Without Git, scan the active project tree with the same generated/runtime/path exclusions.
- Project skill instructions are source; UI metadata and Codex system/runtime cache are not.

The manifest records source identity, chunk identity, model revision, and schema. Incremental
updates remove rows for deleted or re-chunked files and preserve unchanged embeddings. Metadata-only
changes replace only the manifest. Content changes use Lance versions and bounded record batches
instead of copying the whole database. Embedding reuse selects one manifest-known chunk ID per hash
and loads those vectors once through bounded `IN` batches.

Routine incremental completion validates row count, schema, and required indices without scanning
every chunk identity. Explicit deep checks and full repairs retain the complete fingerprint check,
reading ordered identities through a bounded cursor rather than materializing the table.

## Retrieval Contract

- Chunk by a tokenizer-aware budget that fits the model, using useful content boundaries where
  possible.
- Combine semantic and lexical evidence over a sufficiently broad candidate set so exact phrases and
  symbols are not buried by dense-only ranking.
- Keep result count, snippets, and terminal output bounded, deterministic, and sanitized.
- Work without network after the model is cached.
- Use ownership-aware locks; never delete a live writer's lock. Recover from interrupted or corrupt
  generated state without trusting partial data.
- Keep root, model cache, lock, and owned index state inside this project. Production commands bind
  index and model state to root `.context-index/`; custom index paths exist only for isolated tests.
  Product-root overlap, ownership markers, and generated-entry checks prevent cleanup from adopting
  source, runtime, or another project.
- Maintain full-text and scalar lookup/order indices; use HNSW vector search once the measured row
  threshold is reached, without adding an optimization pass to small indexes.

Use `rg` for exact queries whenever practical. A semantic search is incomplete until the returned
source files are read and used for the current decision; writing vectors alone is never an outcome.

## Changes And Verification

Changes to source policy, chunking, embeddings, schema, freshness, locks, ranking, or retrieval
dependencies should cover:

- unchanged, modified, added, and deleted files;
- exact and semantic relevance plus deterministic ordering;
- offline cached operation and first-use failure clarity;
- corrupt/partial state and concurrent writers;
- bounded latency and memory on representative repository sizes.

Use the repo-local `context-retrieval` skill for this work and an independent read-only retrieval
review when the change is substantial.
