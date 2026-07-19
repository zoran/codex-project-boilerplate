export function fail(message) {
  throw new Error(message);
}

export function usage() {
  return [
    "Usage:",
    "  mise exec --locked -- node .agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
    '    --name "<Project Name>" [--directory <project-folder>] [--output-parent <path>] [--include-untracked]',
  ].join("\n");
}

function optionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(optionName + " requires a value.");
  return value;
}

export function parseArgs(argv) {
  const options = {
    directory: "",
    help: false,
    includeUntracked: false,
    name: "",
    outputParent: "",
    skipVerify: false,
    source: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--include-untracked") options.includeUntracked = true;
    else if (argument === "--skip-verify") options.skipVerify = true;
    else if (argument.startsWith("--name=")) options.name = argument.slice(7);
    else if (argument === "--name") {
      options.name = optionValue(argv, index, "--name");
      index += 1;
    } else if (argument.startsWith("--directory=")) options.directory = argument.slice(12);
    else if (argument === "--directory") {
      options.directory = optionValue(argv, index, "--directory");
      index += 1;
    } else if (argument.startsWith("--source=")) options.source = argument.slice(9);
    else if (argument === "--source") {
      options.source = optionValue(argv, index, "--source");
      index += 1;
    } else if (argument.startsWith("--output-parent=")) options.outputParent = argument.slice(16);
    else if (argument === "--output-parent") {
      options.outputParent = optionValue(argv, index, "--output-parent");
      index += 1;
    } else if (!argument.startsWith("--") && !options.name) options.name = argument;
    else fail("Unknown argument.");
  }
  return options;
}

export function normalizedName(value) {
  const name = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) fail('A project name is required. Pass --name "<Project Name>".');
  if (/[\u0000-\u001f\u007f]/u.test(name)) fail("Project name contains a control character.");
  return name;
}

export function slugify(value, label) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    fail(label + " could not be derived safely; provide --directory explicitly.");
  }
  return slug;
}

export function directoryName(value) {
  const name = String(value).trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    name === "." ||
    name === ".." ||
    /[\/\\]/.test(name)
  ) {
    fail("Directory must be one safe path segment.");
  }
  return name;
}

export function defaultDirectoryName(projectName) {
  try {
    return directoryName(projectName);
  } catch {
    return slugify(projectName, "directory name");
  }
}

function isStrictDescendant(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requiredRealDirectory(value, label) {
  if (!existsSync(value)) fail("Missing required " + label + ".");
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(label + " must be a real directory.");
  }
  return realpathSync(value);
}

function defaultOutputParent(sourceRoot) {
  const sourceParent = path.dirname(sourceRoot);
  return path.basename(sourceRoot) === "code" ? path.dirname(sourceParent) : sourceParent;
}

export function resolveProjectRoots({ defaultSourceRoot, options, projectDirectoryName }) {
  const sourceRoot = requiredRealDirectory(
    path.resolve(options.source || defaultSourceRoot),
    "source repository",
  );
  const outputParent = requiredRealDirectory(
    path.resolve(options.outputParent || defaultOutputParent(sourceRoot)),
    "output parent",
  );
  const projectRoot = path.join(outputParent, projectDirectoryName);
  const targetRoot = path.join(projectRoot, "code");
  if (existsSync(projectRoot)) fail("Target project directory already exists.");
  if (
    projectRoot === sourceRoot ||
    isStrictDescendant(projectRoot, sourceRoot) ||
    isStrictDescendant(sourceRoot, projectRoot)
  ) {
    fail("Source and target must be separate sibling workspaces.");
  }
  return { sourceRoot, outputParent, projectRoot, targetRoot };
}
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
