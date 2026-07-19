import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import {
  claimAndRemove,
  readStableArtifactFile,
  safeArtifactStats,
  sameObjectIdentity,
  sameStableIdentity,
  validateDirectoryChain,
  validateRemovalTree,
} from "./context-maintenance-safety.mjs";

const databaseGenerationPattern = /^lancedb\.(next|previous)-([a-z0-9][a-z0-9-]{0,127})$/;
const manifestGenerationPattern = /^manifest\.(next|previous)-([a-z0-9][a-z0-9-]{0,127})\.json$/;
const removalClaimPattern = /^\.context-removal-(file|directory)-[a-f0-9-]{36}$/;
const immutableModelRevisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const modelHashTemporaryPattern = /^\.artifact-hash\.json\.\d+\.\d+\.tmp$/;
const maximumTopLevelArtifacts = 512;
const maximumModelInventoryEntries = 4_096;
const selectedIndexEntryTypes = new Map([
  [".codex-context-index.json", "file"],
  ["database-repair-required.json", "file"],
  ["database-transaction.json", "file"],
  ["lancedb", "directory"],
  ["manifest.json", "file"],
  ["model-cache", "directory"],
]);

function emptySummary() {
  return {
    removedDatabaseGenerations: 0,
    removedManifestGenerations: 0,
    removedModelGenerations: 0,
    removedModelTemporaryArtifacts: 0,
    removedLegacyModelArtifacts: 0,
    removedInterruptedClaims: 0,
    recoveredGenerationPairs: 0,
  };
}

function totalRemoved(summary) {
  return (
    summary.removedDatabaseGenerations +
    summary.removedManifestGenerations +
    summary.removedModelGenerations +
    summary.removedModelTemporaryArtifacts +
    summary.removedLegacyModelArtifacts +
    summary.removedInterruptedClaims
  );
}

export function maintenanceChanged(summary) {
  return totalRemoved(summary) > 0 || summary.recoveredGenerationPairs > 0;
}

export function mergeMaintenanceSummaries(...summaries) {
  const merged = emptySummary();
  for (const summary of summaries.filter(Boolean)) {
    for (const key of Object.keys(merged)) merged[key] += Number(summary[key] ?? 0);
  }
  return merged;
}

export function describeMaintenance(summary) {
  if (!maintenanceChanged(summary)) return "no maintenance changes";
  const actions = [];
  const removed = totalRemoved(summary);
  if (removed > 0) actions.push(`removed ${removed} validated stale artifact(s)`);
  if (summary.recoveredGenerationPairs > 0) {
    actions.push(`recovered ${summary.recoveredGenerationPairs} interrupted generation pair(s)`);
  }
  return actions.join(", ");
}

export function isContextMaintenanceEntryName(name) {
  return (
    databaseGenerationPattern.test(name) ||
    manifestGenerationPattern.test(name) ||
    removalClaimPattern.test(name)
  );
}

function generationArtifact(entry, indexDirectory) {
  const databaseMatch = entry.name.match(databaseGenerationPattern);
  if (databaseMatch) {
    return {
      generation: databaseMatch[1],
      suffix: databaseMatch[2],
      kind: "database",
      expectedType: "directory",
      path: path.join(indexDirectory, entry.name),
      name: entry.name,
    };
  }
  const manifestMatch = entry.name.match(manifestGenerationPattern);
  if (!manifestMatch) return null;
  return {
    generation: manifestMatch[1],
    suffix: manifestMatch[2],
    kind: "manifest",
    expectedType: "file",
    path: path.join(indexDirectory, entry.name),
    name: entry.name,
  };
}

