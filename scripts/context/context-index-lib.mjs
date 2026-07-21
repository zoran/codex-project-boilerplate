import { existsSync } from "node:fs";
import path from "node:path";
import { buildIndexUnlocked } from "./context-build.mjs";
import { ContextDatabaseSafetyError } from "./context-database.mjs";
import {
  embedTexts,
  embeddingDimensions,
  embeddingModel,
  embeddingModelRevision,
  embeddingProvider,
  embeddingRuntimeIdentity,
  inspectModelArtifacts,
  maxEmbeddingTokens,
  modelRevisionDirectory,
} from "./context-embedding.mjs";
import {
  describeMaintenance,
  maintainContextIndex,
  maintenanceChanged,
  mergeMaintenanceSummaries,
  validateContextMaintenanceState,
} from "./context-maintenance.mjs";
import {
  compareManifest,
  databaseBackend,
  loadManifestState,
  schemaVersion,
} from "./context-manifest.mjs";
import { withRebuildLock } from "./context-lock.mjs";
import { databaseGenerationReplacementRequired } from "./context-publication-policy.mjs";
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
  markIndexForRepair,
  markIndexTransactionForRepair,
  queryDatabase,
  recoverIndexTransaction,
  verifyDatabaseStructure,
} from "./context-storage.mjs";
import { defaultRoot, discoverSourceFiles } from "./source-policy.mjs";

export { ContextDatabaseSafetyError };

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
  describeMaintenance,
  embeddingDimensions,
  embeddingModel,
  embeddingModelRevision,
  embeddingProvider,
  maxEmbeddingTokens,
  maintenanceChanged,
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

function maintainIndexUnlocked() {
  return maintainContextIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    modelCachePath,
    selectedModelRevisionDirectory: modelRevisionDirectory(modelCachePath),
  });
}

function validateIndexMaintenanceState() {
  return validateContextMaintenanceState({
    indexDirectory,
    modelCachePath,
    selectedModelRevisionDirectory: modelRevisionDirectory(modelCachePath),
  });
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
      if (error instanceof ContextDatabaseSafetyError) throw error;
      freshness = freshnessWithDatabaseFailure(freshness, error);
    }
  }
  return { manifestState, currentSources, freshness };
}

async function buildFromEvaluation(
  evaluation,
  { reason, forceFull = false, replaceDatabase = false } = {},
) {
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
    replaceDatabase,
    discoveredSources: evaluation.currentSources,
  });
}

function hasPendingDatabaseContentChange(freshness) {
  return [freshness?.missing, freshness?.changed, freshness?.removed].some(
    (paths) => paths?.length > 0,
  );
}

function databaseReplacementRequired(evaluation) {
  return databaseGenerationReplacementRequired(evaluation.manifestState.manifest, {
    additionalOperations: hasPendingDatabaseContentChange(evaluation.freshness) ? 1 : 0,
  });
}

function isDatabaseHealthFailure(evaluation) {
  return evaluation.freshness.reason === "database health check failed";
}

async function prepareReplacementEvaluation() {
  const verified = await evaluateIndex({ verifyDatabase: "full" });
  if (!isDatabaseHealthFailure(verified)) {
    return { evaluation: verified, forceFull: false, replaceDatabase: true };
  }
  markIndexForRepair(indexDirectory, "selected database validation failed");
  return { evaluation: verified, forceFull: true, replaceDatabase: false };
}

async function buildAndSettleDatabase(
  evaluation,
  { reason, forceFull = false, replaceDatabase = false } = {},
) {
  if (replaceDatabase && !forceFull) {
    const prepared = await prepareReplacementEvaluation();
    evaluation = prepared.evaluation;
    forceFull = prepared.forceFull;
    replaceDatabase = prepared.replaceDatabase;
  }
  let built = await buildFromEvaluation(evaluation, {
    reason,
    forceFull,
    replaceDatabase,
  });
  const maintenance = [built.maintenance, maintainIndexUnlocked()];
  let final = await evaluateIndex({
    verifyDatabase: built.buildStats.databaseMode === "full" ? "full" : "light",
  });
  if (
    !forceFull &&
    !replaceDatabase &&
    databaseGenerationReplacementRequired(final.manifestState.manifest)
  ) {
    const prepared = await prepareReplacementEvaluation();
    built = await buildFromEvaluation(prepared.evaluation, {
      reason: "database affected-row replacement threshold reached",
      forceFull: prepared.forceFull,
      replaceDatabase: prepared.replaceDatabase,
    });
    maintenance.push(built.maintenance, maintainIndexUnlocked());
    final = await evaluateIndex({ verifyDatabase: "full" });
  }
  return {
    built,
    evaluation: final,
    maintenance: mergeMaintenanceSummaries(...maintenance),
  };
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
    const maintenance = [maintainIndexUnlocked()];
    const recovery = await recoverPendingTransaction({ discardUnrecoverable: true });
    const evaluation = await evaluateIndex({ verifyDatabase: "light" });
    const requiresFullDatabaseRepair = [
      "database health check failed",
      "database missing",
    ].includes(evaluation.freshness.reason);
    if (isDatabaseHealthFailure(evaluation)) {
      markIndexForRepair(indexDirectory, "selected database validation failed");
    }
    const replaceDatabase =
      !forceFull &&
      !requiresFullDatabaseRepair &&
      recovery.state !== "repair-required" &&
      databaseReplacementRequired(evaluation);
    if (
      evaluation.freshness.fresh &&
      !forceFull &&
      !replaceDatabase &&
      recovery.state !== "repair-required"
    ) {
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
          reclassifiedPaths: 0,
          databaseMode: "unchanged",
          databaseModificationOperations:
            evaluation.manifestState.manifest.stats.databaseModificationOperations,
          databaseModificationAffectedRows:
            evaluation.manifestState.manifest.stats.databaseModificationAffectedRows,
          databaseIndexComplete: evaluation.manifestState.manifest.stats.databaseIndexComplete,
          vectorIndexEnabled: evaluation.manifestState.manifest.stats.vectorIndexEnabled,
          durationMs: 0,
          reason: "already current",
        },
        maintenance: mergeMaintenanceSummaries(...maintenance),
      };
    }
    const fullRepair =
      forceFull || requiresFullDatabaseRepair || recovery.state === "repair-required";
    try {
      const settled = await buildAndSettleDatabase(evaluation, {
        reason: replaceDatabase ? "database replacement threshold reached" : reason,
        forceFull: fullRepair,
        replaceDatabase: replaceDatabase && !fullRepair,
      });
      return {
        ...settled.built,
        freshness: settled.evaluation.freshness,
        maintenance: mergeMaintenanceSummaries(...maintenance, settled.maintenance),
      };
    } catch (error) {
      try {
        maintainIndexUnlocked();
      } catch (maintenanceError) {
        throw new AggregateError(
          [error, maintenanceError],
          "Context rebuild failed and bounded candidate maintenance did not complete.",
        );
      }
      throw error;
    }
  });
}

