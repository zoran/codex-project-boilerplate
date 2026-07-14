import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sensitivePathReason } from "../repository/sensitive-paths.mjs";
import { parsePrePushInput, root, validatePushedRefsAgainstHead } from "./adaptive-state.mjs";
import { createSecretContentScanner } from "./secret-content-scan.mjs";

const zeroObjectPattern = /^0+$/;
const rawChangeHeaderPattern = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/i;

function git(repositoryRoot, args, { allowFailure = false, encoding = "utf8", input } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding,
    input: input ?? (encoding === null ? Buffer.alloc(0) : ""),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(output || `git ${args.join(" ")} failed while inspecting pushed objects`);
  }
  return result.stdout;
}

function resolveCommit(repositoryRoot, objectId, { allowFailure = false } = {}) {
  const output = git(repositoryRoot, ["rev-parse", "--verify", `${objectId}^{commit}`], {
    allowFailure,
  });
  return output === null ? null : output.trim().toLowerCase();
}

function objectType(repositoryRoot, objectId, cache = new Map()) {
  if (!cache.has(objectId)) {
    cache.set(objectId, git(repositoryRoot, ["cat-file", "-t", objectId]).trim().toLowerCase());
  }
  return cache.get(objectId);
}

function immediateTagTarget(repositoryRoot, tagObject, typeCache) {
  const content = git(repositoryRoot, ["cat-file", "tag", tagObject]);
  const header = content.split(/\r?\n\r?\n/, 1)[0];
  const objectMatch = /^object ([0-9a-f]+)$/im.exec(header);
  const typeMatch = /^type ([a-z]+)$/im.exec(header);
  if (!objectMatch || !typeMatch) {
    throw new Error(`Pushed tag ${tagObject} has an invalid object header.`);
  }
  const targetObject = objectMatch[1].toLowerCase();
  const declaredType = typeMatch[1].toLowerCase();
  const actualType = objectType(repositoryRoot, targetObject, typeCache);
  if (actualType !== declaredType) {
    throw new Error(`Pushed tag ${tagObject} declares ${declaredType} but targets ${actualType}.`);
  }
  return { objectId: targetObject, objectType: actualType };
}

function collectPushedTagChain(repositoryRoot, entry, pushedRefObjects, tagTargetCache, typeCache) {
  let objectId = entry.localObject.toLowerCase();
  const visited = new Set();
  while (true) {
    if (visited.has(objectId)) {
      throw new Error(`Pushed ref ${entry.localRef} contains a cyclic annotated-tag chain.`);
    }
    visited.add(objectId);
    const currentType = objectType(repositoryRoot, objectId, typeCache);
    if (currentType === "commit") return;
    if (currentType !== "tag") {
      throw new Error(
        `Pushed ref ${entry.localRef} resolves to ${currentType}, not a commit; refusing an incomplete history scan.`,
      );
    }
    pushedRefObjects.set(objectId, currentType);
    let target = tagTargetCache.get(objectId);
    if (!target) {
      target = immediateTagTarget(repositoryRoot, objectId, typeCache);
      tagTargetCache.set(objectId, target);
    }
    objectId = target.objectId;
  }
}

function splitNullBuffer(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start < buffer.length) fields.push(buffer.subarray(start).toString("utf8"));
  return fields;
}

export function parseRawCommitChanges(buffer, commitObject) {
  const fields = splitNullBuffer(buffer);
  const changes = [];

  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header) continue;
    const match = rawChangeHeaderPattern.exec(header);
    if (!match) {
      throw new Error(`Git emitted an unsupported raw change record for ${commitObject}.`);
    }
    const [, , newMode, , newObject, status] = match;
    const firstPath = fields[index++];
    if (firstPath === undefined) {
      throw new Error(`Git emitted an incomplete raw change record for ${commitObject}.`);
    }
    const relativePath = status === "R" || status === "C" ? fields[index++] : firstPath;
    if (relativePath === undefined) {
      throw new Error(`Git emitted an incomplete rename/copy record for ${commitObject}.`);
    }
    if (status === "D" || zeroObjectPattern.test(newObject)) continue;
    changes.push({
      commitObject,
      mode: newMode,
      objectId: newObject.toLowerCase(),
      relativePath,
      status,
    });
  }

  return changes;
}

