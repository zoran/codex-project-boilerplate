import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const maximumRemovalTreeEntries = 100_000;

function artifactType(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

export function sameObjectIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    artifactType(left) === artifactType(right)
  );
}

export function sameStableIdentity(left, right) {
  return (
    sameObjectIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function safeArtifactStats(artifactPath, expectedType, label) {
  const stats = lstatSync(artifactPath);
  const type = artifactType(stats);
  if (stats.isSymbolicLink() || type !== expectedType) {
    throw new Error(`Context maintenance refused malformed ${label}.`);
  }
  if (type === "file" && stats.nlink !== 1) {
    throw new Error(`Context maintenance refused hardlinked ${label}.`);
  }
  return stats;
}

export function validateRemovalTree(rootPath, expectedType, label, ownerDevice) {
  const rootStats = safeArtifactStats(rootPath, expectedType, label);
  if (ownerDevice !== undefined && rootStats.dev !== ownerDevice) {
    throw new Error(`Context maintenance refused foreign-filesystem ${label}.`);
  }
  if (expectedType === "file") return rootStats;
  let visited = 0;
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maximumRemovalTreeEntries) {
        throw new Error(`Context maintenance refused oversized ${label}.`);
      }
      const entryPath = path.join(directory, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.dev !== rootStats.dev) {
        throw new Error(`Context maintenance refused foreign-filesystem content in ${label}.`);
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Context maintenance refused symlinked content in ${label}.`);
      }
      if (stats.isDirectory()) pending.push(entryPath);
      else if (!stats.isFile()) {
        throw new Error(`Context maintenance refused special content in ${label}.`);
      } else if (stats.nlink !== 1) {
        throw new Error(`Context maintenance refused hardlinked content in ${label}.`);
      }
    }
  }
  return rootStats;
}

export function validateDirectoryChain(rootPath, targetPath, label) {
  const relative = path.relative(rootPath, targetPath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Context maintenance refused ${label} outside its owned root.`);
  }
  let current = rootPath;
  const rootStats = safeArtifactStats(current, "directory", label);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = safeArtifactStats(current, "directory", label);
    if (stats.dev !== rootStats.dev) {
      throw new Error(`Context maintenance refused foreign-filesystem ${label}.`);
    }
  }
}

export function readStableArtifactFile(artifactPath, label) {
  const initialStats = safeArtifactStats(artifactPath, "file", label);
  let descriptor;
  try {
    descriptor = openSync(artifactPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!sameStableIdentity(initialStats, before)) {
      throw new Error(`Context maintenance detected an identity change in ${label}.`);
    }
    const buffer = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (!sameStableIdentity(before, after) || buffer.length !== after.size) {
      throw new Error(`Context maintenance detected a content change in ${label}.`);
    }
    return { buffer, stats: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function restoreClaim(claimPath, originalPath) {
  if (existsSync(claimPath) && !existsSync(originalPath)) renameSync(claimPath, originalPath);
}

export function claimAndRemove({ artifactPath, expectedType, label, ownerDevice, testHooks }) {
  const initialStats = validateRemovalTree(artifactPath, expectedType, label, ownerDevice);
  testHooks?.afterArtifactValidation?.({ artifactPath, label });
  const beforeClaim = validateRemovalTree(artifactPath, expectedType, label, ownerDevice);
  if (!sameStableIdentity(initialStats, beforeClaim)) {
    throw new Error(`Context maintenance detected an identity change in ${label}.`);
  }
  const claimPath = path.join(
    path.dirname(artifactPath),
    `.context-removal-${expectedType}-${randomUUID()}`,
  );
  renameSync(artifactPath, claimPath);
  try {
    const claimedStats = safeArtifactStats(claimPath, expectedType, label);
    if (!sameObjectIdentity(beforeClaim, claimedStats)) {
      throw new Error(`Context maintenance detected an identity change in ${label}.`);
    }
    validateRemovalTree(claimPath, expectedType, label, ownerDevice);
    rmSync(claimPath, { recursive: expectedType === "directory", force: true });
  } catch (error) {
    restoreClaim(claimPath, artifactPath);
    throw error;
  }
}