function validatedGenerationArtifacts(indexDirectory) {
  const indexDevice = safeArtifactStats(indexDirectory, "directory", "index directory").dev;
  const entries = readdirSync(indexDirectory, { withFileTypes: true });
  if (entries.length > maximumTopLevelArtifacts) {
    throw new Error("Context maintenance refused an oversized index artifact inventory.");
  }
  const artifacts = [];
  for (const entry of entries) {
    const artifact = generationArtifact(entry, indexDirectory);
    if (!artifact) {
      const selectedType = selectedIndexEntryTypes.get(entry.name);
      const removalMatch = entry.name.match(removalClaimPattern);
      if (selectedType) {
        const stats = safeArtifactStats(
          path.join(indexDirectory, entry.name),
          selectedType,
          entry.name,
        );
        if (stats.dev !== indexDevice) {
          throw new Error("Context maintenance refused foreign-filesystem selected index state.");
        }
      } else if (removalMatch) {
        validateRemovalTree(
          path.join(indexDirectory, entry.name),
          removalMatch[1],
          "interrupted removal claim",
          indexDevice,
        );
      } else {
        throw new Error("Context maintenance refused an unknown index artifact.");
      }
      continue;
    }
    const stats = validateRemovalTree(
      artifact.path,
      artifact.expectedType,
      artifact.name,
      indexDevice,
    );
    artifacts.push({ ...artifact, modifiedAt: stats.mtimeMs, ownerDevice: indexDevice });
  }
  return artifacts;
}

function promotePreviousPair({ group, databasePath, manifestPath }) {
  const databaseStats = validateRemovalTree(
    group.database.path,
    "directory",
    group.database.name,
    group.database.ownerDevice,
  );
  const manifestStats = validateRemovalTree(
    group.manifest.path,
    "file",
    group.manifest.name,
    group.manifest.ownerDevice,
  );
  renameSync(group.database.path, databasePath);
  try {
    if (
      !sameObjectIdentity(databaseStats, safeArtifactStats(databasePath, "directory", "database"))
    ) {
      throw new Error("Context maintenance detected an identity change during database recovery.");
    }
    renameSync(group.manifest.path, manifestPath);
    if (!sameObjectIdentity(manifestStats, safeArtifactStats(manifestPath, "file", "manifest"))) {
      throw new Error("Context maintenance detected an identity change during manifest recovery.");
    }
  } catch (error) {
    if (existsSync(manifestPath) && !existsSync(group.manifest.path)) {
      renameSync(manifestPath, group.manifest.path);
    }
    if (existsSync(databasePath) && !existsSync(group.database.path)) {
      renameSync(databasePath, group.database.path);
    }
    throw error;
  }
}

function promotePreviousDatabase({ artifact, databasePath }) {
  const databaseStats = validateRemovalTree(
    artifact.path,
    "directory",
    artifact.name,
    artifact.ownerDevice,
  );
  renameSync(artifact.path, databasePath);
  try {
    if (
      !sameObjectIdentity(databaseStats, safeArtifactStats(databasePath, "directory", "database"))
    ) {
      throw new Error("Context maintenance detected an identity change during database recovery.");
    }
  } catch (error) {
    if (existsSync(databasePath) && !existsSync(artifact.path)) {
      renameSync(databasePath, artifact.path);
    }
    throw error;
  }
}

function moveCanonicalAside({ artifactPath, expectedType, label, indexDirectory, ownerDevice }) {
  const initialStats = validateRemovalTree(artifactPath, expectedType, label, ownerDevice);
  const suffix = randomUUID();
  const displacedPath = path.join(
    indexDirectory,
    expectedType === "directory" ? `lancedb.next-${suffix}` : `manifest.next-${suffix}.json`,
  );
  const beforeMove = validateRemovalTree(artifactPath, expectedType, label, ownerDevice);
  if (!sameStableIdentity(initialStats, beforeMove)) {
    throw new Error(`Context maintenance detected an identity change while preserving ${label}.`);
  }
  renameSync(artifactPath, displacedPath);
  try {
    if (!sameObjectIdentity(beforeMove, safeArtifactStats(displacedPath, expectedType, label))) {
      throw new Error(`Context maintenance detected an identity change while preserving ${label}.`);
    }
    validateRemovalTree(displacedPath, expectedType, label, ownerDevice);
    return displacedPath;
  } catch (error) {
    if (existsSync(displacedPath) && !existsSync(artifactPath)) {
      renameSync(displacedPath, artifactPath);
    }
    throw error;
  }
}

