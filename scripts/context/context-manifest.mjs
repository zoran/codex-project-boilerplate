import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  configuredEmbeddingBatchSize,
  configuredOnnxThreads,
  embeddingDimensions,
  embeddingModel,
  embeddingModelRevision,
  embeddingProvider,
  maxEmbeddingTokens,
} from "./context-embedding.mjs";

export const schemaVersion = 10;
export const databaseBackend = "lancedb";

function compareChunkIdentities(left, right) {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  if (left.embeddingHash !== right.embeddingHash) {
    return left.embeddingHash < right.embeddingHash ? -1 : 1;
  }
  return 0;
}

export function createChunkFingerprintAccumulator() {
  const hash = createHash("sha256");
  let first = true;
  let complete = false;
  return {
    update(chunk) {
      if (complete) throw new Error("Context chunk fingerprint is already complete.");
      if (!first) hash.update("\n");
      hash.update(`${chunk.id}:${chunk.embeddingHash}`);
      first = false;
    },
    digest() {
      if (complete) throw new Error("Context chunk fingerprint is already complete.");
      complete = true;
      return hash.digest("hex");
    },
  };
}

export function chunkFingerprint(chunks) {
  const fingerprint = createChunkFingerprintAccumulator();
  for (const chunk of [...chunks].sort(compareChunkIdentities)) fingerprint.update(chunk);
  return fingerprint.digest();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isSafeManifestPath(value) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "..");
}

function validManifestFile(file) {
  return (
    isObject(file) &&
    isSafeManifestPath(file.path) &&
    typeof file.hash === "string" &&
    /^[a-f0-9]{64}$/.test(file.hash) &&
    typeof file.statSignature === "string" &&
    /^[a-f0-9]{64}$/.test(file.statSignature) &&
    isNonNegativeInteger(file.bytes) &&
    isNonNegativeInteger(file.lineCount) &&
    Array.isArray(file.headings) &&
    Array.isArray(file.symbols) &&
    Array.isArray(file.imports) &&
    Array.isArray(file.chunks) &&
    file.chunks.every(
      (chunk) =>
        isObject(chunk) &&
        typeof chunk.id === "string" &&
        chunk.id.length > 0 &&
        typeof chunk.embeddingHash === "string" &&
        /^[a-f0-9]{64}$/.test(chunk.embeddingHash),
    )
  );
}

function validClassifiedPath(entry) {
  return (
    isObject(entry) &&
    isSafeManifestPath(entry.path) &&
    typeof entry.reason === "string" &&
    entry.reason.length > 0 &&
    entry.reason.length <= 200
  );
}

function canonicalClassifiedPaths(entries) {
  return entries.every(
    (entry, index) =>
      validClassifiedPath(entry) && (index === 0 || entries[index - 1].path < entry.path),
  );
}

function classifiedPathsEqual(previous = [], current = []) {
  if (previous.length !== current.length) return false;
  return previous.every(
    (entry, index) =>
      entry.path === current[index]?.path && entry.reason === current[index]?.reason,
  );
}

