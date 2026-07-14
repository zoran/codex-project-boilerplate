import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chunkContent, extractMetadata } from "./context-chunks.mjs";
import {
  configuredEmbeddingBatchSize,
  embedTexts,
  embeddingRuntimeIdentity,
  getExtractor,
  getTokenizer,
  inspectModelArtifacts,
  maxEmbeddingTokens,
  tokenCounter,
} from "./context-embedding.mjs";
import { hashContent } from "./context-hashing.mjs";
import { createManifest, sourceChanges } from "./context-manifest.mjs";
import { loadReusableRows, publishIndex } from "./context-storage.mjs";
import { discoverSourceFiles } from "./source-policy.mjs";
import { findSecretMatches } from "../verify/secret-patterns.mjs";

function vectorIsValid(vector, dimensions) {
  return (
    Array.isArray(vector) &&
    vector.length === dimensions &&
    vector.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

export async function resolveChunkVectors({
  chunks,
  reusableRows,
  embeddingDimensions,
  batchSize,
  embedBatch,
}) {
  const reusableByHash = new Map();
  for (const row of reusableRows) {
    const vector = ArrayBuffer.isView(row.vector) ? [...row.vector] : row.vector;
    if (typeof row.embeddingHash === "string" && vectorIsValid(vector, embeddingDimensions)) {
      reusableByHash.set(row.embeddingHash, vector);
    }
  }

  const vectorsByHash = new Map(reusableByHash);
  const missingByHash = new Map();
  for (const chunk of chunks) {
    if (!vectorsByHash.has(chunk.embeddingHash)) missingByHash.set(chunk.embeddingHash, chunk);
  }
  const missing = [...missingByHash.values()];
  for (let index = 0; index < missing.length; index += batchSize) {
    const batch = missing.slice(index, index + batchSize);
    const vectors = await embedBatch(batch.map((chunk) => chunk.embeddingText));
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding batch returned ${vectors.length} vector(s) for ${batch.length} chunk(s).`,
      );
    }
    batch.forEach((chunk, batchIndex) => {
      const vector = ArrayBuffer.isView(vectors[batchIndex])
        ? [...vectors[batchIndex]]
        : vectors[batchIndex];
      if (!vectorIsValid(vector, embeddingDimensions)) {
        throw new Error(`Embedding vector for ${chunk.path} has an invalid shape.`);
      }
      vectorsByHash.set(chunk.embeddingHash, vector);
    });
  }

  const reusedChunks = chunks.filter((chunk) => reusableByHash.has(chunk.embeddingHash)).length;
  return {
    vectorsByHash,
    reusedChunks,
    embeddedChunks: chunks.length - reusedChunks,
    embeddedVectors: missing.length,
  };
}

async function completeModelArtifacts(modelCachePath, previousArtifacts) {
  let artifacts = inspectModelArtifacts(modelCachePath);
  if (!artifacts.complete) {
    await getExtractor(modelCachePath);
    artifacts = inspectModelArtifacts(modelCachePath);
  }
  if (
    artifacts.complete &&
    artifacts.signature === previousArtifacts?.signature &&
    typeof previousArtifacts.hash === "string" &&
    /^[a-f0-9]{64}$/.test(previousArtifacts.hash)
  ) {
    return { ...artifacts, hash: previousArtifacts.hash, hashReused: true };
  }
  artifacts = inspectModelArtifacts(modelCachePath, { includeHash: true });
  if (!artifacts.complete || !artifacts.hash) {
    throw new Error(
      `Pinned embedding model cache is incomplete: ${artifacts.missing ?? "unknown artifact"}.`,
    );
  }
  return { ...artifacts, hashReused: artifacts.hashFromCache };
}

function manifestFiles(discoveredFiles, metadataByPath, chunksByPath, previousFiles) {
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  return discoveredFiles.map(({ content: _content, ...file }) => {
    const freshMetadata = metadataByPath.get(file.path);
    const metadata = freshMetadata ?? previousByPath.get(file.path);
    if (!metadata) throw new Error(`Context metadata snapshot is missing for ${file.path}.`);
    const chunkIdentities = (chunksByPath.get(file.path) ?? metadata.chunks ?? []).map((chunk) => ({
      id: chunk.id,
      embeddingHash: chunk.embeddingHash,
    }));
    return {
      ...file,
      headings: metadata.headings,
      symbols: freshMetadata ? metadata.symbols.map((symbol) => symbol.name) : metadata.symbols,
      imports: metadata.imports,
      chunks: chunkIdentities,
    };
  });
}

function refuseSecrets(files) {
  for (const file of files) {
    const secretMatches = findSecretMatches(file.content);
    if (secretMatches.length === 0) continue;
    const firstMatch = secretMatches[0];
    throw new Error(
      `Refusing to index potential secret in ${file.path}:${firstMatch.line} (${firstMatch.label}). Run node scripts/verify/secrets.mjs and remove the secret before rebuilding the context index.`,
    );
  }
}

function recordForChunk(chunk, vector) {
  return {
    id: chunk.id,
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: chunk.text,
    headingsText: chunk.headings.join("\n"),
    symbolsText: chunk.symbols.join("\n"),
    importsText: chunk.imports.join("\n"),
    searchText: [
      chunk.path,
      chunk.headings.join(" "),
      chunk.symbols.join(" "),
      chunk.imports.join(" "),
      chunk.text,
    ].join("\n"),
    tokenCount: chunk.tokenCount,
    contentHash: chunk.contentHash,
    embeddingHash: chunk.embeddingHash,
    vector,
  };
}

function* chunkBatches(chunks, batchSize = 128) {
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const ordered = [...chunks].sort(
    (left, right) => compare(left.embeddingHash, right.embeddingHash) || compare(left.id, right.id),
  );
  for (let start = 0; start < ordered.length; start += batchSize) {
    yield ordered.slice(start, start + batchSize);
  }
}

function reusableCandidates(previousFiles, chunks) {
  const requestedHashes = new Set(chunks.map((chunk) => chunk.embeddingHash));
  const candidateByHash = new Map();
  for (const file of previousFiles) {
    for (const chunk of file.chunks) {
      if (requestedHashes.has(chunk.embeddingHash) && !candidateByHash.has(chunk.embeddingHash)) {
        candidateByHash.set(chunk.embeddingHash, chunk);
      }
    }
  }
  return [...candidateByHash.values()];
}

export async function* createRecordBatches({
  chunks,
  embeddingDimensions,
  embeddingBatchSize,
  modelCachePath,
  reusableRows = [],
  embedBatch = (texts) => embedTexts(texts, modelCachePath),
}) {
  const preloadedRowsByHash = new Map(reusableRows.map((row) => [row.embeddingHash, row]));
  let carriedRow;
  for (const batch of chunkBatches(chunks)) {
    const batchReusableRows = [...new Set(batch.map((chunk) => chunk.embeddingHash))].flatMap(
      (embeddingHash) =>
        preloadedRowsByHash.has(embeddingHash) ? [preloadedRowsByHash.get(embeddingHash)] : [],
    );
    if (carriedRow?.embeddingHash === batch[0]?.embeddingHash) batchReusableRows.push(carriedRow);
    const resolved = await resolveChunkVectors({
      chunks: batch,
      reusableRows: batchReusableRows,
      embeddingDimensions,
      batchSize: embeddingBatchSize,
      embedBatch,
    });
    const finalChunk = batch.at(-1);
    carriedRow = finalChunk
      ? {
          embeddingHash: finalChunk.embeddingHash,
          vector: resolved.vectorsByHash.get(finalChunk.embeddingHash),
        }
      : undefined;
    yield batch.map((chunk) =>
      recordForChunk(chunk, resolved.vectorsByHash.get(chunk.embeddingHash)),
    );
  }
}

export async function buildIndexUnlocked({
  repositoryRoot,
  indexDirectory,
  databasePath,
  manifestPath,
  modelCachePath,
  tableName,
  embeddingDimensions,
  relativeFromRoot,
  previousManifest,
  reason,
  forceFull = false,
  discoveredSources,
}) {
  const startedAt = performance.now();
  mkdirSync(indexDirectory, { recursive: true });
  mkdirSync(modelCachePath, { recursive: true });

  let discovered =
    discoveredSources ??
    discoverSourceFiles({ repositoryRoot, previousFiles: previousManifest?.files ?? [] });
  const runtimeIdentity = embeddingRuntimeIdentity();
  const modelArtifacts = await completeModelArtifacts(
    modelCachePath,
    previousManifest?.modelArtifacts,
  );
  const canReuse =
    !forceFull &&
    existsSync(databasePath) &&
    existsSync(path.join(databasePath, `${tableName}.lance`)) &&
    previousManifest?.runtimeIdentity?.fingerprint === runtimeIdentity.fingerprint &&
    previousManifest?.modelArtifacts?.hash === modelArtifacts.hash;
  if (!canReuse && discovered.files.some((file) => file.content === undefined)) {
    discovered = discoverSourceFiles({ repositoryRoot });
  }

  const changes = sourceChanges(previousManifest?.files ?? [], discovered.files);
  const processedPaths = canReuse
    ? new Set([...changes.missing, ...changes.changed])
    : new Set(discovered.files.map((file) => file.path));
  const processedFiles = discovered.files.filter((file) => processedPaths.has(file.path));
  refuseSecrets(processedFiles);
  const metadataByPath = new Map();
  const chunksByPath = new Map();
  const chunks = [];

  let countTokens;
  if (processedFiles.length > 0) {
    const tokenizer = await getTokenizer(modelCachePath);
    countTokens = tokenCounter(tokenizer);
  }
  for (const file of processedFiles) {
    if (typeof file.content !== "string") {
      throw new Error(`Changed context source was not read: ${file.path}.`);
    }
    const metadata = extractMetadata(file.content);
    metadataByPath.set(file.path, metadata);
    const fileChunks = chunkContent(file.path, file.content, metadata, countTokens, {
      tokenLimit: maxEmbeddingTokens,
    });
    chunksByPath.set(file.path, fileChunks);
    chunks.push(...fileChunks);
    delete file.content;
  }
  if (discovered.files.length === 0) {
    throw new Error("Context index cannot be built because no indexable chunks were found.");
  }

  const embeddingIdentity = hashContent(
    `${runtimeIdentity.fingerprint}\0${modelArtifacts.hash}\0${maxEmbeddingTokens}`,
  );
  for (const chunk of chunks) {
    chunk.embeddingHash = hashContent(`${embeddingIdentity}\0${chunk.embeddingText}`);
  }

  const reusableRows = canReuse
    ? await loadReusableRows(
        databasePath,
        tableName,
        embeddingDimensions,
        reusableCandidates(previousManifest?.files ?? [], chunks),
      )
    : [];
  const reusableHashes = new Set(reusableRows.map((row) => row.embeddingHash));
  const batchSize = configuredEmbeddingBatchSize();
  const reusedProcessedChunks = chunks.filter((chunk) =>
    reusableHashes.has(chunk.embeddingHash),
  ).length;
  const missingEmbeddingHashes = new Set(
    chunks
      .filter((chunk) => !reusableHashes.has(chunk.embeddingHash))
      .map((chunk) => chunk.embeddingHash),
  );
  const files = manifestFiles(
    discovered.files,
    metadataByPath,
    chunksByPath,
    previousManifest?.files ?? [],
  );
  const allChunks = files.flatMap((file) => file.chunks);
  if (allChunks.length === 0) {
    throw new Error("Context index cannot be built because no indexable chunks were found.");
  }
  const unchangedChunkCount = canReuse
    ? files
        .filter((file) => !processedPaths.has(file.path))
        .reduce((total, file) => total + file.chunks.length, 0)
    : 0;
  const databaseChanged =
    changes.missing.length > 0 || changes.changed.length > 0 || changes.removed.length > 0;
  const buildStats = {
    reusedChunks: unchangedChunkCount + reusedProcessedChunks,
    embeddedChunks: chunks.length - reusedProcessedChunks,
    embeddedVectors: missingEmbeddingHashes.size,
    addedFiles: changes.missing.length,
    changedFiles: changes.changed.length,
    metadataRefreshedFiles: changes.snapshotChanged.length,
    removedFiles: changes.removed.length,
    processedFiles: processedFiles.length,
    processedChunks: chunks.length,
    sourceFilesRead: discovered.filesRead,
    sourceBytesRead: discovered.bytesRead,
    modelHashReused: modelArtifacts.hashReused,
    databaseMode: canReuse ? (databaseChanged ? "incremental" : "manifest-only") : "full",
    databaseModificationOperations: canReuse
      ? Number(previousManifest?.stats?.databaseModificationOperations ?? 0) +
        (databaseChanged ? 1 : 0)
      : 0,
    databaseIndexOptimized: false,
    vectorIndexEnabled: canReuse ? Boolean(previousManifest?.stats?.vectorIndexEnabled) : false,
    durationMs: 0,
    reason,
  };
  const manifest = createManifest({
    files,
    skippedFiles: discovered.skipped,
    chunks: allChunks,
    modelArtifacts,
    runtimeIdentity,
    sourceMode: discovered.sourceMode,
    buildStats,
    databasePath: relativeFromRoot(databasePath),
    tableName,
  });
  const publication = await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName,
    recordBatchFactory: () =>
      createRecordBatches({
        chunks,
        embeddingDimensions,
        embeddingBatchSize: batchSize,
        modelCachePath,
        reusableRows,
      }),
    manifest,
    incremental: canReuse,
    manifestOnly: canReuse && !databaseChanged,
    replacedPaths: [...changes.changed, ...changes.removed],
  });
  buildStats.databaseIndexOptimized = publication.optimizedIndex;
  buildStats.databaseModificationOperations = manifest.stats.databaseModificationOperations;
  buildStats.vectorIndexEnabled = manifest.stats.vectorIndexEnabled;
  buildStats.durationMs = Math.round(performance.now() - startedAt);
  return { manifest, buildStats };
}