function recoverInterruptedFullPublication({
  artifacts,
  databasePath,
  manifestPath,
  summary,
  testHooks,
}) {
  const databaseExists = existsSync(databasePath);
  const manifestExists = existsSync(manifestPath);
  if (databaseExists && manifestExists) return;

  const groups = new Map();
  for (const artifact of artifacts) {
    const group = groups.get(artifact.suffix) ?? {
      next: {},
      previous: {},
      modifiedAt: 0,
    };
    group[artifact.generation][artifact.kind] = artifact;
    group.modifiedAt = Math.max(group.modifiedAt, artifact.modifiedAt);
    groups.set(artifact.suffix, group);
  }
  const recoverableGroups = [...groups.values()].filter(
    (group) => group.previous.database && group.previous.manifest,
  );
  const previousGroups = [...groups.values()].filter(
    (group) => group.previous.database || group.previous.manifest,
  );
  if (recoverableGroups.length > 1 || previousGroups.length > 1) {
    throw new Error("Context maintenance refused ambiguous previous generation pairs.");
  }
  const recoverable = recoverableGroups[0];
  if (!recoverable && !databaseExists && manifestExists) {
    const databaseOnlyGroups = [...groups.values()].filter(
      (group) =>
        group.previous.database &&
        !group.previous.manifest &&
        group.next.database &&
        group.next.manifest,
    );
    if (databaseOnlyGroups.length > 1) {
      throw new Error("Context maintenance refused ambiguous previous database generations.");
    }
    const databaseOnly = databaseOnlyGroups[0];
    if (databaseOnly) {
      promotePreviousDatabase({
        artifact: databaseOnly.previous.database,
        databasePath,
      });
      summary.recoveredGenerationPairs += 1;
      return;
    }
  }
  if (!recoverable) {
    if (artifacts.some((artifact) => artifact.generation === "previous")) {
      throw new Error("Context maintenance refused an incomplete previous generation.");
    }
    return;
  }

  const displaced = [];
  const ownerDevice = recoverable.previous.database.ownerDevice;
  try {
    if (databaseExists) {
      displaced.push({
        originalPath: databasePath,
        path: moveCanonicalAside({
          artifactPath: databasePath,
          expectedType: "directory",
          label: "unpublished database",
          indexDirectory: path.dirname(databasePath),
          ownerDevice,
        }),
        expectedType: "directory",
        label: "unpublished database",
        ownerDevice,
      });
    }
    if (manifestExists) {
      displaced.push({
        originalPath: manifestPath,
        path: moveCanonicalAside({
          artifactPath: manifestPath,
          expectedType: "file",
          label: "unpaired manifest",
          indexDirectory: path.dirname(manifestPath),
          ownerDevice,
        }),
        expectedType: "file",
        label: "unpaired manifest",
        ownerDevice,
      });
    }
    promotePreviousPair({
      group: {
        database: recoverable.previous.database,
        manifest: recoverable.previous.manifest,
      },
      databasePath,
      manifestPath,
    });
  } catch (error) {
    for (const artifact of displaced.reverse()) {
      if (existsSync(artifact.path) && !existsSync(artifact.originalPath)) {
        renameSync(artifact.path, artifact.originalPath);
      }
    }
    throw error;
  }
  for (const artifact of displaced) {
    claimAndRemove({
      artifactPath: artifact.path,
      expectedType: artifact.expectedType,
      label: artifact.label,
      ownerDevice: artifact.ownerDevice,
      testHooks,
    });
    if (artifact.expectedType === "directory") summary.removedDatabaseGenerations += 1;
    else summary.removedManifestGenerations += 1;
  }
  summary.recoveredGenerationPairs += 1;
}

function removeInterruptedClaims(indexDirectory, summary, testHooks) {
  const ownerDevice = safeArtifactStats(indexDirectory, "directory", "index directory").dev;
  for (const entry of readdirSync(indexDirectory, { withFileTypes: true })) {
    const match = entry.name.match(removalClaimPattern);
    if (!match) continue;
    claimAndRemove({
      artifactPath: path.join(indexDirectory, entry.name),
      expectedType: match[1],
      label: "interrupted removal claim",
      ownerDevice,
      testHooks,
    });
    summary.removedInterruptedClaims += 1;
  }
}