export async function ensureFreshIndex({ repair = true, maintenance: runMaintenance = true } = {}) {
  return withContextRebuildLock(async () => {
    ensureContextIndexDirectory();
    const maintenance = runMaintenance ? [maintainIndexUnlocked()] : [];
    if (!runMaintenance) validateIndexMaintenanceState();
    const recovery = await recoverPendingTransaction({ discardUnrecoverable: repair });
    let evaluation = await evaluateIndex({ verifyDatabase: "light" });
    const initialFreshness = { ...evaluation.freshness };
    let rebuilt = false;
    let buildStats = null;
    if (repair && isDatabaseHealthFailure(evaluation)) {
      markIndexForRepair(indexDirectory, "selected database validation failed");
    }
    const replaceDatabase =
      repair &&
      recovery.state !== "repair-required" &&
      !isDatabaseHealthFailure(evaluation) &&
      databaseReplacementRequired(evaluation);
    if (
      repair &&
      (!evaluation.freshness.fresh || replaceDatabase || recovery.state === "repair-required")
    ) {
      const forceFull =
        recovery.state === "repair-required" ||
        ["database health check failed", "database missing"].includes(evaluation.freshness.reason);
      const settled = await buildAndSettleDatabase(evaluation, {
        reason: replaceDatabase
          ? "database replacement threshold reached"
          : evaluation.freshness.reason,
        forceFull,
        replaceDatabase: replaceDatabase && !forceFull,
      });
      rebuilt = true;
      buildStats = settled.built.buildStats;
      maintenance.push(settled.maintenance);
      evaluation = settled.evaluation;
    }
    return {
      manifest: evaluation.manifestState.manifest,
      freshness: evaluation.freshness,
      initialFreshness,
      rebuilt,
      buildStats,
      maintenance: mergeMaintenanceSummaries(...maintenance),
    };
  });
}

export async function inspectIndexStatus() {
  assertContextIndexDirectory();
  const maintenance = validateIndexMaintenanceState();
  const evaluation = await evaluateIndex({ verifyDatabase: "light" });
  if (indexRepairRequired(indexDirectory)) {
    evaluation.freshness = {
      ...evaluation.freshness,
      fresh: false,
      reason: "full database repair required",
    };
  } else if (maintenance.pending) {
    evaluation.freshness = {
      ...evaluation.freshness,
      fresh: false,
      reason: "interrupted context index state requires maintenance",
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
  if (freshness.classificationsChanged) details.push("source classifications changed");
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

export async function searchIndex(
  query,
  {
    limit = 5,
    maintenance = true,
    embedQuery = (texts) => embedTexts(texts, modelCachePath),
    querySelectedDatabase = queryDatabase,
  } = {},
) {
  const queryText = query.trim();
  if (!queryText) return [];
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 5, 50));
  return withContextRebuildLock(async () => {
    if (maintenance) maintainIndexUnlocked();
    await recoverPendingTransaction();
    if (!existsSync(databasePath) || !existsSync(tablePath)) {
      throw new Error("Context vector database is missing.");
    }
    const vector = (await embedQuery([queryText]))[0];
    const lexicalQuery = normalizeSearchText(queryText);
    const { denseResults, allRows } = await querySelectedDatabase({
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
  await withContextRebuildLock(() => {
    maintainIndexUnlocked();
    return recoverPendingTransaction().then(() =>
      verifyDatabaseStructure({ databasePath, tableName, manifest, embeddingDimensions }),
    );
  });
  const results = await searchIndex("context retrieval smoke test", {
    limit: 1,
    maintenance: false,
  });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Context vector database smoke search returned no rows.");
  }
}
