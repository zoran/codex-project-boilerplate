import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  batches,
  getLanceDb,
  sqlString,
  verifyDatabaseStructure,
  withDatabase,
} from "./context-database.mjs";
import { hashContent } from "./context-hashing.mjs";
import { maintainContextIndex, mergeMaintenanceSummaries } from "./context-maintenance.mjs";
import { safeArtifactStats, validateRemovalTree } from "./context-maintenance-safety.mjs";

export const defaultVectorIndexThreshold = 1_000;
export { verifyDatabaseStructure };
export {
  explainDenseQueryPlan,
  explainFilterQueryPlan,
  fingerprintReadBatchSize,
  inspectDatabaseIndices,
  loadReusableRows,
  queryDatabase,
  queryReusableRowsInBatches,
  reusableLookupBatchSize,
} from "./context-database.mjs";
const transactionFileName = "database-transaction.json";
const repairMarkerFileName = "database-repair-required.json";

function transactionPathFor(indexDirectory) {
  return path.join(indexDirectory, transactionFileName);
}

function repairMarkerPathFor(indexDirectory) {
  return path.join(indexDirectory, repairMarkerFileName);
}

export function cleanupGeneratedIndexDebris(indexDirectory, options = {}) {
  return maintainContextIndex({ indexDirectory, ...options });
}

function safeRename(source, destination) {
  if (existsSync(source)) renameSync(source, destination);
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeTemporaryManifest(temporaryManifestPath, manifest) {
  const content = manifestText(manifest);
  writeFileSync(temporaryManifestPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return content;
}

function safeManifestHash(manifestPath) {
  try {
    const stats = lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) return null;
    return hashContent(readFileSync(manifestPath));
  } catch {
    return null;
  }
}

function readTransaction(transactionPath) {
  if (!existsSync(transactionPath)) return null;
  const stats = lstatSync(transactionPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error("Context database transaction journal is not a safe regular file.");
  }
  let transaction;
  try {
    transaction = JSON.parse(readFileSync(transactionPath, "utf8"));
  } catch {
    throw new Error("Context database transaction journal is not valid JSON.");
  }
  if (
    transaction?.version !== 1 ||
    !Number.isInteger(transaction.beforeVersion) ||
    transaction.beforeVersion < 1 ||
    typeof transaction.targetManifestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(transaction.targetManifestHash)
  ) {
    throw new Error("Context database transaction journal is malformed.");
  }
  return transaction;
}

async function restoreTableVersion(databasePath, tableName, beforeVersion) {
  await withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    const versions = await table.listVersions();
    if (!versions.some((version) => version.version === beforeVersion)) {
      throw new Error(`Context database rollback version ${beforeVersion} is unavailable.`);
    }
    await table.checkout(beforeVersion);
    await table.restore();
  });
}

export async function recoverIndexTransaction({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
}) {
  const transactionPath = transactionPathFor(indexDirectory);
  const transaction = readTransaction(transactionPath);
  if (!transaction) return { recovered: false, state: "none" };
  if (safeManifestHash(manifestPath) === transaction.targetManifestHash) {
    rmSync(transactionPath, { force: true });
    return { recovered: true, state: "committed" };
  }
  await restoreTableVersion(databasePath, tableName, transaction.beforeVersion);
  rmSync(transactionPath, { force: true });
  return { recovered: true, state: "rolled-back" };
}

export function indexRepairRequired(indexDirectory) {
  const markerPath = repairMarkerPathFor(indexDirectory);
  if (!existsSync(markerPath)) return false;
  const stats = lstatSync(markerPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error("Context database repair marker is not a safe regular file.");
  }
  return true;
}

