#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRepositoryProcessArtifactPath } from "../../../../scripts/docs/document-scope.mjs";
import { isRepositoryCodexHomePath } from "../../../../scripts/repository/source-inventory.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..", "..", "..", "..");
const removableTrees = [
  ".project-state",
  "dist/exports",
  "docs/goals",
  "docs/handoffs",
  "docs/planning",
  "docs/plans",
  "docs/reviews",
  "docs/slices",
  "docs/status",
  "docs/tasks",
  "docs/project-context.md",
  "scripts/planning",
];
const optionalEmptyDirectories = [
  "apps",
  "docs/adr",
  "docs/architecture",
  "docs/operations",
  "infra",
  "packages",
  "services",
];
const scanExcludedDirectories = new Set([
  ".codex",
  ".context-index",
  ".git",
  ".project-state",
  "node_modules",
]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { apply: false, root: defaultRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail("--root requires a path.");
      options.root = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--root=")) options.root = path.resolve(argument.slice(7));
    else fail(`Unknown argument: ${argument}`);
  }
  return options;
}

function requireBoilerplateRoot(rootValue) {
  if (!existsSync(rootValue)) fail(`Repository root does not exist: ${rootValue}`);
  const rootStats = lstatSync(rootValue);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail(`Repository root must be a real directory: ${rootValue}`);
  }
  const root = realpathSync(rootValue);
  const packagePath = path.join(root, "package.json");
  const skillPath = path.join(root, ".agents", "skills", "reset-boilerplate", "SKILL.md");
  if (!existsSync(packagePath) || lstatSync(packagePath).isSymbolicLink()) {
    fail("Reset refused: package.json is missing or is a symlink.");
  }
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.name !== "codex-project" || !existsSync(skillPath)) {
    fail("Reset refused: target is not the codex-project boilerplate.");
  }
  return root;
}

function relativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isEmptyRealDirectory(absolutePath) {
  if (!existsSync(absolutePath)) return false;
  const stats = lstatSync(absolutePath);
  return !stats.isSymbolicLink() && stats.isDirectory() && readdirSync(absolutePath).length === 0;
}

function scanProcessDocuments(root) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relative = relativePath(root, absolutePath);
      if (entry.isSymbolicLink()) continue;
      if (isRepositoryCodexHomePath(relative)) continue;
      if (entry.isDirectory()) {
        if (!scanExcludedDirectories.has(entry.name) && relative !== "dist/exports") {
          pending.push(absolutePath);
        }
      } else if (entry.isFile() && isRepositoryProcessArtifactPath(relative)) {
        matches.push(relative);
      }
    }
  }
  return matches;
}

function collectCandidates(root) {
  const candidates = new Set(scanProcessDocuments(root));
  for (const relative of removableTrees) {
    if (existsSync(path.join(root, ...relative.split("/")))) candidates.add(relative);
  }
  for (const relative of optionalEmptyDirectories) {
    if (isEmptyRealDirectory(path.join(root, ...relative.split("/")))) candidates.add(relative);
  }
  const ordered = [...candidates].sort();
  return ordered.filter(
    (candidate) =>
      !ordered.some(
        (parent) => parent !== candidate && candidate.startsWith(`${parent.replace(/\/$/, "")}/`),
      ),
  );
}

function pruneEmptyParents(root, startDirectory) {
  let current = startDirectory;
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (!isEmptyRealDirectory(current)) return;
    rmdirSync(current);
    current = path.dirname(current);
  }
}

function applyReset(root, candidates) {
  for (const relative of candidates) {
    const absolutePath = path.join(root, ...relative.split("/"));
    if (!existsSync(absolutePath)) continue;
    rmSync(absolutePath, { force: true, recursive: true });
    pruneEmptyParents(root, path.dirname(absolutePath));
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = requireBoilerplateRoot(options.root);
  const candidates = collectCandidates(root);

  if (!options.apply) {
    if (candidates.length === 0) {
      console.log("Boilerplate baseline is clean.");
      return;
    }
    console.log("Boilerplate reset would remove:");
    for (const candidate of candidates) console.log(`- ${candidate}`);
    console.log("Re-run with --apply after reviewing this list.");
    process.exitCode = 1;
    return;
  }

  applyReset(root, candidates);
  const residual = collectCandidates(root);
  if (residual.length > 0) fail(`Reset left removable state: ${residual.join(", ")}`);
  console.log(`Boilerplate reset complete; removed ${candidates.length} path(s).`);
  console.log(
    "Git history, portable .codex policy, and repository-root Codex runtime were preserved.",
  );
}

try {
  main();
} catch (error) {
  console.error(`Boilerplate reset failed: ${error.message}`);
  process.exit(1);
}
