import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent, hashFiles } from "./context-hashing.mjs";

export const embeddingProvider = "transformers.js";
export const embeddingModel = "Xenova/all-MiniLM-L6-v2";
export const embeddingModelRevision = "751bff37182d3f1213fa05d7196b954e230abad9";
export const embeddingDimensions = 384;
export const maxEmbeddingTokens = 448;
export const defaultEmbeddingBatchSize = 4;
export const requiredModelArtifactPaths = [
  "config.json",
  "onnx/model.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
];

let tokenizerPromise;
let extractorPromise;
const implementationDirectory = path.dirname(fileURLToPath(import.meta.url));
export const indexedContentImplementationFiles = Object.freeze([
  "context-build.mjs",
  "context-chunks.mjs",
  "context-database.mjs",
  "context-embedding.mjs",
  "context-manifest.mjs",
  "context-storage.mjs",
  "source-policy.mjs",
  "../repository/sensitive-paths.mjs",
  "../repository/source-inventory.mjs",
  "../verify/secret-patterns.mjs",
]);

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function configuredEmbeddingBatchSize() {
  return boundedInteger(
    process.env.CONTEXT_INDEX_EMBEDDING_BATCH_SIZE,
    defaultEmbeddingBatchSize,
    defaultEmbeddingBatchSize,
  );
}

export function configuredOnnxThreads() {
  return boundedInteger(process.env.CONTEXT_INDEX_ONNX_THREADS, 1, 8);
}

export function modelRevisionDirectory(modelCachePath) {
  return path.join(modelCachePath, ...embeddingModel.split("/"), embeddingModelRevision);
}