function modelMaintenanceInventory({ modelCachePath, selectedModelRevisionDirectory }) {
  if (
    !selectedModelRevisionDirectory ||
    !existsSync(modelCachePath) ||
    !existsSync(selectedModelRevisionDirectory)
  ) {
    return null;
  }
  validateDirectoryChain(modelCachePath, selectedModelRevisionDirectory, "selected model revision");
  const modelCacheDevice = safeArtifactStats(
    modelCachePath,
    "directory",
    "model-cache directory",
  ).dev;
  const revisions = [];
  const claims = [];
  const selectedTemporaryFiles = [];
  const pending = [{ directory: modelCachePath, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current.directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maximumModelInventoryEntries) {
        throw new Error("Context maintenance refused an oversized model-cache inventory.");
      }
      const entryPath = path.join(current.directory, entry.name);
      if (current.depth < 2) {
        const stats = safeArtifactStats(entryPath, "directory", "model-cache directory");
        if (stats.dev !== modelCacheDevice) {
          throw new Error("Context maintenance refused foreign-filesystem model-cache state.");
        }
        pending.push({ directory: entryPath, depth: current.depth + 1 });
        continue;
      }
      const removalMatch = entry.name.match(removalClaimPattern);
      if (removalMatch) {
        validateRemovalTree(
          entryPath,
          removalMatch[1],
          "interrupted model-cache removal claim",
          modelCacheDevice,
        );
        claims.push({ expectedType: removalMatch[1], path: entryPath });
      } else if (immutableModelRevisionPattern.test(entry.name)) {
        validateRemovalTree(entryPath, "directory", "model revision", modelCacheDevice);
        revisions.push(entryPath);
      } else if (entry.name === "config.json") {
        const config = readStableArtifactFile(entryPath, "legacy model config");
        if (config.stats.dev !== modelCacheDevice) {
          throw new Error("Context maintenance refused foreign-filesystem model config.");
        }
      } else {
        throw new Error("Context maintenance refused unknown model-cache state.");
      }
    }
  }
  for (const entry of readdirSync(selectedModelRevisionDirectory, { withFileTypes: true })) {
    const entryPath = path.join(selectedModelRevisionDirectory, entry.name);
    const removalMatch = entry.name.match(removalClaimPattern);
    if (removalMatch) {
      validateRemovalTree(
        entryPath,
        removalMatch[1],
        "interrupted model-cache removal claim",
        modelCacheDevice,
      );
      claims.push({ expectedType: removalMatch[1], path: entryPath });
    } else if (modelHashTemporaryPattern.test(entry.name)) {
      validateRemovalTree(entryPath, "file", "model hash temporary file", modelCacheDevice);
      selectedTemporaryFiles.push(entryPath);
    }
  }
  const modelParent = path.dirname(selectedModelRevisionDirectory);
  const legacyConfigPath = path.join(modelParent, "config.json");
  const selectedConfigPath = path.join(selectedModelRevisionDirectory, "config.json");
  let legacyConfig;
  let selectedConfig;
  if (existsSync(legacyConfigPath)) {
    legacyConfig = readStableArtifactFile(legacyConfigPath, "legacy model config");
    if (legacyConfig.stats.dev !== modelCacheDevice) {
      throw new Error("Context maintenance refused foreign-filesystem model config.");
    }
  }
  if (existsSync(selectedConfigPath)) {
    selectedConfig = readStableArtifactFile(selectedConfigPath, "selected model config");
    if (selectedConfig.stats.dev !== modelCacheDevice) {
      throw new Error("Context maintenance refused foreign-filesystem model config.");
    }
  }
  return {
    claims,
    legacyConfigPath,
    legacyConfigRemovable: Boolean(
      legacyConfig && selectedConfig && legacyConfig.buffer.equals(selectedConfig.buffer),
    ),
    modelCacheDevice,
    revisions,
    selectedConfigPath,
    selectedTemporaryFiles,
  };
}

