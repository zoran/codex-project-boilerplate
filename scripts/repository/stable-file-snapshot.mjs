import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const defaultChunkBytes = 64 * 1024;

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function stableIdentity(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.nlink]
    .map((value) => value.toString())
    .join(":");
}

function directoryIdentity(stats) {
  return [stats.dev, stats.ino].map((value) => value.toString()).join(":");
}

function sameFileObject(left, right) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink
  );
}

function safeSegments(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.includes("\0")
  ) {
    throw new Error("Repository file snapshot requires a safe canonical relative path.");
  }
  return relativePath.split("/");
}

function missingSnapshotFile() {
  const error = new Error("Repository file snapshot source disappeared before it could be read.");
  error.code = "ENOENT";
  return error;
}

function realDirectory(directoryPath, label) {
  const stats = lstatSync(directoryPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} requires a real directory.`);
  }
  return { identity: directoryIdentity(stats), path: realpathSync.native(directoryPath) };
}

function captureParentIdentities(root, segments, label) {
  const identities = [];
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const stats = lstatSync(parent, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${label} refused a non-directory or symlinked parent.`);
    }
    identities.push({ path: parent, identity: directoryIdentity(stats) });
  }
  return identities;
}

function validateParentIdentities(parentIdentities, label) {
  for (const parentIdentity of parentIdentities) {
    const current = lstatSync(parentIdentity.path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      directoryIdentity(current) !== parentIdentity.identity
    ) {
      throw new Error(`${label} detected a parent identity change.`);
    }
  }
}

function validatePathBinding(snapshot, descriptorStats, label, { stable = true } = {}) {
  let linkStats;
  let resolvedPath;
  let resolvedStats;
  try {
    linkStats = lstatSync(snapshot.absolutePath, { bigint: true });
    resolvedPath = realpathSync.native(snapshot.absolutePath);
    resolvedStats = lstatSync(resolvedPath, { bigint: true });
  } catch {
    throw new Error(`${label} detected a path binding change.`);
  }
  const identityMatches = stable
    ? stableIdentity(linkStats) === stableIdentity(descriptorStats) &&
      stableIdentity(resolvedStats) === stableIdentity(descriptorStats)
    : sameFileObject(linkStats, descriptorStats) && sameFileObject(resolvedStats, descriptorStats);
  if (
    linkStats.isSymbolicLink() ||
    linkStats.nlink !== 1n ||
    !insideRoot(snapshot.root, resolvedPath) ||
    resolvedPath !== snapshot.resolvedPath ||
    !identityMatches
  ) {
    throw new Error(`${label} detected a path binding change.`);
  }
}

