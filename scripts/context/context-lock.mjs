import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultPollMs = 250;
const defaultLockTimeoutMs = 120_000;
const defaultStaleLockMs = 30_000;
const retirementClaimName = ".retirement-claim.json";

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredTimeoutMs() {
  return positiveInteger(process.env.CONTEXT_INDEX_LOCK_TIMEOUT_MS, defaultLockTimeoutMs);
}

function configuredStaleMs() {
  return positiveInteger(process.env.CONTEXT_INDEX_STALE_LOCK_MS, defaultStaleLockMs);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function lockOwnerPath(rebuildLockPath) {
  return path.join(rebuildLockPath, "owner.json");
}

function retirementClaimPath(rebuildLockPath) {
  return path.join(rebuildLockPath, retirementClaimName);
}

export function readLockOwner(rebuildLockPath) {
  const ownerPath = lockOwnerPath(rebuildLockPath);
  if (!existsSync(ownerPath)) return null;
  try {
    const stats = lstatSync(ownerPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (
      !owner ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.host !== "string" ||
      typeof owner.token !== "string" ||
      owner.token.length < 16 ||
      !Number.isFinite(Date.parse(owner.createdAt)) ||
      !Number.isFinite(Date.parse(owner.heartbeatAt))
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function atomicWriteOwner(rebuildLockPath, owner, { allowMissingOwner = false } = {}) {
  const ownerPath = lockOwnerPath(rebuildLockPath);
  const temporaryPath = path.join(rebuildLockPath, `.owner-${owner.token}-${process.pid}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const current = readLockOwner(rebuildLockPath);
  if (!current && !allowMissingOwner) {
    rmSync(temporaryPath, { force: true });
    return false;
  }
  if (current && current.token !== owner.token) {
    rmSync(temporaryPath, { force: true });
    return false;
  }
  renameSync(temporaryPath, ownerPath);
  return true;
}

function lockAgeMs(rebuildLockPath, owner) {
  const heartbeatMs = Date.parse(owner?.heartbeatAt ?? "");
  const createdMs = Date.parse(owner?.createdAt ?? "");
  let referenceMs;
  if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) referenceMs = heartbeatMs;
  else if (Number.isFinite(createdMs) && createdMs > 0) referenceMs = createdMs;
  else {
    try {
      referenceMs = statSync(rebuildLockPath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return Math.max(0, Date.now() - referenceMs);
}

function sameOwner(left, right) {
  if (!left || !right) return left === right;
  return left.pid === right.pid && left.host === right.host && left.token === right.token;
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function staleLockSnapshot(rebuildLockPath, staleLockMs) {
  if (!existsSync(rebuildLockPath)) return false;
  const lockStats = lstatSync(rebuildLockPath);
  if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
    throw new Error("Context rebuild lock path is not a safe directory.");
  }
  const owner = readLockOwner(rebuildLockPath);
  const ageMs = lockAgeMs(rebuildLockPath, owner);
  if (!owner) {
    return ageMs > staleLockMs ? { owner: null, stats: lockStats } : null;
  }

  // Project-local runtime state is not a distributed lock service. Refuse to guess whether a
  // foreign-host process is dead; an operator can remove that exceptional orphan explicitly.
  if (owner.host !== os.hostname()) {
    return null;
  }

  if (!isProcessRunning(owner.pid)) {
    return { owner, stats: lockStats };
  }

  // A live same-host process always wins over age heuristics; cleanup must never delete its lock.
  return null;
}

function removeClaimIfOwned(rebuildLockPath, claimToken) {
  const claimPath = retirementClaimPath(rebuildLockPath);
  try {
    const stats = lstatSync(claimPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    const claim = JSON.parse(readFileSync(claimPath, "utf8"));
    if (claim?.token !== claimToken) return false;
    rmSync(claimPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire a stale lock by claiming its exact directory generation and atomically renaming that
 * generation to quarantine before deletion. A replacement owner is never removed by a stale
 * observation from an earlier generation.
 */
export function retireStaleLockIfNeeded(rebuildLockPath, staleLockMs, { afterClaim } = {}) {
  const snapshot = staleLockSnapshot(rebuildLockPath, staleLockMs);
  if (!snapshot) return false;

  const claimToken = randomUUID();
  const claimPath = retirementClaimPath(rebuildLockPath);
  try {
    writeFileSync(
      claimPath,
      `${JSON.stringify({ token: claimToken, pid: process.pid, host: os.hostname() })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }

  try {
    afterClaim?.();
    if (!existsSync(rebuildLockPath)) return false;
    const currentStats = lstatSync(rebuildLockPath);
    const currentOwner = readLockOwner(rebuildLockPath);
    if (
      !sameDirectoryIdentity(snapshot.stats, currentStats) ||
      !sameOwner(snapshot.owner, currentOwner)
    ) {
      return false;
    }

    const quarantinePath = `${rebuildLockPath}.retired-${claimToken}`;
    renameSync(rebuildLockPath, quarantinePath);
    const quarantinedStats = lstatSync(quarantinePath);
    const quarantinedOwner = readLockOwner(quarantinePath);
    if (
      !sameDirectoryIdentity(snapshot.stats, quarantinedStats) ||
      !sameOwner(snapshot.owner, quarantinedOwner)
    ) {
      if (!existsSync(rebuildLockPath)) renameSync(quarantinePath, rebuildLockPath);
      throw new Error("Context lock generation changed during stale-lock quarantine.");
    }
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } finally {
    removeClaimIfOwned(rebuildLockPath, claimToken);
  }
}

export async function acquireRebuildLock(
  rebuildLockPath,
  {
    toPosix = String,
    timeoutMs = configuredTimeoutMs(),
    staleLockMs = configuredStaleMs(),
    pollMs = defaultPollMs,
  } = {},
) {
  mkdirSync(path.dirname(rebuildLockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    const token = randomUUID();
    let created = false;
    try {
      mkdirSync(rebuildLockPath, { mode: 0o700 });
      created = true;
      const createdAt = new Date().toISOString();
      const owner = {
        pid: process.pid,
        host: os.hostname(),
        token,
        createdAt,
        heartbeatAt: createdAt,
      };
      if (!atomicWriteOwner(rebuildLockPath, owner, { allowMissingOwner: true })) {
        throw new Error("Context lock ownership changed during acquisition.");
      }
      return { rebuildLockPath, owner, staleLockMs };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        const owner = readLockOwner(rebuildLockPath);
        if (created && (!owner || owner.token === token)) {
          rmSync(rebuildLockPath, { recursive: true, force: true });
        }
        throw error;
      }
      retireStaleLockIfNeeded(rebuildLockPath, staleLockMs);
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Timed out acquiring context index rebuild lock: ${toPosix(rebuildLockPath)}`,
        );
      }
      await delay(pollMs);
    }
  }
}

export function heartbeatRebuildLock(lease) {
  if (existsSync(retirementClaimPath(lease.rebuildLockPath))) return false;
  const current = readLockOwner(lease.rebuildLockPath);
  if (
    !current ||
    current.token !== lease.owner.token ||
    current.pid !== lease.owner.pid ||
    current.host !== lease.owner.host
  ) {
    return false;
  }
  const nextOwner = { ...lease.owner, heartbeatAt: new Date().toISOString() };
  if (!atomicWriteOwner(lease.rebuildLockPath, nextOwner)) return false;
  lease.owner = nextOwner;
  return true;
}

export function releaseRebuildLock(lease) {
  if (existsSync(retirementClaimPath(lease.rebuildLockPath))) return false;
  const current = readLockOwner(lease.rebuildLockPath);
  if (
    current?.token !== lease.owner.token ||
    current?.pid !== lease.owner.pid ||
    current?.host !== lease.owner.host
  ) {
    return false;
  }
  rmSync(lease.rebuildLockPath, { recursive: true, force: true });
  return true;
}

export async function withRebuildLock(
  { rebuildLockPath, toPosix = String, timeoutMs, staleLockMs, pollMs },
  action,
) {
  const lease = await acquireRebuildLock(rebuildLockPath, {
    toPosix,
    timeoutMs,
    staleLockMs,
    pollMs,
  });
  const heartbeat = setInterval(
    () => {
      try {
        heartbeatRebuildLock(lease);
      } catch {
        // The owning action will verify the token before release.
      }
    },
    Math.max(1000, Math.min(10_000, Math.floor(lease.staleLockMs / 2))),
  );
  heartbeat.unref?.();
  try {
    return await action(lease);
  } finally {
    clearInterval(heartbeat);
    releaseRebuildLock(lease);
  }
}
