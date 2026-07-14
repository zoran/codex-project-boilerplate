import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sensitivePathReason } from "../repository/sensitive-paths.mjs";
import { isExcludedActivePath } from "../repository/source-inventory.mjs";
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

function isWithinRoot(repositoryRoot, resolvedPath) {
  const relative = path.relative(repositoryRoot, resolvedPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
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

export function isIgnored(relativePathValue, { repositoryRoot = defaultRoot } = {}) {
  const normalized = normalizeRelativePath(relativePathValue);
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  return (
    !isSafeRelativePath(normalized) ||
    isConfiguredIndexPath(normalized, repositoryRoot) ||
    isExcludedActivePath(normalized) ||
    segments.some((segment) => generatedOrRuntimeDirectories.has(segment)) ||
    isRepositoryProcessArtifactPath(normalized) ||
    isSkillUiMetadata(normalized) ||
    isBackupPath(segments, basename) ||
    ignoredLockfiles.has(basename) ||
    archiveOrBinaryExtensions.has(path.extname(basename).toLowerCase()) ||
    isSensitivePath(normalized)
  );
}

export function isActiveSourcePath(relativePathValue, { repositoryRoot = defaultRoot } = {}) {
  const normalized = normalizeRelativePath(relativePathValue);
  return isSafeRelativePath(normalized) && !isIgnored(normalized, { repositoryRoot });
}

function gitSourceFiles(repositoryRoot) {
  const insideWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") return null;

  const trackedOnly = process.env.CONTEXT_INDEX_TRACKED_ONLY === "1";
  const args = trackedOnly
    ? ["ls-files", "--cached", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw new Error(`Failed to list Git source files: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Failed to list Git source files: ${String(result.stderr ?? "").trim()}`);
  }

  return {
    mode: trackedOnly ? "git-tracked" : "git-tracked-plus-untracked",
    candidates: result.stdout
      .toString("utf8")
      .split("\0")
      .map(normalizeRelativePath)
      .filter(Boolean),
  };
}

function fallbackSourceFiles(repositoryRoot) {
  const candidates = [];
  const docsOnly = process.env.CONTEXT_INDEX_DOCS_ONLY === "1";

  function walk(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relative = normalizeRelativePath(path.relative(repositoryRoot, fullPath));
      if (isIgnored(relative, { repositoryRoot })) continue;
      if (entry.isDirectory()) {
        if (!docsOnly || /^(docs|scripts)(?:\/|$)/.test(relative)) walk(fullPath);
        continue;
      }
      candidates.push(relative);
    }
  }

  if (docsOnly) {
    walk(path.join(repositoryRoot, "docs"));
    walk(path.join(repositoryRoot, "scripts"));
    for (const rootFile of ["AGENTS.md", "README.md", "instructions.md", "package.json"]) {
      if (existsSync(path.join(repositoryRoot, rootFile))) candidates.push(rootFile);
    }
  } else {
    walk(repositoryRoot);
  }
  return {
    mode: docsOnly ? "active-area-fallback-docs-only" : "active-area-fallback",
    candidates,
  };
}

function sourceFileCandidates(repositoryRoot) {
  const discovery = gitSourceFiles(repositoryRoot) ?? fallbackSourceFiles(repositoryRoot);
  const paths = [...new Set(discovery.candidates)]
    .map(normalizeRelativePath)
    .filter((relativePathValue) => isActiveSourcePath(relativePathValue, { repositoryRoot }))
    .sort(comparePaths);
  return { mode: discovery.mode, paths };
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

function statSignature(stats) {
  return hashContent(
    [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs]
      .map((value) => value.toString())
      .join(":"),
  );
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
  const fullPath = path.join(repositoryRoot, relativePathValue);
  if (!existsSync(fullPath)) return { skipped: "disappeared before it could be read" };

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

  let linkStats;
  let resolvedPath;
  let resolvedStats;
  try {
    linkStats = lstatSync(fullPath);
    resolvedPath = realpathSync.native(fullPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: "disappeared before it could be read" };
    throw error;
  }
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    return { skipped: "not a non-symlink regular repository file" };
  }

  if (!isWithinRoot(repositoryRoot, resolvedPath)) {
    return { skipped: "resolves outside the repository" };
  }
  try {
    resolvedStats = statSync(resolvedPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { skipped: "disappeared before it could be read" };
    throw error;
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(fullPath, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) return { skipped: "not a regular repository file" };
    if (before.dev !== resolvedStats.dev || before.ino !== resolvedStats.ino) {
      return { skipped: "changed path identity while it was being opened" };
    }
    if (before.size > BigInt(maxFileBytes)) {
      return { skipped: `larger than ${maxFileBytes} bytes` };
    }
    const bytes = Number(before.size);
    const signature = statSignature(before);
    if (reusableSnapshot(previous, signature, bytes)) {
      return {
        reused: true,
        file: {
          path: relativePathValue,
          bytes,
          hash: previous.hash,
          lineCount: previous.lineCount,
          statSignature: signature,
        },
      };
    }

    const buffer = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (statSignature(before) !== statSignature(after) || buffer.length !== Number(after.size)) {
      return { skipped: "changed while it was being read" };
    }

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
    if (error?.code === "ELOOP") return { skipped: "symbolic link refused while reading" };
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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
    sourceMode: sourceCandidates.mode,
    totalBytes,
    bytesRead,
    filesRead,
    reusedFiles,
  };
}