export function validateManifest(manifest) {
  if (!isObject(manifest)) return { valid: false, reason: "manifest is not an object" };
  if (manifest.schemaVersion !== schemaVersion) {
    return { valid: false, reason: "schema version changed" };
  }
  if (
    manifest.databaseBackend !== databaseBackend ||
    manifest.embeddingProvider !== embeddingProvider ||
    manifest.embeddingModel !== embeddingModel ||
    manifest.embeddingModelRevision !== embeddingModelRevision ||
    manifest.embeddingDimensions !== embeddingDimensions ||
    manifest.maxEmbeddingTokens !== maxEmbeddingTokens
  ) {
    return { valid: false, reason: "backend or embedding contract changed" };
  }
  if (!Array.isArray(manifest.files) || !manifest.files.every(validManifestFile)) {
    return { valid: false, reason: "file snapshot is malformed" };
  }
  if (!Array.isArray(manifest.skippedFiles) || !canonicalClassifiedPaths(manifest.skippedFiles)) {
    return { valid: false, reason: "skipped-file snapshot is malformed" };
  }
  if (!Array.isArray(manifest.excludedFiles) || !canonicalClassifiedPaths(manifest.excludedFiles)) {
    return { valid: false, reason: "excluded-file snapshot is malformed" };
  }
  if (
    !isObject(manifest.stats) ||
    !isNonNegativeInteger(manifest.stats.files) ||
    !isNonNegativeInteger(manifest.stats.skippedFiles) ||
    !isNonNegativeInteger(manifest.stats.excludedFiles) ||
    !isNonNegativeInteger(manifest.stats.chunks) ||
    manifest.stats.files !== manifest.files.length ||
    manifest.stats.skippedFiles !== manifest.skippedFiles.length ||
    manifest.stats.excludedFiles !== manifest.excludedFiles.length ||
    manifest.stats.chunks !== manifest.files.reduce((total, file) => total + file.chunks.length, 0)
  ) {
    return { valid: false, reason: "statistics are malformed" };
  }
  if (
    typeof manifest.chunkFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.chunkFingerprint) ||
    manifest.chunkFingerprint !== chunkFingerprint(manifest.files.flatMap((file) => file.chunks))
  ) {
    return { valid: false, reason: "chunk identity is malformed" };
  }
  if (
    !isObject(manifest.runtimeIdentity) ||
    typeof manifest.runtimeIdentity.fingerprint !== "string" ||
    !isObject(manifest.modelArtifacts) ||
    typeof manifest.modelArtifacts.signature !== "string" ||
    typeof manifest.modelArtifacts.hash !== "string" ||
    !Array.isArray(manifest.modelArtifacts.files) ||
    !isObject(manifest.sourcePolicy) ||
    typeof manifest.sourcePolicy.sourceMode !== "string"
  ) {
    return { valid: false, reason: "runtime or source policy identity is malformed" };
  }
  return { valid: true, reason: "" };
}

export function loadManifestState(manifestPath) {
  if (!existsSync(manifestPath)) return { manifest: null, reason: "missing" };
  try {
    const stats = lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { manifest: null, reason: "invalid: manifest is not a non-symlink regular file" };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const validation = validateManifest(manifest);
    return validation.valid
      ? { manifest, reason: "" }
      : { manifest: null, reason: `invalid: ${validation.reason}` };
  } catch {
    return { manifest: null, reason: "invalid: JSON could not be parsed" };
  }
}

export function sourceChanges(previousFiles = [], currentFiles = []) {
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const missing = [];
  const changed = [];
  const snapshotChanged = [];
  const removed = [];
  for (const [filePath, file] of currentByPath) {
    const previous = previousByPath.get(filePath);
    if (!previous) missing.push(filePath);
    else if (previous.hash !== file.hash) changed.push(filePath);
    else if (
      typeof previous.statSignature === "string" &&
      typeof file.statSignature === "string" &&
      previous.statSignature !== file.statSignature
    )
      snapshotChanged.push(filePath);
  }
  for (const filePath of previousByPath.keys()) {
    if (!currentByPath.has(filePath)) removed.push(filePath);
  }
  return { missing, changed, snapshotChanged, removed };
}

function staleResult(reason, manifest, current, changes = {}) {
  return {
    fresh: false,
    reason,
    missing: changes.missing ?? [],
    changed: changes.changed ?? [],
    snapshotChanged: changes.snapshotChanged ?? [],
    removed: changes.removed ?? [],
    classificationsChanged: changes.classificationsChanged ?? false,
    currentFileCount: current?.files?.length ?? 0,
    indexedFileCount: manifest?.files?.length ?? 0,
  };
}