function newCommitsForEntries(repositoryRoot, entries, resolveCached) {
  if (entries.length === 0) return [];
  const localCommits = new Set();
  const remoteCommits = new Set();
  for (const entry of entries) {
    localCommits.add(resolveCached(entry.localObject));
    if (zeroObjectPattern.test(entry.remoteObject)) continue;
    const remoteCommit = resolveCached(entry.remoteObject, true);
    if (!remoteCommit) {
      throw new Error(
        `Remote object for ${entry.remoteRef} is unavailable locally; pushed history cannot be verified safely.`,
      );
    }
    remoteCommits.add(remoteCommit);
  }
  const args = ["rev-list", "--topo-order", ...localCommits];
  if (remoteCommits.size > 0) args.push("--not", ...remoteCommits);
  const output = git(repositoryRoot, args);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

export function parseRawCommitChangeBatch(buffer, expectedCommits) {
  const commitSet = new Set(expectedCommits);
  const fields = splitNullBuffer(buffer);
  const changes = [];
  let currentCommit = null;
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    if (commitSet.has(field.toLowerCase())) {
      currentCommit = field.toLowerCase();
      continue;
    }
    if (!currentCommit) throw new Error("Git emitted a raw change before its commit marker.");
    const match = rawChangeHeaderPattern.exec(field);
    if (!match) {
      throw new Error(`Git emitted an unsupported raw change record for ${currentCommit}.`);
    }
    const [, , newMode, , newObject, status] = match;
    const firstPath = fields[index++];
    if (firstPath === undefined) {
      throw new Error(`Git emitted an incomplete raw change record for ${currentCommit}.`);
    }
    const relativePath = status === "R" || status === "C" ? fields[index++] : firstPath;
    if (relativePath === undefined) {
      throw new Error(`Git emitted an incomplete rename/copy record for ${currentCommit}.`);
    }
    if (status === "D" || zeroObjectPattern.test(newObject)) continue;
    changes.push({
      commitObject: currentCommit,
      mode: newMode,
      objectId: newObject.toLowerCase(),
      relativePath,
      status,
    });
  }
  return changes;
}

function batchedCommitChanges(repositoryRoot, commits) {
  if (commits.length === 0) return [];
  const output = git(
    repositoryRoot,
    ["diff-tree", "--stdin", "--root", "-m", "--raw", "-r", "-z", "--full-index"],
    { encoding: null, input: Buffer.from(`${commits.join("\n")}\n`) },
  );
  return parseRawCommitChangeBatch(output, commits);
}

async function scanGitObjects(repositoryRoot, objects) {
  if (objects.length === 0) return new Map();
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= 64 * 1024) return;
    const captured = chunk.subarray(0, 64 * 1024 - stderrBytes);
    stderr.push(captured);
    stderrBytes += captured.length;
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  child.stdin.end(`${objects.map((entry) => entry.objectId).join("\n")}\n`);

  const results = new Map();
  let objectIndex = 0;
  let header = Buffer.alloc(0);
  let scanner = null;
  let remaining = 0;
  let expectSeparator = false;

  for await (const chunk of child.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!scanner) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          header = Buffer.concat([header, chunk.subarray(offset)]);
          break;
        }
        header = Buffer.concat([header, chunk.subarray(offset, newline)]);
        offset = newline + 1;
        const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(header.toString("ascii"));
        const expected = objects[objectIndex];
        if (!match || !expected) throw new Error("Git cat-file emitted an invalid batch header.");
        const [, objectId, actualType, sizeText] = match;
        if (
          objectId.toLowerCase() !== expected.objectId ||
          actualType.toLowerCase() !== expected.objectType
        ) {
          throw new Error(`Git cat-file returned an unexpected object for ${expected.objectId}.`);
        }
        remaining = Number.parseInt(sizeText, 10);
        if (!Number.isSafeInteger(remaining) || remaining < 0) {
          throw new Error(`Git cat-file returned an invalid object size for ${expected.objectId}.`);
        }
        header = Buffer.alloc(0);
        scanner = createSecretContentScanner();
        expectSeparator = remaining === 0;
      }

      if (!expectSeparator) {
        const bytes = Math.min(remaining, chunk.length - offset);
        if (bytes > 0) scanner.write(chunk.subarray(offset, offset + bytes));
        offset += bytes;
        remaining -= bytes;
        if (remaining === 0) expectSeparator = true;
      }

      if (expectSeparator && offset < chunk.length) {
        if (chunk[offset] !== 0x0a) throw new Error("Git cat-file batch separator is invalid.");
        const expected = objects[objectIndex++];
        results.set(expected.objectId, scanner.findings());
        offset += 1;
        scanner = null;
        expectSeparator = false;
      }
    }
  }

  const status = await closed;
  if (status !== 0) {
    throw new Error(
      Buffer.concat(stderr).toString("utf8").trim() || "Unable to read pushed Git objects.",
    );
  }
  if (objectIndex !== objects.length || scanner || header.length > 0) {
    throw new Error("Git cat-file batch ended before every pushed object was read.");
  }
  return results;
}

