import { existsSync } from "node:fs";
import path from "node:path";
import { buildIndexUnlocked } from "./context-build.mjs";
import {
  embedTexts,
  embeddingDimensions,
  embeddingModel,
  embeddingModelRevision,
  embeddingProvider,
  embeddingRuntimeIdentity,
  inspectModelArtifacts,
  maxEmbeddingTokens,
} from "./context-embedding.mjs";
import {
  compareManifest,
  databaseBackend,
  loadManifestState,
  schemaVersion,
} from "./context-manifest.mjs";
import { withRebuildLock } from "./context-lock.mjs";
import {
  assertSafeIndexDirectory,
  assertOwnedIndexDirectory,
  ensureOwnedDirectory,
  ensureOwnedIndexDirectory,
  resolveOwnedDirectory,
  resolveRepositoryRoot,
} from "./context-paths.mjs";
import { normalizeSearchText, rankHybridResults } from "./context-ranking.mjs";
import {
  indexRepairRequired,
  markIndexTransactionForRepair,
  queryDatabase,
  recoverIndexTransaction,
  verifyDatabaseStructure,
} from "./context-storage.mjs";
import { defaultRoot, discoverSourceFiles } from "./source-policy.mjs";

if (!process.env.RUST_LOG) process.env.RUST_LOG = "error";

const testMode = process.env.CONTEXT_INDEX_TEST_MODE === "1";
if (process.env.CONTEXT_INDEX_ROOT && !testMode) {
  throw new Error("CONTEXT_INDEX_ROOT is test-only; context commands are bound to this project.");
}
if (process.env.CONTEXT_INDEX_DIRECTORY && !testMode) {
  throw new Error(
    "CONTEXT_INDEX_DIRECTORY is test-only; project context state is fixed at .context-index.",
  );
}
if (process.env.CONTEXT_INDEX_MODEL_CACHE) {
  throw new Error(
    "CONTEXT_INDEX_MODEL_CACHE is unsupported; each project owns its model cache under its context index.",
  );
}
export const root = resolveRepositoryRoot(
  testMode && process.env.CONTEXT_INDEX_ROOT ? process.env.CONTEXT_INDEX_ROOT : defaultRoot,
);
export const indexDirectory = assertSafeIndexDirectory(
  root,
  testMode && process.env.CONTEXT_INDEX_DIRECTORY
    ? process.env.CONTEXT_INDEX_DIRECTORY
    : path.join(root, ".context-index"),
);
export const databasePath = path.join(indexDirectory, "lancedb");
export const modelCachePath = resolveOwnedDirectory({
  repositoryRoot: root,
  configuredPath: path.join(indexDirectory, "model-cache"),
  label: "Context model cache directory",
});
export const manifestPath = path.join(indexDirectory, "manifest.json");
export const tableName = "context_chunks";
export const tablePath = path.join(databasePath, `${tableName}.lance`);
export const rebuildLockPath = path.join(
  root,
  ".codex",
  "runtime",
  "cache",
  "context-index-rebuild.lock",
);
export {
  databaseBackend,
  embeddingDimensions,
  embeddingModel,
  embeddingModelRevision,
  embeddingProvider,
  maxEmbeddingTokens,
  schemaVersion,
};

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function relativeFromRoot(filePath) {
  return toPosix(path.relative(root, filePath)) || ".";
}

export function normalizeCliArgs(args) {
  return args.filter((arg) => arg !== "--");
}

export function ensureContextIndexDirectory() {
  return ensureOwnedIndexDirectory({
    repositoryRoot: root,
    indexDirectory,
  });
}

export function assertContextIndexDirectory({ allowMissing = true } = {}) {
  return assertSafeIndexDirectory(root, indexDirectory, { allowMissing });
}

export function assertContextIndexOwnership({ allowMissing = true } = {}) {
  return assertOwnedIndexDirectory({
    repositoryRoot: root,
    indexDirectory,
    allowMissing,
  });
}

export function withContextRebuildLock(action) {
  assertContextIndexDirectory();
  ensureOwnedDirectory({
    repositoryRoot: root,
    configuredPath: path.dirname(rebuildLockPath),
    label: "Context runtime cache directory",
  });
  return withRebuildLock({ rebuildLockPath, toPosix: relativeFromRoot }, action);
}