export function compareManifest({
  manifestState,
  databasePath,
  tablePath,
  runtimeIdentity,
  modelArtifacts,
  currentSources,
}) {
  const manifest = manifestState.manifest;
  if (!manifest) return staleResult(manifestState.reason || "missing", null, currentSources);
  if (!existsSync(databasePath) || !existsSync(tablePath)) {
    return staleResult("database missing", manifest, currentSources);
  }
  if (manifest.runtimeIdentity.fingerprint !== runtimeIdentity.fingerprint) {
    return staleResult("embedding runtime changed", manifest, currentSources);
  }
  if (!modelArtifacts.complete) return staleResult("model cache missing", manifest, currentSources);
  if (manifest.modelArtifacts.signature !== modelArtifacts.signature) {
    return staleResult("model cache changed", manifest, currentSources);
  }
  if (manifest.sourcePolicy.sourceMode !== currentSources.sourceMode) {
    return staleResult("source discovery mode changed", manifest, currentSources);
  }
  const changes = sourceChanges(manifest.files, currentSources.files);
  const classificationsChanged =
    !classifiedPathsEqual(manifest.skippedFiles, currentSources.skipped) ||
    !classifiedPathsEqual(manifest.excludedFiles, currentSources.excluded);
  const fresh =
    changes.missing.length === 0 &&
    changes.changed.length === 0 &&
    changes.snapshotChanged.length === 0 &&
    changes.removed.length === 0 &&
    !classificationsChanged;
  return {
    fresh,
    reason: fresh
      ? "current"
      : changes.missing.length === 0 &&
          changes.changed.length === 0 &&
          changes.snapshotChanged.length === 0 &&
          changes.removed.length === 0 &&
          classificationsChanged
        ? "source classification changed"
        : changes.missing.length === 0 &&
            changes.changed.length === 0 &&
            changes.removed.length === 0
          ? "source metadata changed"
          : "source content changed",
    ...changes,
    classificationsChanged,
    currentFileCount: currentSources.files.length,
    indexedFileCount: manifest.files.length,
  };
}

export function createManifest({
  files,
  skippedFiles,
  excludedFiles,
  chunks,
  modelArtifacts,
  runtimeIdentity,
  sourceMode,
  buildStats,
  databasePath: relativeDatabasePath,
  tableName,
}) {
  const { durationMs: _ephemeralDurationMs, ...durableBuildStats } = buildStats;
  const manifestChunks = files.flatMap((file) => file.chunks);
  if (manifestChunks.length !== chunks.length) {
    throw new Error(
      `Context manifest chunk snapshot mismatch: files=${manifestChunks.length}, build=${chunks.length}.`,
    );
  }
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    rootPath: ".",
    databaseBackend,
    databasePath: relativeDatabasePath,
    tableName,
    embeddingProvider,
    embeddingModel,
    embeddingModelRevision,
    embeddingDimensions,
    maxEmbeddingTokens,
    embeddingBatchSize: configuredEmbeddingBatchSize(),
    onnxThreads: configuredOnnxThreads(),
    chunkFingerprint: chunkFingerprint(manifestChunks),
    runtimeIdentity,
    modelCacheHash: modelArtifacts.hash,
    modelArtifacts: {
      signature: modelArtifacts.signature,
      hash: modelArtifacts.hash,
      files: modelArtifacts.files,
    },
    sourcePolicy: {
      sourceMode,
      gitTrackedOnly: sourceMode === "git-tracked",
      includesGitUntrackedByDefault: sourceMode === "git-tracked-plus-untracked",
      trackedOnlyOptIn: "CONTEXT_INDEX_TRACKED_ONLY=1",
      includesArbitraryActiveRoots: true,
      docsOnlyOptIn: "CONTEXT_INDEX_DOCS_ONLY=1",
      excludesArchives: true,
      excludesGeneratedMapsAndMinifiedArtifacts: true,
      excludesSensitivePaths: true,
      rejectsSymlinks: true,
    },
    files,
    skippedFiles,
    excludedFiles,
    stats: {
      files: files.length,
      skippedFiles: skippedFiles.length,
      excludedFiles: excludedFiles.length,
      chunks: chunks.length,
      ...durableBuildStats,
    },
  };
}
