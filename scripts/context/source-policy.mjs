import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sensitivePathReason } from "../repository/sensitive-paths.mjs";
import {
  activeSourcePathExclusionReason,
  listRepositoryPathInventory,
} from "../repository/source-inventory.mjs";
import {
  captureStableRepositoryFileIdentity,
  readStableRepositoryFile,
} from "../repository/stable-file-snapshot.mjs";
import { isRepositoryProcessArtifactPath } from "../docs/document-scope.mjs";
import { hashContent } from "./context-hashing.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultRoot = path.resolve(scriptDir, "..", "..");

export const defaultMaxFileBytes = 1024 * 1024;
export const defaultMaxTotalSourceBytes = 64 * 1024 * 1024;
export const defaultMaxSourceFiles = 20_000;

const generatedOrRuntimeDirectories = new Set([
  ".cache",
  ".codex",
  ".context-index",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "__pycache__",
  "blob-report",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "target",
  "test-results",
  "vendor",
]);
const ignoredLockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "mise.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const sensitiveStorageDirectories = new Set([".aws", ".azure", ".gcloud", ".gnupg", ".ssh"]);
const sensitiveExactBasenames = new Set([
  "auth.json",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "netrc",
]);
const credentialFileExtensions = new Set([".der", ".jks", ".key", ".p12", ".pem", ".pfx"]);
const executableSourceExtensions = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".h",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);
const sensitiveDataBasenamePattern =
  /(^|[._-])(api[-_]?key|credential|credentials|password|passwords|passwd|private[-_]?key|secret|secrets|token|tokens)([._-]|$)/i;