export async function inspectPushedObjects(input, { repositoryRoot = root } = {}) {
  const entries = parsePrePushInput(input);
  if (entries.length === 0) {
    return { blobCount: 0, commitCount: 0, findings: [], refCount: 0 };
  }

  const resolvedCommits = new Map();
  const resolveCached = (objectId, allowFailure = false) => {
    const key = objectId.toLowerCase();
    if (!resolvedCommits.has(key)) {
      resolvedCommits.set(key, resolveCommit(repositoryRoot, objectId, { allowFailure }));
    }
    return resolvedCommits.get(key);
  };
  const headObject = resolveCached("HEAD");
  validatePushedRefsAgainstHead(entries, {
    headObject,
    resolveCommit: (objectId) => resolveCached(objectId, true),
  });

  const pushedEntries = entries.filter((entry) => !zeroObjectPattern.test(entry.localObject));
  const commits = new Set();
  const pushedRefObjects = new Map();
  const tagTargetCache = new Map();
  const typeCache = new Map();
  for (const entry of pushedEntries) {
    collectPushedTagChain(repositoryRoot, entry, pushedRefObjects, tagTargetCache, typeCache);
  }
  for (const commitObject of newCommitsForEntries(repositoryRoot, pushedEntries, resolveCached)) {
    commits.add(commitObject);
  }

  const findings = [];
  const blobs = new Map();
  for (const change of batchedCommitChanges(repositoryRoot, [...commits])) {
    const pathReason = sensitivePathReason(change.relativePath);
    if (pathReason) {
      findings.push(
        `${JSON.stringify(change.relativePath)} at ${change.commitObject.slice(0, 12)}: ${pathReason}`,
      );
    }
    if (change.mode === "160000") continue;
    if (!blobs.has(change.objectId)) blobs.set(change.objectId, change);
  }

  const objectsToScan = [
    ...[...blobs].map(([objectId]) => ({ objectId, objectType: "blob" })),
    ...[...commits].map((objectId) => ({ objectId, objectType: "commit" })),
    ...[...pushedRefObjects].map(([objectId, objectType]) => ({ objectId, objectType })),
  ];
  const objectFindings = await scanGitObjects(repositoryRoot, objectsToScan);
  for (const [objectId, source] of blobs) {
    const labels = objectFindings.get(objectId) ?? [];
    for (const label of labels) {
      findings.push(
        `${JSON.stringify(source.relativePath)} at ${source.commitObject.slice(0, 12)} (blob ${objectId.slice(0, 12)}): ${label}`,
      );
    }
  }
  for (const commitObject of commits) {
    const labels = objectFindings.get(commitObject) ?? [];
    for (const label of labels) {
      findings.push(`${commitObject.slice(0, 12)} commit metadata: ${label}`);
    }
  }
  for (const [objectId, objectType] of pushedRefObjects) {
    const labels = objectFindings.get(objectId) ?? [];
    for (const label of labels) {
      findings.push(`${objectId.slice(0, 12)} pushed ${objectType} metadata: ${label}`);
    }
  }

  return {
    blobCount: blobs.size,
    commitCount: commits.size,
    findings: [...new Set(findings)].sort((left, right) => left.localeCompare(right)),
    refCount: pushedEntries.length,
  };
}

function validateArgs(argv) {
  const unknown = argv.filter((arg) => arg !== "--");
  if (unknown.length > 0) throw new Error(`Unknown pushed-object scan option: ${unknown[0]}`);
}

async function main() {
  const input = process.stdin.isTTY
    ? ""
    : await new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
      });
  validateArgs(process.argv.slice(2));
  const result = await inspectPushedObjects(input);
  if (result.findings.length > 0) {
    console.error("Pushed Git object verification failed:");
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  if (result.refCount === 0) {
    console.log("Pushed Git object verification skipped; direct invocation supplied no ref range.");
  } else {
    console.log(
      `Pushed Git object verification passed (${result.refCount} ref(s), ${result.commitCount} commit(s), ${result.blobCount} changed blob(s)).`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`Pushed Git object verification failed: ${error.message}`);
    process.exit(1);
  }
}
