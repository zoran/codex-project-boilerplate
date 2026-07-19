---
name: context-retrieval
description:
  Discover repository context through exact local search and the setup-created semantic index. Use
  for ordinary broad orientation, missing exact anchors, unfamiliar terminology, unknown ownership,
  cross-file relationships, or any change to indexing, embeddings, chunking, ranking, freshness,
  cache, or retrieval dependencies. Always read matched source files before edits or claims.
---

# Context Retrieval

Use the cheapest reliable retrieval path:

1. Use `rg` or known paths for exact text, symbols, filenames, and narrow questions.
2. When no reliable exact anchor exists, use `pnpm context:search -- "concept or relationship"`
   early for broad orientation, unfamiliar terminology, unknown ownership, behavior distributed
   across files, cross-file impact, or ambiguous exact results. A failed `rg` search is not a
   prerequisite; prefer semantic discovery to broad blind file reading.
3. Ask one concrete responsibility, behavior, data-flow, or relationship question rather than a
   generic task dump. Refine once when the first result exposes better repository terminology.
4. Treat results only as discovery pointers: read every matched source used for a claim or edit,
   then return to exact search and direct source inspection.
5. Use `pnpm context:check` for strictly read-only structural diagnostics. Use `context:index` for
   explicit maintenance or repair; semantic search retains bounded on-demand repair.
6. Read the returned source files directly. Retrieval output is a hint, never authority.

Project initialization is the one intentional bootstrap: `pnpm setup` must leave a current, usable
vector space and print its fixed location and statistics. After bootstrap, the trusted project Stop
hook incrementally refreshes changed sources once per Codex turn through the mise-pinned runtime; it
is not a watcher or a per-tool hook. Outside that lifecycle, do not prebuild or refresh the index as
ceremony. Use semantic search only with a concrete retrieval question, and stop if exact search is
cheaper. `context:index` is for explicit maintenance or diagnostics; vector writes alone are not
useful work.

## Index Contract

- The repository provides local embeddings and storage so generated projects work without a hosted
  service. Production vector and model state has one fixed, ignored home at root `.context-index/`,
  outside every Product Root; path overrides are test-only. The ignored model/index size is
  acceptable; steady-state latency and memory matter more.
- Index only active, Git-aware project sources, combining code, tests, configuration, skills,
  durable docs, and the optional bounded project-context cache. Skip process history, ignored
  output, runtime state, secrets, symlinks, generated caches, and the index itself.
- Chunk by token budget and useful boundaries, not a fixed physical-line rule.
- Refresh changed files incrementally and remove deleted files. Setup performs the initial build and
  a real smoke search, then becomes an incremental no-op while current. The locally hash-trusted
  Stop hook owns turn-boundary freshness; semantic search retains repair. Unrelated verification,
  pre-push, and project reset remain read-only and must not rebuild or remove the index.
- Before bootstrap the hook must exit without Node.js, mise, or index access. Route hook and native
  output through the sanitized context worker, never emit absolute local paths, and surface failures
  without creating a Stop loop.
- Exact lexical matches must not be hidden behind a small dense candidate set. Ranking and output
  must be deterministic, bounded, and safe for terminal display.
- Work offline after the model is cached. Locks must be ownership-safe, and corrupt or partial state
  must fail clearly or repair itself without deleting a live build.

When changing retrieval internals, test unchanged, modified, added, deleted, offline, corrupt-state,
concurrent, exact-match, semantic-match, ranking, latency, and memory cases proportionally. Use a
separate read-only retrieval review when the change is substantial and independent review is useful.
