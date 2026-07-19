import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const excludedActiveDirectoryNames = new Set([
  ".codex",
  ".context-index",
  ".git",
  ".next",
  ".pnpm-store",
  ".project-state",
  "backup",
  "backups",
  "blob-report",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
  "vendor",
]);

const nonPortableDirectoryNames = new Set([
  ".context-index",
  ".git",
  ".next",
  ".pnpm-store",
  ".project-state",
  "backup",
  "backups",
  "blob-report",
  "coverage",
  "node_modules",
  "playwright-report",
  "target",
  "test-results",
]);
export const repositoryCodexHomeRuntimeDirectoryNames = Object.freeze([
  ".tmp",
  "cache",
  "log",
  "logs",
  "memories",
  "plugins",
  "sessions",
  "shell_snapshots",
  "skills",
  "tmp",
]);
export const repositoryCodexHomeRuntimeFileNames = Object.freeze([
  ".personality_migration",
  "auth.json",
  "config.toml",
  "history.jsonl",
  "installation_id",
  "models_cache.json",
  "version.json",
]);
export const repositoryCodexHomeRuntimeDatabasePrefixes = Object.freeze([
  "goals",
  "logs",
  "memories",
  "state",
]);
export const repositoryCodexHomeGitignorePatterns = Object.freeze([
  ...repositoryCodexHomeRuntimeDirectoryNames.map((name) => `/${name}`),
  ...repositoryCodexHomeRuntimeFileNames.map((name) => `/${name}`),
  ...repositoryCodexHomeRuntimeDatabasePrefixes.map((name) => `/${name}_*.sqlite*`),
]);
export const portableCodexGitignorePatterns = Object.freeze([
  ".codex/*",
  "!.codex/",
  "!.codex/config.toml",
  "!.codex/hooks.json",
  "!.codex/README.md",
  "!.codex/agents/",
  ".codex/agents/*",
  "!.codex/agents/*.toml",
]);
export const sourceInventoryPreDescentExcludePatterns = Object.freeze([
  ...repositoryCodexHomeGitignorePatterns,
  ...portableCodexGitignorePatterns,
  "/.context-index",
  "/.project-state",
]);
export const gitlessPreDescentExcludePatterns = sourceInventoryPreDescentExcludePatterns;
export const repositoryCodexHomeRuntimeProbePaths = Object.freeze([
  ...repositoryCodexHomeRuntimeDirectoryNames.map((name) => `${name}/runtime-state`),
  ...repositoryCodexHomeRuntimeFileNames,
  ...repositoryCodexHomeRuntimeDatabasePrefixes.flatMap((name) => [
    `${name}_1.sqlite`,
    `${name}_1.sqlite-shm`,
    `${name}_1.sqlite-wal`,
  ]),
]);
export const repositoryCodexHomeProtectedGitignoreProbePaths = Object.freeze([
  ...repositoryCodexHomeRuntimeDirectoryNames.flatMap((name) => [name, `${name}/runtime-state`]),
  ...repositoryCodexHomeRuntimeProbePaths.slice(repositoryCodexHomeRuntimeDirectoryNames.length),
  ".codex/auth.json",
  ".codex/cache/runtime-state",
  ".codex/sessions/runtime-state",
  ".codex/skills/runtime-state",
  ".codex/agents/extra.json",
  ".codex/agents/nested/extra.toml",
]);
export const portableCodexGitignoreProbePaths = Object.freeze([
  ".codex/README.md",
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/agents/default.toml",
]);
const rootCodexRuntimeDirectoryNames = new Set(repositoryCodexHomeRuntimeDirectoryNames);
const rootCodexRuntimeFiles = new Set(repositoryCodexHomeRuntimeFileNames);
const privateCodexRuntimeCodes = new Set(["project-codex-runtime", "repository-codex-runtime"]);
const rootCodexRuntimeDatabasePattern = new RegExp(
  `^(?:${repositoryCodexHomeRuntimeDatabasePrefixes.join("|")})_[^/]+\\.sqlite[^/]*$`,
);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeRelativePath(value) {
  const normalized = path.posix.normalize(toPosix(value).replace(/^\.\//, ""));
  if (
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

function isRootCodexRuntimePath(relativePath) {
  if (!relativePath) return false;
  const [topLevel] = relativePath.split("/");
  return (
    rootCodexRuntimeDirectoryNames.has(topLevel) ||
    (relativePath === topLevel &&
      (rootCodexRuntimeFiles.has(topLevel) || rootCodexRuntimeDatabasePattern.test(topLevel)))
  );
}

export function isRepositoryCodexHomePath(value) {
  const relativePath = normalizeRelativePath(value);
  return isRootCodexRuntimePath(relativePath);
}

export function repositoryCodexHomeGitignoreFindings(content) {
  const lines = new Set(
    String(content)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  return [...repositoryCodexHomeGitignorePatterns, ...portableCodexGitignorePatterns]
    .filter((pattern) => !lines.has(pattern))
    .map((pattern) => `missing exact root Codex isolation pattern ${pattern}`);
}

function isPortableCodexPath(relativePath) {
  return (
    [".codex/README.md", ".codex/config.toml", ".codex/hooks.json", ".codex/agents"].includes(
      relativePath,
    ) || /^\.codex\/agents\/[a-z][a-z0-9_-]*\.toml$/.test(relativePath)
  );
}

export function activeSourcePathClassification(value) {
  const relativePath = normalizeRelativePath(value);
  if (!relativePath) {
    return { code: "unsafe-path", reason: "unsafe repository-relative path" };
  }
  if (isRepositoryCodexHomePath(relativePath)) {
    return {
      code: "repository-codex-runtime",
      reason: "repository-root Codex runtime or cache state",
    };
  }

  const segments = relativePath.split("/");
  const basename = segments.at(-1) ?? "";
  if (segments[0] === ".codex") {
    return isPortableCodexPath(relativePath)
      ? null
      : {
          code: "project-codex-runtime",
          reason: "project-local Codex runtime or cache state",
        };
  }
  if (segments.some((segment) => excludedActiveDirectoryNames.has(segment))) {
    return {
      code: "generated-runtime-directory",
      reason: "generated, dependency, backup, or runtime directory",
    };
  }
  if (basename.endsWith(".bak") || basename.includes(".bak.")) {
    return { code: "backup-file", reason: "backup file" };
  }
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return { code: "environment-secret", reason: "environment secret file" };
  }
  if (basename.endsWith(".local")) {
    return { code: "machine-local-file", reason: "machine-local file" };
  }
  return null;
}

export function activeSourcePathExclusionReason(value) {
  return activeSourcePathClassification(value)?.reason ?? null;
}

export function isPrivateCodexRuntimePath(value) {
  return privateCodexRuntimeCodes.has(activeSourcePathClassification(value)?.code);
}

export function isExcludedActivePath(value) {
  return activeSourcePathClassification(value) !== null;
}

export function nonPortableTransferPathReason(value) {
  const relativePath = normalizeRelativePath(value);
  if (!relativePath) return "unsafe repository-relative path";
  if (isRepositoryCodexHomePath(relativePath)) {
    return "repository-root Codex runtime or cache state";
  }

  const segments = relativePath.split("/");
  const basename = segments.at(-1) ?? "";
  if (segments.includes(".codex") && !isPortableCodexPath(relativePath)) {
    return "project-local Codex runtime or cache state";
  }
  if (segments.some((segment) => nonPortableDirectoryNames.has(segment))) {
    return "generated, dependency, backup, or runtime state";
  }
  if (relativePath.startsWith("dist/exports/")) return "generated project export";
  if (relativePath.startsWith("playwright/.auth/")) return "browser authentication state";
  if (
    basename.endsWith(".bak") ||
    basename.includes(".bak.") ||
    basename.endsWith(".local") ||
    basename.endsWith(".tsbuildinfo")
  ) {
    return "machine-local or generated file";
  }
  return null;
}

function splitNullBuffer(buffer) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) paths.push(buffer.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start < buffer.length) paths.push(buffer.subarray(start).toString("utf8"));
  return paths;
}

function cleanGitEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

export function repositoryCodexHomeGitignoreBehaviorFindings({ root = repositoryRoot } = {}) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "codex-ignore-contract-"));
  const gitDirectory = path.join(temporaryDirectory, "git");
  const gitEnvironment = cleanGitEnvironment();
  try {
    const initialized = spawnSync("git", ["init", "--bare", "--quiet", gitDirectory], {
      cwd: realpathSync(root),
      encoding: null,
      env: gitEnvironment,
      input: Buffer.alloc(0),
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (initialized.error || initialized.status !== 0) {
      return ["effective root Codex ignore policy could not initialize its isolated Git probe"];
    }

    const probes = [
      ...repositoryCodexHomeProtectedGitignoreProbePaths,
      ...portableCodexGitignoreProbePaths,
    ];
    const checked = spawnSync(
      "git",
      [
        `--git-dir=${gitDirectory}`,
        `--work-tree=${realpathSync(root)}`,
        "-c",
        "core.excludesFile=",
        "check-ignore",
        "--no-index",
        "-z",
        "--stdin",
      ],
      {
        cwd: realpathSync(root),
        encoding: null,
        env: gitEnvironment,
        input: Buffer.from(`${probes.join("\0")}\0`),
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    if (checked.error || ![0, 1].includes(checked.status) || !Buffer.isBuffer(checked.stdout)) {
      return ["effective root Codex ignore policy could not evaluate its isolated Git probe"];
    }
    const ignored = new Set(splitNullBuffer(checked.stdout));
    return [
      ...repositoryCodexHomeProtectedGitignoreProbePaths
        .filter((relativePath) => !ignored.has(relativePath))
        .map((relativePath) => `root Codex runtime is not effectively ignored: ${relativePath}`),
      ...portableCodexGitignoreProbePaths
        .filter((relativePath) => ignored.has(relativePath))
        .map((relativePath) => `portable Codex config is effectively ignored: ${relativePath}`),
    ];
  } catch {
    return ["effective root Codex ignore policy could not run its isolated Git probe"];
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function gitPathOutput(root, args, label, extraArgs = []) {
  const result = spawnSync("git", [...extraArgs, ...args], {
    cwd: root,
    encoding: null,
    env: cleanGitEnvironment(),
    input: Buffer.alloc(0),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = result.error?.message ?? `status ${result.status}`;
    throw new Error(`${label} failed (${detail}); repository source inventory is unavailable.`);
  }
  return splitNullBuffer(result.stdout);
}

export function withSourceInventoryPreDescentMask(action) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "codex-source-mask-"));
  const excludePath = path.join(temporaryDirectory, "pre-descent.exclude");
  try {
    writeFileSync(excludePath, `${sourceInventoryPreDescentExcludePatterns.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return action(excludePath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function sourcePathsFromEphemeralGit(root) {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "codex-source-inventory-"));
  const gitDirectory = path.join(temporaryDirectory, "git");
  try {
    const initialized = spawnSync("git", ["init", "--bare", "--quiet", gitDirectory], {
      cwd: root,
      encoding: "utf8",
      env: cleanGitEnvironment(),
      input: "",
      stdio: "pipe",
    });
    if (initialized.error || initialized.status !== 0) {
      const detail = initialized.error?.message ?? `status ${initialized.status}`;
      throw new Error(`Temporary Git inventory initialization failed (${detail}).`);
    }
    return withSourceInventoryPreDescentMask((excludePath) =>
      gitPathOutput(
        root,
        ["ls-files", "--others", "--exclude-standard", `--exclude-from=${excludePath}`, "-z"],
        "Non-Git source inventory",
        [`--git-dir=${gitDirectory}`, `--work-tree=${root}`],
      ),
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function sourcePathInventory(root, { includeUntracked = true } = {}) {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    env: cleanGitEnvironment(),
    input: "",
    stdio: "pipe",
  });
  const hasLocalGitMetadata = existsSync(path.join(root, ".git"));
  if (probe.error) {
    throw new Error(`Git repository probe failed: ${probe.error.message}`);
  }
  if (probe.status === 0) {
    const topLevel = probe.stdout.trim();
    if (topLevel && realpathSync(topLevel) === realpathSync(root)) {
      const tracked = gitPathOutput(root, ["ls-files", "--cached", "-z"], "Git source inventory");
      if (!includeUntracked) return { candidates: tracked, mode: "git-tracked" };
      const untracked = withSourceInventoryPreDescentMask((excludePath) =>
        gitPathOutput(
          root,
          ["ls-files", "--others", "--exclude-standard", `--exclude-from=${excludePath}`, "-z"],
          "Git source inventory",
        ),
      ).filter((relativePath) => !isRepositoryCodexHomePath(relativePath));
      return { candidates: [...tracked, ...untracked], mode: "git-tracked-plus-untracked" };
    }
    if (hasLocalGitMetadata) {
      throw new Error("Local Git metadata does not identify this directory as its worktree root.");
    }
  } else if (hasLocalGitMetadata) {
    throw new Error("Local Git metadata is unreadable; refusing a filesystem inventory fallback.");
  }
  if (!includeUntracked) {
    throw new Error(
      "Tracked portable transfer requires the source root to be a Git worktree; pass includeUntracked only for an explicit working-tree snapshot.",
    );
  }
  return {
    candidates: sourcePathsFromEphemeralGit(root).filter(
      (relativePath) => !isRepositoryCodexHomePath(relativePath),
    ),
    mode: "active-area-fallback",
  };
}

function stagedTransferPaths(root) {
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Staged transfer root must be a non-symlink directory.");
  }
  const candidates = [];
  const pending = [{ absolutePath: root, relativePath: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current.absolutePath, { withFileTypes: true })) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Portable transfer source is not a regular file: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        const reason =
          relativePath === ".codex" ? null : nonPortableTransferPathReason(relativePath);
        if (reason) {
          throw new Error(
            `Portable transfer inventory contains nonportable path: ${relativePath} (${reason})`,
          );
        }
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Portable transfer source is not a regular file: ${relativePath}`);
      }
      candidates.push(relativePath);
    }
  }
  return candidates;
}

function listRegularFiles({
  candidates,
  root,
  maxBytes = Number.POSITIVE_INFINITY,
  excludeHardlinks = false,
  rejectNonRegular = false,
}) {
  const files = new Set();
  const realRoot = realpathSync(root);

  for (const candidate of candidates) {
    const relativePath = normalizeRelativePath(candidate);
    if (!relativePath) continue;
    const segments = relativePath.split("/");
    let parentPath = root;
    for (const segment of segments.slice(0, -1)) {
      parentPath = path.join(parentPath, segment);
      if (existsSync(parentPath) && lstatSync(parentPath).isSymbolicLink()) {
        throw new Error(`Repository source path has a symlinked parent: ${relativePath}`);
      }
    }
    const absolutePath = path.join(root, ...segments);
    if (!existsSync(absolutePath)) continue;
    const linkStats = lstatSync(absolutePath);
    if (linkStats.isSymbolicLink() || !linkStats.isFile() || linkStats.nlink !== 1) {
      if (rejectNonRegular) {
        throw new Error(
          `Portable transfer source is not a single-link regular file: ${relativePath}`,
        );
      }
      if (excludeHardlinks && linkStats.nlink !== 1) continue;
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) continue;
    }
    const resolvedPath = realpathSync(absolutePath);
    const resolvedRelative = path.relative(realRoot, resolvedPath);
    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelative)
    ) {
      throw new Error(`Repository source path resolves outside the repository: ${relativePath}`);
    }
    if (linkStats.size > maxBytes) continue;
    files.add(relativePath);
  }

  return [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function regularRepositoryFileInventory({
  root = repositoryRoot,
  maxBytes = Number.POSITIVE_INFINITY,
  excludeHardlinks = false,
  rejectNonRegular = false,
  includeUntracked = true,
  activeOnly = false,
  portableOnly = false,
} = {}) {
  const inventory = sourcePathInventory(root, { includeUntracked });
  let candidates = inventory.candidates;
  if (activeOnly) candidates = candidates.filter((candidate) => !isExcludedActivePath(candidate));
  if (portableOnly) assertPortableFiles(candidates);
  const protectedRuntimePaths =
    activeOnly || portableOnly
      ? []
      : candidates.filter((candidate) => isPrivateCodexRuntimePath(candidate));
  if (protectedRuntimePaths.length > 0) {
    candidates = candidates.filter((candidate) => !isPrivateCodexRuntimePath(candidate));
  }
  return {
    files: [
      ...listRegularFiles({
        candidates,
        excludeHardlinks,
        maxBytes,
        rejectNonRegular,
        root,
      }),
      ...protectedRuntimePaths,
    ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    mode: inventory.mode,
  };
}

function listRegularRepositoryFiles(options = {}) {
  return regularRepositoryFileInventory(options).files;
}

export function listRepositoryFiles(options = {}) {
  return listRegularRepositoryFiles(options);
}

export function listRepositoryFileInventory(options = {}) {
  return regularRepositoryFileInventory(options);
}

export function listRepositoryPathInventory({
  root = repositoryRoot,
  includeUntracked = true,
} = {}) {
  const inventory = sourcePathInventory(root, { includeUntracked });
  return {
    mode: inventory.mode,
    paths: [...new Set(inventory.candidates.map(normalizeRelativePath).filter(Boolean))].sort(
      (left, right) => (left < right ? -1 : left > right ? 1 : 0),
    ),
  };
}

export function listActiveFiles({
  root = repositoryRoot,
  maxBytes = Number.POSITIVE_INFINITY,
} = {}) {
  return listRegularRepositoryFiles({
    root,
    maxBytes,
    activeOnly: true,
    excludeHardlinks: true,
  });
}

function assertPortableFiles(files) {
  const findings = files
    .map((relativePath) => ({
      path: relativePath,
      reason: nonPortableTransferPathReason(relativePath),
    }))
    .filter((finding) => finding.reason);
  if (findings.length > 0) {
    throw new Error(
      [
        "Portable transfer inventory contains nonportable paths:",
        ...findings.map((finding) => `- ${finding.path} (${finding.reason})`),
      ].join("\n"),
    );
  }
  return files;
}

export function listPortableTransferFiles({ root = repositoryRoot, includeUntracked = true } = {}) {
  return assertPortableFiles(
    listRegularRepositoryFiles({
      root,
      rejectNonRegular: true,
      includeUntracked,
      portableOnly: true,
    }),
  );
}

export function listStagedTransferFiles({ root = repositoryRoot } = {}) {
  return assertPortableFiles(
    listRegularFiles({
      candidates: stagedTransferPaths(root),
      rejectNonRegular: true,
      root,
    }),
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const profileArgument = [...args].find((argument) => argument.startsWith("--profile="));
  const profile = profileArgument?.slice("--profile=".length) ?? "active";
  let files;
  if (profile === "base") files = listRepositoryFiles();
  else if (profile === "portable-transfer") files = listPortableTransferFiles();
  else if (profile === "active") files = listActiveFiles();
  else {
    throw new Error(`Unknown source inventory profile: ${profile}`);
  }
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
    return;
  }
  if (args.has("--null")) {
    for (const file of files) {
      process.stdout.write(file);
      process.stdout.write("\0");
    }
    return;
  }
  for (const file of files) process.stdout.write(`${file}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
