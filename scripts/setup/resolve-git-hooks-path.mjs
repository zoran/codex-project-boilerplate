import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function absoluteFromRepository(repositoryRoot, value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repositoryRoot, value);
}

function isStrictDescendant(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function assertExistingAncestorsAreReal(root, target) {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!existsSync(cursor)) continue;
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) fail(`Refusing symlinked Git hook path component: ${cursor}`);
    const real = realpathSync(cursor);
    if (real !== root && !isStrictDescendant(root, real)) {
      fail(`Git hook path escapes the repository Git common directory: ${cursor}`);
    }
  }
}

const [repositoryRootArgument, commonDirectoryArgument, hooksDirectoryArgument] =
  process.argv.slice(2);
if (!repositoryRootArgument || !commonDirectoryArgument || !hooksDirectoryArgument) {
  fail("Usage: resolve-git-hooks-path.mjs <repository-root> <git-common-dir> <hooks-dir>");
}

const repositoryRoot = realpathSync(path.resolve(repositoryRootArgument));
const commonDirectoryPath = absoluteFromRepository(repositoryRoot, commonDirectoryArgument);
if (!existsSync(commonDirectoryPath)) fail("Git common directory does not exist.");
const commonStats = lstatSync(commonDirectoryPath);
if (commonStats.isSymbolicLink() || !commonStats.isDirectory()) {
  fail("Git common directory must be a real directory, not a symlink.");
}
const commonDirectory = realpathSync(commonDirectoryPath);
const hooksDirectory = absoluteFromRepository(repositoryRoot, hooksDirectoryArgument);
if (!isStrictDescendant(commonDirectory, hooksDirectory)) {
  fail(
    "Refusing core.hooksPath outside this repository's Git common directory; no hook was installed.",
  );
}
assertExistingAncestorsAreReal(commonDirectory, hooksDirectory);
console.log(hooksDirectory);
