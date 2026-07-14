---
name: context-retrieval
description:
  Discover repository context with exact local search and an optional built-in semantic index. Use
  for broad orientation, unknown ownership, cross-file relationship questions, or any change to
  indexing, embeddings, chunking, ranking, freshness, cache, or retrieval dependencies. Always read
  matched source files before edits or claims.
---

# Context Retrieval

Use the cheapest reliable retrieval path:

1. Use `rg` or known paths for exact text, symbols, filenames, and narrow questions.
2. Use `pnpm context:search -- "concept or relationship"` when wording or ownership is unknown.
   Search incrementally refreshes the setup-created local index, can recreate it after explicit
   cleanup, and returns five short matches by default.
3. Use `pnpm context:check -- --no-repair --status-only` for read-only structural diagnostics. Use
   `pnpm context:check` only when explicit validation with bounded repair is intended.
4. Read the returned source files directly. Retrieval output is a hint, never authority.

Project initialization is the one intentional bootstrap: `pnpm setup` must leave a current, usable
vector space and print its fixed location and statistics. Outside setup, do not prebuild or refresh
the index as ceremony. Run semantic search only with a concrete retrieval question, use its results
to select authoritative source reads, and stop if exact search is cheaper. `context:index` is for
explicit maintenance or diagnostics; vector writes alone are not useful work.

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
  a real smoke search, then becomes an incremental no-op while current. Unrelated verification and
  pre-push remain read-only and must not rebuild.
- Exact lexical matches must not be hidden behind a small dense candidate set. Ranking and output
  must be deterministic, bounded, and safe for terminal display.
- Work offline after the model is cached. Locks must be ownership-safe, and corrupt or partial state
  must fail clearly or repair itself without deleting a live build.

When changing retrieval internals, test unchanged, modified, added, deleted, offline, corrupt-state,
concurrent, exact-match, semantic-match, ranking, latency, and memory cases proportionally. Use a
separate read-only retrieval review when the change is substantial and independent review is useful.