function packageRootFromEntry(entryPath, expectedName) {
  let directory = path.dirname(entryPath);
  while (directory !== path.dirname(directory)) {
    const packagePath = path.join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
        if (pkg.name === expectedName) return { directory, version: pkg.version ?? "unknown" };
      } catch {
        // Continue walking until the owning package is found.
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function resolvedPackage(packageName, baseUrl = import.meta.url) {
  try {
    const require = createRequire(baseUrl);
    const entry = require.resolve(packageName);
    return packageRootFromEntry(entry, packageName);
  } catch {
    return null;
  }
}

export function embeddingRuntimeIdentity() {
  const transformers = resolvedPackage("@huggingface/transformers");
  const lancedb = resolvedPackage("@lancedb/lancedb");
  const onnx = transformers
    ? resolvedPackage("onnxruntime-node", path.join(transformers.directory, "package.json"))
    : null;
  const identity = {
    embeddingProvider,
    embeddingModel,
    embeddingModelRevision,
    embeddingDimensions,
    transformersVersion: transformers?.version ?? "missing",
    onnxRuntimeVersion: onnx?.version ?? "missing",
    lanceDbVersion: lancedb?.version ?? "missing",
    indexedContentImplementationFingerprint:
      hashFiles(implementationDirectory, indexedContentImplementationFiles) ?? "missing",
  };
  return {
    ...identity,
    fingerprint: hashContent(JSON.stringify(identity)),
  };
}

export function inspectModelArtifacts(modelCachePath, { includeHash = false } = {}) {
  const revisionDirectory = modelRevisionDirectory(modelCachePath);
  const files = [];
  for (const relativePath of requiredModelArtifactPaths) {
    const filePath = path.join(revisionDirectory, relativePath);
    if (!existsSync(filePath)) {
      return { complete: false, revisionDirectory, missing: relativePath, files: [] };
    }
    const linkStats = lstatSync(filePath);
    if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
      return { complete: false, revisionDirectory, missing: relativePath, files: [] };
    }
    const stats = statSync(filePath, { bigint: true });
    files.push({
      path: relativePath,
      bytes: Number(stats.size),
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
    });
  }
  const signature = hashContent(JSON.stringify(files));
  let hash = null;
  let hashFromCache = false;
  if (includeHash) {
    const cachePath = path.join(revisionDirectory, ".artifact-hash.json");
    try {
      const cacheStats = lstatSync(cachePath);
      if (cacheStats.isSymbolicLink() || !cacheStats.isFile()) {
        throw new Error("Model artifact hash cache is not a regular file.");
      }
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cached?.signature === signature && /^[a-f0-9]{64}$/.test(cached?.hash)) {
        hash = cached.hash;
        hashFromCache = true;
      }
    } catch {
      // A missing or malformed cache only causes one bounded artifact rehash.
    }
    if (!hash) {
      hash = hashFiles(revisionDirectory, requiredModelArtifactPaths);
      if (hash) {
        const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
        try {
          writeFileSync(temporaryPath, `${JSON.stringify({ signature, hash })}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          renameSync(temporaryPath, cachePath);
        } catch {
          rmSync(temporaryPath, { force: true });
        }
      }
    }
  }
  return {
    complete: true,
    revisionDirectory,
    missing: null,
    files,
    signature,
    hash,
    hashFromCache,
  };
}

export function resolveModelLocation(modelCachePath, { offline = false } = {}) {
  const artifacts = inspectModelArtifacts(modelCachePath);
  if (artifacts.complete) {
    return { location: artifacts.revisionDirectory, localFilesOnly: true, artifacts };
  }
  if (offline) {
    throw new Error(
      `Offline context retrieval requires the pinned model cache; missing ${artifacts.missing ?? "model artifacts"}.`,
    );
  }
  return { location: embeddingModel, localFilesOnly: false, artifacts };
}

async function transformersRuntime(modelCachePath) {
  const runtime = await import("@huggingface/transformers");
  runtime.env.cacheDir = modelCachePath;
  runtime.env.allowRemoteModels = process.env.CONTEXT_INDEX_OFFLINE !== "1";
  runtime.env.allowLocalModels = true;
  return runtime;
}

function loadingOptions(modelCachePath, localFilesOnly) {
  return {
    cache_dir: modelCachePath,
    revision: embeddingModelRevision,
    local_files_only: localFilesOnly,
  };
}

export async function getTokenizer(modelCachePath) {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const offline = process.env.CONTEXT_INDEX_OFFLINE === "1";
      const { location, localFilesOnly } = resolveModelLocation(modelCachePath, { offline });
      const { AutoTokenizer } = await transformersRuntime(modelCachePath);
      return AutoTokenizer.from_pretrained(
        location,
        loadingOptions(modelCachePath, localFilesOnly),
      );
    })().catch((error) => {
      tokenizerPromise = undefined;
      throw error;
    });
  }
  return tokenizerPromise;
}

export async function getExtractor(modelCachePath) {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const offline = process.env.CONTEXT_INDEX_OFFLINE === "1";
      const { location, localFilesOnly } = resolveModelLocation(modelCachePath, { offline });
      const { pipeline } = await transformersRuntime(modelCachePath);
      return pipeline("feature-extraction", location, {
        ...loadingOptions(modelCachePath, localFilesOnly),
        session_options: {
          intraOpNumThreads: configuredOnnxThreads(),
          interOpNumThreads: 1,
        },
      });
    })().catch((error) => {
      extractorPromise = undefined;
      throw error;
    });
  }
  return extractorPromise;
}

export function tokenCounter(tokenizer) {
  return (text) => {
    const result = tokenizer(text, { add_special_tokens: true, truncation: false });
    return result.input_ids.dims.at(-1);
  };
}

export async function embedTexts(texts, modelCachePath) {
  if (texts.length === 0) return [];
  const extractor = await getExtractor(modelCachePath);
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist();
  const normalizedVectors = Array.isArray(vectors[0]) ? vectors : [vectors];
  for (const vector of normalizedVectors) {
    if (
      vector.length !== embeddingDimensions ||
      vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(
        `Embedding model returned invalid vector shape; expected ${embeddingDimensions} finite values.`,
      );
    }
  }
  return normalizedVectors;
}
