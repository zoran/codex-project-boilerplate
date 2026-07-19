import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { discoverProductLayout, overlappingProductRoots } from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";
import { isContextMaintenanceEntryName } from "./context-maintenance.mjs";

export const indexOwnershipMarker = ".codex-context-index.json";
const markerPayload = { kind: "codex-context-index", version: 1 };
const reservedProjectRoots = new Set([".codex", ".git"]);

function isWithin(parent, candidate, { allowSame = false } = {}) {
  const relative = path.relative(parent, candidate);
  if (relative === "") return allowSame;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathLabel(label, candidate) {
  return `${label} (${candidate})`;
}

export function resolveRepositoryRoot(configuredRoot) {
  const absoluteRoot = path.resolve(configuredRoot);
  let stats;
  try {
    stats = lstatSync(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Context repository root does not exist: ${absoluteRoot}`);
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Context repository root must be a non-symlink directory: ${absoluteRoot}`);
  }
  return realpathSync.native(absoluteRoot);
}

/**
 * Resolve a project-owned directory without following a symlink in any project-relative segment.
 * Missing tail segments are allowed so callers can validate before creating them.
 */
export function resolveOwnedDirectory({
  repositoryRoot,
  configuredPath,
  label = "Context directory",
  allowMissing = true,
}) {
  const root = resolveRepositoryRoot(repositoryRoot);
  const candidate = path.resolve(root, configuredPath);
  if (!isWithin(root, candidate)) {
    throw new Error(`${label} must be a strict descendant of the repository root.`);
  }

  const relativeSegments = path.relative(root, candidate).split(path.sep);
  let cursor = root;
  let missingTail = false;
  for (const segment of relativeSegments) {
    cursor = path.join(cursor, segment);
    if (missingTail || !existsSync(cursor)) {
      missingTail = true;
      continue;
    }
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`${pathLabel(label, candidate)} traverses symbolic link ${cursor}.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${pathLabel(label, candidate)} traverses non-directory ${cursor}.`);
    }
    const real = realpathSync.native(cursor);
    if (!isWithin(root, real, { allowSame: false })) {
      throw new Error(`${pathLabel(label, candidate)} resolves outside the repository root.`);
    }
  }

  if (!allowMissing && missingTail) {
    throw new Error(`${label} does not exist: ${candidate}`);
  }
  return candidate;
}

export function ensureOwnedDirectory(options, { mode = 0o700 } = {}) {
  const candidate = resolveOwnedDirectory(options);
  const root = resolveRepositoryRoot(options.repositoryRoot);
  let cursor = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      mkdirSync(cursor, { mode });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${options.label ?? "Context directory"} is not a safe directory: ${cursor}`);
    }
  }
  return resolveOwnedDirectory({ ...options, allowMissing: false });
}

export function assertSafeIndexDirectory(
  repositoryRoot,
  indexDirectory,
  { allowMissing = true } = {},
) {
  const candidate = resolveOwnedDirectory({
    repositoryRoot,
    configuredPath: indexDirectory,
    label: "Context index directory",
    allowMissing,
  });
  const root = resolveRepositoryRoot(repositoryRoot);
  const firstSegment = path.relative(root, candidate).split(path.sep)[0];
  if (reservedProjectRoots.has(firstSegment)) {
    throw new Error("Context index directory cannot overlap reserved project state.");
  }
  const relativeCandidate = path.relative(root, candidate).split(path.sep).join("/");
  const productOverlap = overlappingProductRoots(
    relativeCandidate,
    discoverProductLayout({
      repositoryRoot: root,
      relativePaths: listActiveFiles({ root }),
    }),
  );
  if (productOverlap.length > 0) {
    throw new Error(`Context index directory cannot overlap product root ${productOverlap[0]}.`);
  }
  return candidate;
}

function validOwnershipMarker(indexDirectory) {
  const markerPath = path.join(indexDirectory, indexOwnershipMarker);
  try {
    const stats = lstatSync(markerPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return marker?.kind === markerPayload.kind && marker?.version === markerPayload.version;
  } catch {
    return false;
  }
}

function ownershipMarkerExists(indexDirectory) {
  return existsSync(path.join(indexDirectory, indexOwnershipMarker));
}

function isGeneratedIndexEntry(name) {
  return (
    name === indexOwnershipMarker ||
    name === "lancedb" ||
    name === "manifest.json" ||
    name === "model-cache" ||
    name === "database-transaction.json" ||
    name === "database-repair-required.json" ||
    isContextMaintenanceEntryName(name)
  );
}

function isSafeGeneratedEntry(indexDirectory, name) {
  if (!isGeneratedIndexEntry(name)) return false;
  const stats = lstatSync(path.join(indexDirectory, name));
  if (/^\.context-removal-file-/.test(name)) return stats.isFile();
  if (/^\.context-removal-directory-/.test(name)) return stats.isDirectory();
  if (stats.isSymbolicLink()) return false;
  if (name === "lancedb" || name === "model-cache" || /^lancedb\.(?:next|previous)-/.test(name)) {
    return stats.isDirectory();
  }
  return stats.isFile();
}

function assertOnlyGeneratedEntries(indexDirectory) {
  const unexpected = readdirSync(indexDirectory).filter(
    (name) => !isSafeGeneratedEntry(indexDirectory, name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Context index directory contains non-index content and will not be modified: ${unexpected[0]}`,
    );
  }
}

function writeOwnershipMarker(indexDirectory) {
  writeFileSync(
    path.join(indexDirectory, indexOwnershipMarker),
    `${JSON.stringify(markerPayload)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export function ensureOwnedIndexDirectory({ repositoryRoot, indexDirectory }) {
  const candidate = assertSafeIndexDirectory(repositoryRoot, indexDirectory);
  const existed = existsSync(candidate);
  ensureOwnedDirectory({
    repositoryRoot,
    configuredPath: candidate,
    label: "Context index directory",
  });
  assertOnlyGeneratedEntries(candidate);
  if (validOwnershipMarker(candidate)) return candidate;
  if (ownershipMarkerExists(candidate)) {
    throw new Error("Context index directory has an invalid ownership marker.");
  }
  if (existed && path.basename(candidate) !== ".context-index") {
    throw new Error("Existing custom context index directory has no ownership marker.");
  }
  writeOwnershipMarker(candidate);
  return candidate;
}

export function assertOwnedIndexDirectory({ repositoryRoot, indexDirectory, allowMissing = true }) {
  const candidate = assertSafeIndexDirectory(repositoryRoot, indexDirectory, { allowMissing });
  if (!existsSync(candidate)) return candidate;
  assertOnlyGeneratedEntries(candidate);
  if (!validOwnershipMarker(candidate)) {
    if (ownershipMarkerExists(candidate)) {
      throw new Error("Context index cleanup found an invalid ownership marker.");
    }
    if (path.basename(candidate) !== ".context-index") {
      throw new Error("Context index cleanup requires a valid ownership marker.");
    }
    writeOwnershipMarker(candidate);
  }
  return candidate;
}
