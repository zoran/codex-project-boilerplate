import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listPortableTransferFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import {
  captureStableRepositoryFileIdentity,
  copyStableRepositoryFile,
} from "../repository/stable-file-snapshot.mjs";
import { formatContextError } from "../context/terminal-output.mjs";

function fail(message) {
  throw new Error(message);
}

function isContainedPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function ensureProductSourceBoundary(targetRoot) {
  const productSourceRoot = path.join(targetRoot, "src");
  mkdirSync(productSourceRoot, { recursive: true });
  if (readdirSync(productSourceRoot).length === 0) {
    writeFileSync(path.join(productSourceRoot, ".gitkeep"), "", { mode: 0o644 });
  }
}

export function stageProjectExport({ sourceRoot = repositoryRoot, targetRoot } = {}) {
  if (!targetRoot) fail("Export staging target is required.");

  const source = realpathSync(sourceRoot);
  const targetParent = realpathSync(path.dirname(targetRoot));
  const target = path.resolve(targetRoot);
  if (existsSync(target)) fail("Export staging target must not already exist.");
  if (!isContainedPath(target, targetParent)) {
    fail("Export staging target must be a direct child of its real parent directory.");
  }
  if (target === source || isContainedPath(target, source) || isContainedPath(source, target)) {
    fail("Export staging target must be outside the source repository.");
  }

  mkdirSync(target, { recursive: false, mode: 0o700 });

  const transferEntries = listPortableTransferFiles({
    root: source,
    includeUntracked: false,
  }).map((relativePath) => ({
    relativePath,
    ...captureStableRepositoryFileIdentity({ repositoryRoot: source, relativePath }),
  }));
  for (const entry of transferEntries) {
    const targetPath = path.join(target, ...entry.relativePath.split("/"));
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyStableRepositoryFile({
      repositoryRoot: source,
      relativePath: entry.relativePath,
      targetRoot: target,
      expectedIdentity: entry.identity,
    });
  }

  ensureProductSourceBoundary(target);
}

function main() {
  const targetRoot = process.argv[2];
  if (!targetRoot || process.argv.length !== 3) {
    fail("Usage: node scripts/setup/stage-project-export.mjs <empty-target-directory>");
  }
  stageProjectExport({ targetRoot });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Project export staging failed: ${formatContextError(error, repositoryRoot)}`);
    process.exit(1);
  }
}