const dataLikeExtensions = new Set([
  ".cfg",
  ".conf",
  ".csv",
  ".ini",
  ".json",
  ".properties",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const archiveOrBinaryExtensions = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".so",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);
const minifiedArtifactPattern = /(?:^|\.)min\.(?:c|m)?(?:js|css)$/i;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRelativePath(value) {
  return toPosix(String(value ?? ""))
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

function isSafeRelativePath(value) {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized === "." || path.posix.isAbsolute(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "" || segment === "..");
}

function isSkillUiMetadata(relativePathValue) {
  return /^\.agents\/skills\/[^/]+\/agents\/openai\.ya?ml$/i.test(relativePathValue);
}

function isBackupPath(segments, basename) {
  return (
    segments.some((segment) => segment === "backup" || segment === "backups") ||
    basename === "backup" ||
    basename === "backups" ||
    basename.endsWith(".bak") ||
    basename.includes(".bak.")
  );
}

function isEnvironmentSecretFile(basename) {
  return basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example");
}

export function isSensitivePath(relativePathValue) {
  const normalized = normalizeRelativePath(relativePathValue);
  if (sensitivePathReason(normalized)) return true;
  const segments = normalized.split("/");
  const basename = (segments.at(-1) ?? "").toLowerCase();
  const extension = path.extname(basename).toLowerCase();

  if (segments.some((segment) => sensitiveStorageDirectories.has(segment.toLowerCase())))
    return true;
  if (sensitiveExactBasenames.has(basename) || isEnvironmentSecretFile(basename)) return true;
  if (credentialFileExtensions.has(extension) || basename.endsWith(".key.json")) return true;

  const executableSource = executableSourceExtensions.has(extension);
  if (
    !executableSource &&
    dataLikeExtensions.has(extension) &&
    sensitiveDataBasenamePattern.test(basename)
  ) {
    return true;
  }
  if (
    !executableSource &&
    segments.slice(0, -1).some((segment) => /^(credentials?|private|secrets?)$/i.test(segment))
  ) {
    return true;
  }
  return false;
}

function isConfiguredIndexPath(normalized, repositoryRoot) {
  const configuredDirectory =
    process.env.CONTEXT_INDEX_TEST_MODE === "1" && process.env.CONTEXT_INDEX_DIRECTORY
      ? path.resolve(repositoryRoot, process.env.CONTEXT_INDEX_DIRECTORY)
      : path.join(repositoryRoot, ".context-index");
  const relativeDirectory = normalizeRelativePath(
    path.relative(repositoryRoot, configuredDirectory),
  );
  if (!isSafeRelativePath(relativeDirectory)) return false;
  return normalized === relativeDirectory || normalized.startsWith(`${relativeDirectory}/`);
}

export function sourcePathExclusionReason(
  relativePathValue,
  { repositoryRoot = defaultRoot } = {},
) {
  const normalized = normalizeRelativePath(relativePathValue);
  if (!isSafeRelativePath(normalized)) return "unsafe repository-relative path";
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const extension = path.extname(basename).toLowerCase();
  if (isConfiguredIndexPath(normalized, repositoryRoot)) return "context index generated state";
  const activeReason = activeSourcePathExclusionReason(normalized);
  if (activeReason) return activeReason;
  if (segments.some((segment) => generatedOrRuntimeDirectories.has(segment))) {
    return "generated, dependency, tool-cache, or runtime directory";
  }
  if (isRepositoryProcessArtifactPath(normalized)) return "repository process artifact";
  if (isSkillUiMetadata(normalized)) return "skill UI metadata";
  if (isBackupPath(segments, basename)) return "backup path";
  if (ignoredLockfiles.has(basename)) return "machine-generated dependency lockfile";
  if (isSensitivePath(normalized)) return "sensitive or credential path";
  if (extension === ".map") return "machine-generated source map";
  if (minifiedArtifactPattern.test(basename)) return "minified artifact";
  if (archiveOrBinaryExtensions.has(extension)) return "archive or binary file";
  return null;
}

export function isIgnored(relativePathValue, options = {}) {
  return sourcePathExclusionReason(relativePathValue, options) !== null;
}

export function isActiveSourcePath(relativePathValue, { repositoryRoot = defaultRoot } = {}) {
  const normalized = normalizeRelativePath(relativePathValue);
  return isSafeRelativePath(normalized) && !isIgnored(normalized, { repositoryRoot });
}

function sourceFileCandidates(repositoryRoot) {
  const trackedOnly = process.env.CONTEXT_INDEX_TRACKED_ONLY === "1";
  const discovery = listRepositoryPathInventory({
    root: repositoryRoot,
    includeUntracked: !trackedOnly,
  });
  const docsOnlyFallback =
    discovery.mode === "active-area-fallback" && process.env.CONTEXT_INDEX_DOCS_ONLY === "1";
  const candidates = docsOnlyFallback
    ? discovery.paths.filter(
        (relativePath) =>
          /^(?:docs|scripts)(?:\/|$)/.test(relativePath) ||
          ["AGENTS.md", "README.md", "instructions.md", "package.json"].includes(relativePath),
      )
    : discovery.paths;
  const paths = [];
  const excludedByPath = new Map();
  for (const relativePathValue of [...new Set(candidates)].map(normalizeRelativePath)) {
    const reason = sourcePathExclusionReason(relativePathValue, { repositoryRoot });
    if (reason) excludedByPath.set(relativePathValue, reason);
    else paths.push(relativePathValue);
  }
  const excluded = [...excludedByPath]
    .map(([pathValue, reason]) => ({ path: pathValue, reason }))
    .sort((left, right) => comparePaths(left.path, right.path));
  return {
    mode: docsOnlyFallback ? "active-area-fallback-docs-only" : discovery.mode,
    paths: paths.sort(comparePaths),
    excluded,
  };
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    let suspiciousControls = 0;
    for (const byte of buffer) {
      if ((byte < 9 || (byte > 13 && byte < 32)) && byte !== 0) suspiciousControls += 1;
    }
    if (buffer.length > 0 && suspiciousControls / buffer.length > 0.002) return null;
    return content;
  } catch {
    return null;
  }
}

function statSignature(identity) {
  return hashContent(identity);
}

function reusableSnapshot(previous, signature, bytes) {
  return (
    previous &&
    previous.statSignature === signature &&
    previous.bytes === bytes &&
    typeof previous.hash === "string" &&
    /^[a-f0-9]{64}$/.test(previous.hash) &&
    Number.isInteger(previous.lineCount) &&
    previous.lineCount >= 0
  );
}

function readStableTextFile(
  repositoryRoot,
  relativePathValue,
  maxFileBytes,
  previous,
  parentIdentities,
) {
  let parent = repositoryRoot;
  for (const segment of relativePathValue.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    if (parentIdentities.has(parent)) continue;
    try {
      const parentStats = lstatSync(parent);
      if (parentStats.isSymbolicLink()) {
        return { skipped: "has a symbolic-link parent" };
      }
      if (!parentStats.isDirectory()) return { skipped: "has a non-directory parent" };
      parentIdentities.set(parent, { dev: parentStats.dev, ino: parentStats.ino });
    } catch (error) {
      if (error?.code === "ENOENT") return { skipped: "disappeared before it could be read" };
      throw error;
    }
  }

  let captured;
  try {
    captured = captureStableRepositoryFileIdentity({
      repositoryRoot,
      relativePath: relativePathValue,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: "disappeared before it could be read" };
    if (/path outside the repository/.test(error.message)) {
      return { skipped: "has a symbolic-link parent" };
    }
    if (/single-link, non-symlink regular repository file/.test(error.message)) {
      return { skipped: "not a single-link, non-symlink regular repository file" };
    }
    throw error;
  }
  if (captured.bytes > maxFileBytes) {
    return { skipped: `larger than ${maxFileBytes} bytes` };
  }
  const signature = statSignature(captured.identity);
  if (reusableSnapshot(previous, signature, captured.bytes)) {
    return {
      reused: true,
      file: {
        path: relativePathValue,
        bytes: captured.bytes,
        hash: previous.hash,
        lineCount: previous.lineCount,
        statSignature: signature,
      },
    };
  }

  try {
    const { buffer } = readStableRepositoryFile({
      repositoryRoot,
      relativePath: relativePathValue,
      expectedIdentity: captured.identity,
    });
    const content = decodeText(buffer);
    if (content === null) return { skipped: "not valid UTF-8 text" };
    return {
      file: {
        path: relativePathValue,
        bytes: buffer.length,
        hash: hashContent(buffer),
        lineCount: content.split(/\r?\n/).length,
        statSignature: signature,
        content,
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: "disappeared before it could be read" };
    if (
      /change since inventory capture|change while reading|path binding change/.test(error.message)
    ) {
      return { skipped: "changed while it was being read" };
    }
    throw error;
  }
}

export function discoverSourceFiles({
  repositoryRoot = defaultRoot,
  previousFiles = [],
  maxFileBytes = positiveInteger(process.env.CONTEXT_INDEX_MAX_FILE_BYTES, defaultMaxFileBytes),
  maxTotalSourceBytes = positiveInteger(
    process.env.CONTEXT_INDEX_MAX_TOTAL_BYTES,
    defaultMaxTotalSourceBytes,
  ),
  maxSourceFiles = positiveInteger(
    process.env.CONTEXT_INDEX_MAX_SOURCE_FILES,
    defaultMaxSourceFiles,
  ),
} = {}) {
  const resolvedRoot = realpathSync.native(repositoryRoot);
  const files = [];
  const skipped = [];
  const sourceCandidates = sourceFileCandidates(resolvedRoot);
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const parentIdentities = new Map();
  let totalBytes = 0;
  let bytesRead = 0;
  let filesRead = 0;
  let reusedFiles = 0;

  if (sourceCandidates.paths.length > maxSourceFiles) {
    throw new Error(
      `Context source boundary contains ${sourceCandidates.paths.length} candidates; limit is ${maxSourceFiles}.`,
    );
  }

  for (const relativePathValue of sourceCandidates.paths) {
    const result = readStableTextFile(
      resolvedRoot,
      relativePathValue,
      maxFileBytes,
      previousByPath.get(relativePathValue),
      parentIdentities,
    );
    if (result.skipped) {
      skipped.push({ path: relativePathValue, reason: result.skipped });
      continue;
    }
    if (result.reused) reusedFiles += 1;
    else {
      filesRead += 1;
      bytesRead += result.file.bytes;
    }

    totalBytes += result.file.bytes;
    if (totalBytes > maxTotalSourceBytes) {
      throw new Error(
        `Context source boundary exceeds ${maxTotalSourceBytes} bytes at ${relativePathValue}.`,
      );
    }
    files.push(result.file);
  }

  for (const [parentPath, identity] of parentIdentities) {
    const current = lstatSync(parentPath);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    ) {
      throw new Error(
        `Context source parent changed during discovery: ${normalizeRelativePath(path.relative(resolvedRoot, parentPath))}`,
      );
    }
  }

  return {
    files: files.sort((left, right) => comparePaths(left.path, right.path)),
    skipped: skipped.sort((left, right) => comparePaths(left.path, right.path)),
    excluded: sourceCandidates.excluded,
    sourceMode: sourceCandidates.mode,
    totalBytes,
    bytesRead,
    filesRead,
    reusedFiles,
  };
}