export function loadManifest() {
  assertContextIndexDirectory();
  return loadManifestState(manifestPath).manifest;
}

function freshnessWithDatabaseFailure(freshness, error) {
  return {
    ...freshness,
    fresh: false,
    reason: "database health check failed",
    healthError: error instanceof Error ? error.message : String(error),
  };
}

function currentComparison(manifestState, currentSources) {
  return compareManifest({
    manifestState,
    databasePath,
    tablePath,
    runtimeIdentity: embeddingRuntimeIdentity(),
    modelArtifacts: inspectModelArtifacts(modelCachePath),
    currentSources,
  });
}

async function evaluateIndex({ verifyDatabase = "light" } = {}) {
  const manifestState = loadManifestState(manifestPath);
  const currentSources = discoverSourceFiles({
    repositoryRoot: root,
    previousFiles: manifestState.manifest?.files ?? [],
  });
  let freshness = currentComparison(manifestState, currentSources);
  if (
    manifestState.manifest &&
    verifyDatabase &&
    existsSync(databasePath) &&
    existsSync(tablePath)
  ) {
    try {
      await verifyDatabaseStructure({
        databasePath,
        tableName,
        manifest: manifestState.manifest,
        embeddingDimensions,
        verifyFingerprint: verifyDatabase === "full",
      });
    } catch (error) {
      freshness = freshnessWithDatabaseFailure(freshness, error);
    }
  }
  return { manifestState, currentSources, freshness };
}

async function buildFromEvaluation(evaluation, { reason, forceFull = false } = {}) {
  ensureOwnedDirectory({
    repositoryRoot: root,
    configuredPath: modelCachePath,
    label: "Context model cache directory",
  });
  return buildIndexUnlocked({
    repositoryRoot: root,
    indexDirectory,
    databasePath,
    manifestPath,
    modelCachePath,
    tableName,
    embeddingDimensions,
    relativeFromRoot,
    previousManifest: evaluation.manifestState.manifest,
    reason: reason ?? evaluation.freshness.reason,
    forceFull,
    discoveredSources: evaluation.currentSources,
  });
}

async function recoverPendingTransaction({ discardUnrecoverable = false } = {}) {
  if (!existsSync(indexDirectory)) return { state: "none" };
  if (indexRepairRequired(indexDirectory)) {
    if (discardUnrecoverable) return { recovered: true, state: "repair-required" };
    throw new Error("Context database has a durable full-repair marker.");
  }
  try {
    return await recoverIndexTransaction({ indexDirectory, databasePath, manifestPath, tableName });
  } catch (error) {
    if (!discardUnrecoverable) throw error;
    markIndexTransactionForRepair(indexDirectory);
    return { recovered: true, state: "repair-required", error };
  }
}

export async function buildIndex({ forceFull = false, reason = "manual rebuild requested" } = {}) {
  return withContextRebuildLock(async () => {
    ensureContextIndexDirectory();
    const recovery = await recoverPendingTransaction({ discardUnrecoverable: true });
    const evaluation = await evaluateIndex({ verifyDatabase: "light" });
    const requiresFullDatabaseRepair = [
      "database health check failed",
      "database missing",
    ].includes(evaluation.freshness.reason);
    if (evaluation.freshness.fresh && !forceFull && recovery.state !== "repair-required") {
      return {
        manifest: evaluation.manifestState.manifest,
        freshness: evaluation.freshness,
        buildStats: {
          reusedChunks: evaluation.manifestState.manifest.stats.chunks,
          embeddedChunks: 0,
          embeddedVectors: 0,
          addedFiles: 0,
          changedFiles: 0,
          removedFiles: 0,
          processedFiles: 0,
          sourceFilesRead: evaluation.currentSources.filesRead,
          sourceBytesRead: evaluation.currentSources.bytesRead,
          modelHashReused: true,
          databaseMode: "unchanged",
          durationMs: 0,
          reason: "already current",
        },
      };
    }
    const fullRepair =
      forceFull || requiresFullDatabaseRepair || recovery.state === "repair-required";
    const built = await buildFromEvaluation(evaluation, {
      reason,
      forceFull: fullRepair,
    });
    const final = await evaluateIndex({ verifyDatabase: fullRepair ? "full" : "light" });
    return { ...built, freshness: final.freshness };
  });
}