function removeUnselectedModelRevisions({
  modelCachePath,
  selectedModelRevisionDirectory,
  summary,
  testHooks,
}) {
  const inventory = modelMaintenanceInventory({ modelCachePath, selectedModelRevisionDirectory });
  if (!inventory) return;
  for (const claim of inventory.claims) {
    claimAndRemove({
      artifactPath: claim.path,
      expectedType: claim.expectedType,
      label: "interrupted model-cache removal claim",
      ownerDevice: inventory.modelCacheDevice,
      testHooks,
    });
    summary.removedInterruptedClaims += 1;
  }
  for (const revisionPath of inventory.revisions) {
    if (revisionPath === selectedModelRevisionDirectory) continue;
    claimAndRemove({
      artifactPath: revisionPath,
      expectedType: "directory",
      label: "unselected model revision",
      ownerDevice: inventory.modelCacheDevice,
      testHooks,
    });
    summary.removedModelGenerations += 1;
  }
  for (const temporaryPath of inventory.selectedTemporaryFiles) {
    claimAndRemove({
      artifactPath: temporaryPath,
      expectedType: "file",
      label: "model hash temporary file",
      ownerDevice: inventory.modelCacheDevice,
      testHooks,
    });
    summary.removedModelTemporaryArtifacts += 1;
  }
  if (existsSync(inventory.legacyConfigPath) && existsSync(inventory.selectedConfigPath)) {
    const legacy = readStableArtifactFile(inventory.legacyConfigPath, "legacy model config");
    const selected = readStableArtifactFile(inventory.selectedConfigPath, "selected model config");
    const identical = legacy.buffer.equals(selected.buffer);
    if (
      !sameStableIdentity(legacy.stats, lstatSync(inventory.legacyConfigPath)) ||
      !sameStableIdentity(selected.stats, lstatSync(inventory.selectedConfigPath))
    ) {
      throw new Error("Context maintenance detected a model config identity change.");
    }
    if (identical) {
      claimAndRemove({
        artifactPath: inventory.legacyConfigPath,
        expectedType: "file",
        label: "validated legacy model config",
        ownerDevice: inventory.modelCacheDevice,
        testHooks,
      });
      summary.removedLegacyModelArtifacts += 1;
    }
  }
}

export function validateContextMaintenanceState({
  indexDirectory,
  modelCachePath = path.join(indexDirectory, "model-cache"),
  selectedModelRevisionDirectory,
}) {
  if (!existsSync(indexDirectory)) return { pending: false };
  safeArtifactStats(indexDirectory, "directory", "index directory");
  const artifacts = validatedGenerationArtifacts(indexDirectory);
  const modelInventory = modelMaintenanceInventory({
    modelCachePath,
    selectedModelRevisionDirectory,
  });
  const topLevelNames = readdirSync(indexDirectory);
  return {
    pending:
      artifacts.length > 0 ||
      topLevelNames.includes("database-transaction.json") ||
      topLevelNames.some((name) => removalClaimPattern.test(name)) ||
      Boolean(
        modelInventory &&
        (modelInventory.claims.length > 0 ||
          modelInventory.legacyConfigRemovable ||
          modelInventory.selectedTemporaryFiles.length > 0 ||
          modelInventory.revisions.some(
            (revisionPath) => revisionPath !== selectedModelRevisionDirectory,
          )),
      ),
  };
}

export function maintainContextIndex({
  indexDirectory,
  databasePath = path.join(indexDirectory, "lancedb"),
  manifestPath = path.join(indexDirectory, "manifest.json"),
  modelCachePath = path.join(indexDirectory, "model-cache"),
  selectedModelRevisionDirectory,
  testHooks,
}) {
  const summary = emptySummary();
  if (!existsSync(indexDirectory)) return summary;
  validateContextMaintenanceState({
    indexDirectory,
    modelCachePath,
    selectedModelRevisionDirectory,
  });
  removeInterruptedClaims(indexDirectory, summary, testHooks);
  let artifacts = validatedGenerationArtifacts(indexDirectory);
  recoverInterruptedFullPublication({
    artifacts,
    databasePath,
    manifestPath,
    summary,
    testHooks,
  });
  artifacts = validatedGenerationArtifacts(indexDirectory);
  for (const artifact of artifacts) {
    claimAndRemove({
      artifactPath: artifact.path,
      expectedType: artifact.expectedType,
      label: artifact.name,
      ownerDevice: artifact.ownerDevice,
      testHooks,
    });
    if (artifact.kind === "database") summary.removedDatabaseGenerations += 1;
    else summary.removedManifestGenerations += 1;
  }
  removeUnselectedModelRevisions({
    modelCachePath,
    selectedModelRevisionDirectory,
    summary,
    testHooks,
  });
  return summary;
}
