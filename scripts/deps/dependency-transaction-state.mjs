import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DependencyTransactionError, projectIdentity } from "./dependency-inputs.mjs";

const defaultStaleMilliseconds = 30 * 60 * 1000;

function ensureRealDirectory(directory, mode = 0o700) {
  if (!existsSync(directory)) {
    try {
      mkdirSync(directory, { mode });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new DependencyTransactionError(
      `Transaction state path must be a real directory: ${directory}`,
    );
  }
  chmodSync(directory, mode);
}

export function dependencyTransactionPaths(projectRoot) {
  const { root } = projectIdentity(projectRoot);
  const projectState = path.join(root, ".project-state");
  const state = path.join(projectState, "dependency-update");
  ensureRealDirectory(projectState);
  ensureRealDirectory(state);
  return {
    state,
    plan: path.join(state, "plan.json"),
    journal: path.join(state, "journal.json"),
    lock: path.join(state, "transaction.lock"),
  };
}

export function atomicWrite(filePath, content, mode = 0o600) {
  const parent = path.dirname(filePath);
  const parentStats = lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new DependencyTransactionError(`Unsafe transaction output directory: ${parent}`);
  }
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    throw new DependencyTransactionError(`Refusing symlinked transaction output: ${filePath}`);
  }
  const temporaryPath = path.join(
    parent,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}`,
  );
  const descriptor = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function readJsonFile(filePath, label) {
  if (!existsSync(filePath)) throw new DependencyTransactionError(`Missing ${label}.`);
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new DependencyTransactionError(`${label} must be a real file.`);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new DependencyTransactionError(`${label} contains invalid JSON.`);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockDirectory) {
  try {
    return JSON.parse(readFileSync(path.join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function staleLock(lockDirectory, owner, staleMilliseconds) {
  if (owner?.host === os.hostname() && Number.isInteger(owner?.pid)) {
    return !processIsAlive(owner.pid);
  }
  return Date.now() - statSync(lockDirectory).mtimeMs > staleMilliseconds;
}

export function acquireDependencyTransactionLock(projectRoot, options = {}) {
  const paths = dependencyTransactionPaths(projectRoot);
  const owner = {
    token: options.token ?? randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const staleMilliseconds = options.staleMilliseconds ?? defaultStaleMilliseconds;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      mkdirSync(paths.lock, { mode: 0o700 });
      created = true;
      atomicWrite(path.join(paths.lock, "owner.json"), `${JSON.stringify(owner)}\n`);
      return { path: paths.lock, owner };
    } catch (error) {
      if (created) {
        rmSync(paths.lock, { recursive: true, force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
      const existing = readLockOwner(paths.lock);
      if (!staleLock(paths.lock, existing, staleMilliseconds)) {
        const summary = existing?.pid ? `process ${existing.pid}` : "another process";
        throw new DependencyTransactionError(`Dependency update is locked by ${summary}.`, 75);
      }
      const quarantine = `${paths.lock}.stale-${randomUUID()}`;
      renameSync(paths.lock, quarantine);
      const quarantinedOwner = readLockOwner(quarantine);
      if (quarantinedOwner?.token !== existing?.token) {
        if (!existsSync(paths.lock)) renameSync(quarantine, paths.lock);
        throw new DependencyTransactionError(
          "Dependency lock ownership changed during stale-lock recovery.",
          75,
        );
      }
      rmSync(quarantine, { recursive: true, force: true });
    }
  }
  throw new DependencyTransactionError("Could not acquire the dependency update lock.", 75);
}

export function releaseDependencyTransactionLock(handle) {
  if (!handle || !existsSync(handle.path)) return;
  const current = readLockOwner(handle.path);
  if (current?.token !== handle.owner.token) {
    throw new DependencyTransactionError(
      "Dependency lock ownership changed; refusing to remove it.",
      75,
    );
  }
  rmSync(handle.path, { recursive: true });
}

export function withDependencyTransactionLock(projectRoot, action, options = {}) {
  const handle = acquireDependencyTransactionLock(projectRoot, options);
  try {
    return action(handle);
  } finally {
    releaseDependencyTransactionLock(handle);
  }
}