export async function ensureFreshIndex({ repair = true } = {}) {
  return withContextRebuildLock(async () => {
    ensureContextIndexDirectory();
    const recovery = await recoverPendingTransaction({ discardUnrecoverable: repair });
    let evaluation = await evaluateIndex({ verifyDatabase: "light" });
    const initialFreshness = { ...evaluation.freshness };
    let rebuilt = false;
    let buildStats = null;
    if (repair && (!evaluation.freshness.fresh || recovery.state === "repair-required")) {
      const forceFull =
        recovery.state === "repair-required" ||
        ["database health check failed", "database missing"].includes(evaluation.freshness.reason);
      const built = await buildFromEvaluation(evaluation, {
        reason: evaluation.freshness.reason,
        forceFull,
      });
      rebuilt = true;
      buildStats = built.buildStats;
      evaluation = await evaluateIndex({ verifyDatabase: forceFull ? "full" : "light" });
    }
    return {
      manifest: evaluation.manifestState.manifest,
      freshness: evaluation.freshness,
      initialFreshness,
      rebuilt,
      buildStats,
    };
  });
}

export async function inspectIndexStatus() {
  assertContextIndexDirectory();
  const evaluation = await evaluateIndex({ verifyDatabase: "light" });
  if (indexRepairRequired(indexDirectory)) {
    evaluation.freshness = {
      ...evaluation.freshness,
      fresh: false,
      reason: "full database repair required",
    };
  }
  return {
    manifest: evaluation.manifestState.manifest,
    freshness: evaluation.freshness,
    initialFreshness: { ...evaluation.freshness },
    rebuilt: false,
    buildStats: null,
  };
}

export async function forceRepairIndex(reason = "forced repair after database access failure") {
  return buildIndex({ forceFull: true, reason });
}

export function describeFreshness(freshness) {
  if (freshness.fresh) {
    return `current (${freshness.currentFileCount} file(s), ${freshness.indexedFileCount} indexed)`;
  }
  const details = [freshness.reason].filter(Boolean);
  if (freshness.missing?.length > 0) details.push(`${freshness.missing.length} added file(s)`);
  if (freshness.changed?.length > 0) details.push(`${freshness.changed.length} changed file(s)`);
  if (freshness.snapshotChanged?.length > 0) {
    details.push(`${freshness.snapshotChanged.length} metadata-only file(s)`);
  }
  if (freshness.removed?.length > 0) details.push(`${freshness.removed.length} removed file(s)`);
  return details.join(", ") || "not current";
}

export function describeBuildStats(buildStats) {
  if (!buildStats) return "no rebuild";
  return [
    `${buildStats.reusedChunks} reused chunk(s)`,
    `${buildStats.embeddedChunks} embedded chunk(s)`,
    `${buildStats.addedFiles} added file(s)`,
    `${buildStats.changedFiles} changed file(s)`,
    `${buildStats.removedFiles} removed file(s)`,
    `${buildStats.durationMs} ms`,
  ].join(", ");
}

export async function searchIndex(query, { limit = 5 } = {}) {
  const queryText = query.trim();
  if (!queryText) return [];
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 5, 50));
  return withContextRebuildLock(async () => {
    await recoverPendingTransaction();
    if (!existsSync(databasePath) || !existsSync(tablePath)) {
      throw new Error("Context vector database is missing.");
    }
    const vector = (await embedTexts([queryText], modelCachePath))[0];
    const lexicalQuery = normalizeSearchText(queryText);
    const { denseResults, allRows } = await queryDatabase({
      databasePath,
      tableName,
      vector,
      query: lexicalQuery,
      denseLimit: Math.max(boundedLimit * 4, 32),
      lexicalLimit: Math.max(boundedLimit * 8, 64),
    });
    return rankHybridResults({ denseResults, allRows, query: queryText, limit: boundedLimit });
  });
}

export async function verifyUsableIndex(manifest = loadManifest()) {
  if (!manifest) throw new Error("Context manifest is missing or invalid.");
  await withContextRebuildLock(() =>
    recoverPendingTransaction().then(() =>
      verifyDatabaseStructure({ databasePath, tableName, manifest, embeddingDimensions }),
    ),
  );
  const results = await searchIndex("context retrieval smoke test", { limit: 1 });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Context vector database smoke search returned no rows.");
  }
}