export function markIndexForRepair(indexDirectory, reason = "database repair required") {
  const transactionPath = transactionPathFor(indexDirectory);
  const markerPath = repairMarkerPathFor(indexDirectory);
  if (indexRepairRequired(indexDirectory)) {
    rmSync(transactionPath, { force: true });
    return false;
  }
  if (existsSync(transactionPath)) {
    const stats = lstatSync(transactionPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new Error("Context database transaction journal is not a safe regular file.");
    }
    renameSync(transactionPath, markerPath);
  } else {
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 1,
        reason,
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  return true;
}

export function markIndexTransactionForRepair(indexDirectory) {
  return markIndexForRepair(indexDirectory, "transaction rollback unavailable");
}

function clearIndexRepairMarker(indexDirectory) {
  rmSync(repairMarkerPathFor(indexDirectory), { force: true });
}

async function* recordBatchSource(records, recordBatches, batchSize = 256) {
  if (recordBatches) {
    for await (const batch of recordBatches) {
      if (batch.length > 0) yield batch;
    }
    return;
  }
  for (const batch of batches(records ?? [], batchSize)) yield batch;
}

async function addRecordBatches(table, source) {
  for await (const batch of source) await table.add(batch);
}

function hasIndex(indices, column, type) {
  return indices.some(
    (index) => index.columns?.includes(column) && (!type || index.indexType === type),
  );
}

async function publishManifestOnly({ manifestPath, temporaryManifestPath, manifest }) {
  try {
    writeTemporaryManifest(temporaryManifestPath, manifest);
    renameSync(temporaryManifestPath, manifestPath);
    return { generationReplaced: false };
  } finally {
    rmSync(temporaryManifestPath, { force: true });
  }
}

async function publishIncrementally({
  indexDirectory,
  databasePath,
  manifestPath,
  temporaryManifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  replacedPaths,
  vectorIndexThreshold,
}) {
  const transactionPath = transactionPathFor(indexDirectory);
  await recoverIndexTransaction({ indexDirectory, databasePath, manifestPath, tableName });
  let beforeVersion;
  let journalWritten = false;
  try {
    await withDatabase(databasePath, async (db) => {
      const lancedb = await getLanceDb();
      const table = await db.openTable(tableName);
      beforeVersion = await table.version();
      const indices = await table.listIndices();
      const targetRows = manifest.stats.chunks;
      const replacedPathGroups = batches([...new Set(replacedPaths)]);
      const vectorIndexExists = hasIndex(indices, "vector");
      const shouldCreateVectorIndex = !vectorIndexExists && targetRows >= vectorIndexThreshold;
      manifest.stats.vectorIndexEnabled = vectorIndexExists || shouldCreateVectorIndex;
      manifest.stats.databaseIndexComplete = false;
      const targetManifest = writeTemporaryManifest(temporaryManifestPath, manifest);
      writeFileSync(
        transactionPath,
        `${JSON.stringify({
          version: 1,
          beforeVersion,
          targetManifestHash: hashContent(targetManifest),
          createdAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      journalWritten = true;

      for (const paths of replacedPathGroups) {
        await table.delete(`path IN (${paths.map(sqlString).join(", ")})`);
      }
      const batchesForVersion = recordBatchFactory
        ? recordBatchFactory({ databaseVersion: beforeVersion })
        : recordBatches;
      await addRecordBatches(table, recordBatchSource(records, batchesForVersion));
      if (shouldCreateVectorIndex) {
        await table.createIndex("vector", {
          config: lancedb.Index.hnswSq({
            distanceType: "l2",
            numPartitions: 1,
            m: 32,
            efConstruction: 400,
          }),
        });
      }
      const rowCount = await table.countRows();
      if (rowCount !== targetRows) {
        throw new Error(
          `Incremental context publication row mismatch: expected ${targetRows}, received ${rowCount}.`,
        );
      }
    });
    renameSync(temporaryManifestPath, manifestPath);
    rmSync(transactionPath, { force: true });
    return { generationReplaced: false };
  } catch (error) {
    if (journalWritten && Number.isInteger(beforeVersion)) {
      try {
        await restoreTableVersion(databasePath, tableName, beforeVersion);
        rmSync(transactionPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Context incremental publication failed and its version rollback did not complete.",
        );
      }
    }
    throw error;
  } finally {
    rmSync(temporaryManifestPath, { force: true });
  }
}

async function publishFull({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  vectorIndexThreshold,
  testHooks,
}) {
  const suffix = randomUUID();
  const temporaryDatabasePath = path.join(indexDirectory, `lancedb.next-${suffix}`);
  const previousDatabasePath = path.join(indexDirectory, `lancedb.previous-${suffix}`);
  const temporaryManifestPath = path.join(indexDirectory, `manifest.next-${suffix}.json`);
  const previousManifestPath = path.join(indexDirectory, `manifest.previous-${suffix}.json`);
  let movedDatabase = false;
  let movedManifest = false;
  let publishedDatabase = false;
  let publishedManifest = false;
  let maintenance;
  try {
    const source = recordBatchSource(
      records,
      recordBatchFactory ? recordBatchFactory({ databaseVersion: undefined }) : recordBatches,
    );
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.length === 0) {
      throw new Error("Context index cannot publish an empty record stream.");
    }
    await withDatabase(temporaryDatabasePath, async (db) => {
      const lancedb = await getLanceDb();
      const table = await db.createTable(tableName, first.value, { mode: "overwrite" });
      await addRecordBatches(table, { [Symbol.asyncIterator]: () => iterator });
      await table.createIndex("searchText", {
        config: lancedb.Index.fts({ withPosition: true, lowercase: true }),
      });
      for (const scalarColumn of ["embeddingHash", "id", "path"]) {
        await table.createIndex(scalarColumn, { config: lancedb.Index.btree() });
      }
      const rowCount = await table.countRows();
      if (rowCount !== manifest.stats.chunks) {
        throw new Error(
          `Full context publication row mismatch: expected ${manifest.stats.chunks}, received ${rowCount}.`,
        );
      }
      if (rowCount >= vectorIndexThreshold) {
        await table.createIndex("vector", {
          config: lancedb.Index.hnswSq({
            distanceType: "l2",
            numPartitions: 1,
            m: 32,
            efConstruction: 400,
          }),
        });
        manifest.stats.vectorIndexEnabled = true;
      } else manifest.stats.vectorIndexEnabled = false;
    });
    manifest.stats.databaseModificationOperations = 0;
    manifest.stats.databaseModificationAffectedRows = 0;
    manifest.stats.databaseIndexComplete = true;
    await verifyDatabaseStructure({
      databasePath: temporaryDatabasePath,
      tableName,
      manifest,
      embeddingDimensions: manifest.embeddingDimensions ?? records?.[0]?.vector?.length,
    });
    validateRemovalTree(temporaryDatabasePath, "directory", "candidate database");
    writeTemporaryManifest(temporaryManifestPath, manifest);
    if (existsSync(databasePath)) {
      validateRemovalTree(databasePath, "directory", "selected database");
      renameSync(databasePath, previousDatabasePath);
      movedDatabase = true;
      testHooks?.afterPreviousDatabaseMoved?.();
    }
    if (existsSync(manifestPath)) {
      safeArtifactStats(manifestPath, "file", "selected manifest");
      renameSync(manifestPath, previousManifestPath);
      movedManifest = true;
      testHooks?.afterPreviousManifestMoved?.();
    }
    renameSync(temporaryDatabasePath, databasePath);
    publishedDatabase = true;
    testHooks?.afterCandidateDatabasePublished?.();
    renameSync(temporaryManifestPath, manifestPath);
    publishedManifest = true;
    testHooks?.afterCandidateManifestPublished?.();
  } catch (error) {
    if (publishedDatabase) safeRename(databasePath, temporaryDatabasePath);
    if (publishedManifest) safeRename(manifestPath, temporaryManifestPath);
    if (movedDatabase) safeRename(previousDatabasePath, databasePath);
    if (movedManifest) safeRename(previousManifestPath, manifestPath);
    throw error;
  } finally {
    maintenance = cleanupGeneratedIndexDebris(indexDirectory);
  }
  return { generationReplaced: true, maintenance };
}

export async function publishIndex({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  incremental = false,
  manifestOnly = false,
  replacedPaths = [],
  vectorIndexThreshold = defaultVectorIndexThreshold,
  testHooks,
}) {
  let repairRequired = indexRepairRequired(indexDirectory);
  if (repairRequired && (incremental || manifestOnly)) {
    throw new Error("Context database requires a full repair before incremental publication.");
  }
  if (existsSync(databasePath) && !repairRequired) {
    try {
      await recoverIndexTransaction({ indexDirectory, databasePath, manifestPath, tableName });
    } catch (error) {
      if (incremental || manifestOnly) throw error;
      markIndexTransactionForRepair(indexDirectory);
      repairRequired = true;
    }
  } else if (!incremental && !manifestOnly && existsSync(transactionPathFor(indexDirectory))) {
    markIndexTransactionForRepair(indexDirectory);
    repairRequired = true;
  }
  const maintenanceBeforePublication = cleanupGeneratedIndexDebris(indexDirectory);
  const temporaryManifestPath = path.join(indexDirectory, `manifest.next-${randomUUID()}.json`);
  if (manifestOnly) {
    const publication = await publishManifestOnly({
      manifestPath,
      temporaryManifestPath,
      manifest,
    });
    return {
      ...publication,
      maintenance: mergeMaintenanceSummaries(
        maintenanceBeforePublication,
        cleanupGeneratedIndexDebris(indexDirectory),
      ),
    };
  }
  if (incremental) {
    const publication = await publishIncrementally({
      indexDirectory,
      databasePath,
      manifestPath,
      temporaryManifestPath,
      tableName,
      records,
      recordBatches,
      recordBatchFactory,
      manifest,
      replacedPaths,
      vectorIndexThreshold,
    });
    return {
      ...publication,
      maintenance: mergeMaintenanceSummaries(
        maintenanceBeforePublication,
        cleanupGeneratedIndexDebris(indexDirectory),
      ),
    };
  }
  const publication = await publishFull({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName,
    records,
    recordBatches,
    recordBatchFactory,
    manifest,
    vectorIndexThreshold,
    testHooks,
  });
  if (repairRequired) clearIndexRepairMarker(indexDirectory);
  return {
    ...publication,
    maintenance: mergeMaintenanceSummaries(
      maintenanceBeforePublication,
      publication.maintenance,
      cleanupGeneratedIndexDebris(indexDirectory),
    ),
  };
}