function openStableRepositoryFile({ repositoryRoot, relativePath, expectedIdentity, testHooks }) {
  const rootDirectory = realDirectory(repositoryRoot, "Repository file snapshot");
  const root = rootDirectory.path;
  const segments = safeSegments(relativePath);
  const parentIdentities = [
    { path: root, identity: rootDirectory.identity },
    ...captureParentIdentities(root, segments, "Repository file snapshot"),
  ];
  const absolutePath = path.join(root, ...segments);
  testHooks?.beforeOpen?.({ absolutePath });
  if (!existsSync(absolutePath)) throw missingSnapshotFile();
  let resolvedPath;
  try {
    resolvedPath = realpathSync.native(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw missingSnapshotFile();
    throw error;
  }
  if (!insideRoot(root, resolvedPath)) {
    throw new Error("Repository file snapshot refused a path outside the repository.");
  }
  const linkStats = lstatSync(absolutePath, { bigint: true });
  if (linkStats.isSymbolicLink() || !linkStats.isFile() || linkStats.nlink !== 1n) {
    throw new Error(
      "Repository file snapshot requires a single-link, non-symlink regular repository file.",
    );
  }
  const identity = stableIdentity(linkStats);
  if (expectedIdentity && expectedIdentity !== identity) {
    throw new Error("Repository file snapshot detected a change since inventory capture.");
  }

  const descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || stableIdentity(before) !== identity) {
      throw new Error("Repository file snapshot detected an identity change while opening.");
    }
    testHooks?.afterOpen?.({ absolutePath });
    return {
      absolutePath,
      before,
      descriptor,
      identity,
      parentIdentities,
      resolvedPath,
      root,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function validateOpenedFile(snapshot, bytesRead, { complete }) {
  const after = fstatSync(snapshot.descriptor, { bigint: true });
  if (stableIdentity(snapshot.before) !== stableIdentity(after)) {
    throw new Error("Repository file snapshot detected a change while reading.");
  }
  if (complete && bytesRead !== Number(after.size)) {
    throw new Error("Repository file snapshot detected an incomplete read.");
  }
  validatePathBinding(snapshot, after, "Repository file snapshot");
  validateParentIdentities(snapshot.parentIdentities, "Repository file snapshot");
  validatePathBinding(snapshot, after, "Repository file snapshot");
  return after;
}

export function captureStableRepositoryFileIdentity(options) {
  const snapshot = openStableRepositoryFile(options);
  try {
    validateOpenedFile(snapshot, 0, { complete: false });
    return { bytes: Number(snapshot.before.size), identity: snapshot.identity };
  } finally {
    closeSync(snapshot.descriptor);
  }
}

export function readStableRepositoryFile(options) {
  const snapshot = openStableRepositoryFile(options);
  try {
    const buffer = readFileSync(snapshot.descriptor);
    validateOpenedFile(snapshot, buffer.length, { complete: true });
    return { buffer, bytes: buffer.length, identity: snapshot.identity };
  } finally {
    closeSync(snapshot.descriptor);
  }
}

export function readStableRepositoryPrefix({ maxBytes, ...options }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Repository prefix snapshot requires a non-negative integer byte bound.");
  }
  const snapshot = openStableRepositoryFile(options);
  try {
    const requested = Math.min(maxBytes, Number(snapshot.before.size));
    const buffer = Buffer.alloc(requested);
    let bytes = 0;
    while (bytes < requested) {
      const count = readSync(snapshot.descriptor, buffer, bytes, requested - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== requested) {
      throw new Error("Repository file snapshot detected an incomplete prefix read.");
    }
    validateOpenedFile(snapshot, bytes, { complete: bytes === Number(snapshot.before.size) });
    return {
      buffer: bytes === buffer.length ? buffer : buffer.subarray(0, bytes),
      bytes,
      fileBytes: Number(snapshot.before.size),
      identity: snapshot.identity,
      truncated: bytes < Number(snapshot.before.size),
    };
  } finally {
    closeSync(snapshot.descriptor);
  }
}

export function scanStableRepositoryFile({ onChunk, chunkBytes = defaultChunkBytes, ...options }) {
  if (typeof onChunk !== "function") {
    throw new Error("Repository file scan requires a synchronous chunk consumer.");
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) {
    throw new Error("Repository file scan chunk size is outside its bounded range.");
  }
  const snapshot = openStableRepositoryFile(options);
  try {
    const chunk = Buffer.alloc(chunkBytes);
    let bytes = 0;
    while (true) {
      const count = readSync(snapshot.descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      bytes += count;
      onChunk(chunk.subarray(0, count));
    }
    validateOpenedFile(snapshot, bytes, { complete: true });
    return { bytes, identity: snapshot.identity };
  } finally {
    closeSync(snapshot.descriptor);
  }
}

export function copyStableRepositoryFile({
  repositoryRoot,
  relativePath,
  targetRoot,
  targetRelativePath = relativePath,
  expectedIdentity,
  testHooks,
}) {
  const source = openStableRepositoryFile({
    repositoryRoot,
    relativePath,
    expectedIdentity,
    testHooks: testHooks?.source,
  });
  let targetPath;
  let targetDescriptor;
  let targetCreated = false;
  let targetSnapshot;
  let targetObjectStats;
  try {
    const targetDirectory = realDirectory(targetRoot, "Repository file copy target");
    const targetSegments = safeSegments(targetRelativePath);
    const targetParents = [
      { path: targetDirectory.path, identity: targetDirectory.identity },
      ...captureParentIdentities(
        targetDirectory.path,
        targetSegments,
        "Repository file copy target",
      ),
    ];
    targetPath = path.join(targetDirectory.path, ...targetSegments);
    testHooks?.beforeTargetOpen?.({ targetPath });
    targetDescriptor = openSync(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    targetCreated = true;
    targetObjectStats = fstatSync(targetDescriptor, { bigint: true });
    targetSnapshot = {
      absolutePath: targetPath,
      resolvedPath: realpathSync.native(targetPath),
      root: targetDirectory.path,
    };
    testHooks?.afterTargetOpen?.({ targetPath });
    validatePathBinding(targetSnapshot, targetObjectStats, "Repository file copy target");
    validateParentIdentities(targetParents, "Repository file copy target");
    const chunk = Buffer.alloc(defaultChunkBytes);
    let bytes = 0;
    let executable = false;
    while (true) {
      const count = readSync(source.descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      if (bytes === 0) executable = count >= 2 && chunk[0] === 0x23 && chunk[1] === 0x21;
      let written = 0;
      while (written < count) {
        written += writeSync(targetDescriptor, chunk, written, count - written);
      }
      bytes += count;
    }
    validateOpenedFile(source, bytes, { complete: true });
    validateParentIdentities(targetParents, "Repository file copy target");
    let targetStats = fstatSync(targetDescriptor, { bigint: true });
    if (!targetStats.isFile() || targetStats.nlink !== 1n || Number(targetStats.size) !== bytes) {
      throw new Error("Repository file copy target changed while writing.");
    }
    fchmodSync(targetDescriptor, executable ? 0o755 : 0o644);
    targetStats = fstatSync(targetDescriptor, { bigint: true });
    validatePathBinding(targetSnapshot, targetStats, "Repository file copy target");
    validateParentIdentities(targetParents, "Repository file copy target");
    validatePathBinding(targetSnapshot, targetStats, "Repository file copy target");
    return { bytes, executable, identity: source.identity };
  } catch (error) {
    if (targetDescriptor !== undefined) {
      closeSync(targetDescriptor);
      targetDescriptor = undefined;
    }
    if (targetCreated && targetPath && targetSnapshot && targetObjectStats) {
      try {
        validatePathBinding(targetSnapshot, targetObjectStats, "Repository file copy cleanup", {
          stable: false,
        });
        rmSync(targetPath, { force: true });
      } catch {
        // Never delete through a target path whose identity is no longer proven.
      }
    }
    throw error;
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    closeSync(source.descriptor);
  }
}

export function readStableRepositoryText(options) {
  const { buffer, bytes, identity } = readStableRepositoryFile(options);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("Repository text snapshot is not valid UTF-8.");
  }
  return { text, bytes, identity };
}

export function readStableRepositoryPrefixText(options) {
  const result = readStableRepositoryPrefix(options);
  return { ...result, text: new TextDecoder("utf-8").decode(result.buffer) };
}
