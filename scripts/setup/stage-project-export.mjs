import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { portableFileMode } from "../repository/portable-file-mode.mjs";
import { listPortableTransferFiles, repositoryRoot } from "../repository/source-inventory.mjs";

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

  for (const relativePath of listPortableTransferFiles({ root: source, includeUntracked: false })) {
    const sourcePath = path.join(source, ...relativePath.split("/"));
    const targetPath = path.join(target, ...relativePath.split("/"));
    const stats = lstatSync(sourcePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(`Transfer inventory contains a non-regular file: ${relativePath}`);
    }
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, portableFileMode(sourcePath));
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
    console.error(`Project export staging failed: ${error.message}`);
    process.exit(1);
  }
}
