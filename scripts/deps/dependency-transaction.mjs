import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  contentHash,
  copyLocalInput,
  DependencyTransactionError,
  discoverLocalInputs,
  inputRecord,
  normalizeRelativePath,
  projectIdentity,
  readOptionalFile,
  safeRepositoryPath,
  verifyInputRecords,
} from "./dependency-inputs.mjs";
import {
  atomicWrite,
  dependencyTransactionPaths,
  readJsonFile,
  withDependencyTransactionLock,
} from "./dependency-transaction-state.mjs";

export { contentHash, DependencyTransactionError } from "./dependency-inputs.mjs";
export {
  acquireDependencyTransactionLock,
  dependencyTransactionPaths,
  releaseDependencyTransactionLock,
  withDependencyTransactionLock,
} from "./dependency-transaction-state.mjs";

const schemaVersion = 2;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function planHash(payload) {
  return contentHash(stableJson(payload));
}

function manifestPath(value) {
  const normalized = normalizeRelativePath(value);
  if (path.posix.basename(normalized) !== "package.json") {
    throw new DependencyTransactionError(`Dependency manifest must end in package.json: ${value}`);
  }
  return normalized;
}

function outputPath(value) {
  const normalized = normalizeRelativePath(value);
  if (normalized !== "pnpm-lock.yaml" && path.posix.basename(normalized) !== "package.json") {
    throw new DependencyTransactionError(`Unsupported dependency transaction output: ${value}`);
  }
  return normalized;
}

export function normalizeDependencyRequest(request) {
  return {
    level: String(request.level ?? "patch"),
    select: [...new Set((request.select ?? []).map(String))].sort(),
    allowMajor: Boolean(request.allowMajor),
    includePinned: Boolean(request.includePinned),
  };
}

export function updatedDependencySpec(oldSpec, targetVersion) {
  const spec = String(oldSpec).trim();
  if (/^(?:workspace|file|link|portal|catalog):/.test(spec)) return null;
  const alias = /^(npm:(?:@[^/]+\/[^@]+|[^@]+)@)([\^~]?)(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(spec);
  if (alias) return `${alias[1]}${alias[2]}${targetVersion}`;
  if (/^\^/.test(spec)) return `^${targetVersion}`;
  if (/^~/.test(spec)) return `~${targetVersion}`;
  if (/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(spec)) return targetVersion;
  return null;
}

function defaultLockfilePlanner({ projectRoot, manifestPaths, manifestOutputs, localInputs }) {
  for (const pnpmHook of [".pnpmfile.cjs", ".pnpmfile.mjs", "pnpmfile.cjs", "pnpmfile.mjs"]) {
    if (readOptionalFile(projectRoot, pnpmHook).exists) {
      throw new DependencyTransactionError(
        `${pnpmHook} is executable dependency-resolution code; use a reviewed project-specific lockfile workflow.`,
      );
    }
  }
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "codex-dependency-plan-"));
  chmodSync(temporaryRoot, 0o700);
  try {
    const outputByPath = new Map(manifestOutputs.map((output) => [output.path, output.content]));
    const sourcePaths = [...manifestPaths, ".npmrc", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
    for (const record of localInputs) copyLocalInput(projectRoot, temporaryRoot, record);
    for (const relativePath of [...new Set(sourcePaths)]) {
      const source = readOptionalFile(projectRoot, relativePath);
      if (!source.exists && !outputByPath.has(relativePath)) continue;
      const target = path.join(temporaryRoot, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, outputByPath.get(relativePath) ?? source.content, "utf8");
    }
    for (const output of manifestOutputs) {
      const target = path.join(temporaryRoot, output.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, output.content, "utf8");
    }
    const result = spawnSync(
      "pnpm",
      ["install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"],
      {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: { ...process.env, CI: "true" },
        input: "",
        stdio: "pipe",
        timeout: 180_000,
      },
    );
    if (result.error) {
      throw new DependencyTransactionError(
        `Planned lockfile generation failed to start: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const detail = String(result.stderr ?? result.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .at(-1);
      throw new DependencyTransactionError(
        `Planned lockfile generation failed with status ${result.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    const lockfilePath = path.join(temporaryRoot, "pnpm-lock.yaml");
    if (!existsSync(lockfilePath)) {
      throw new DependencyTransactionError(
        "Planned lockfile generation produced no pnpm-lock.yaml.",
      );
    }
    return readFileSync(lockfilePath, "utf8");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function createDependencyPlan(options) {
  const projectRoot = projectIdentity(options.projectRoot).root;
  const request = normalizeDependencyRequest(options.request);
  const manifestPaths = [...new Set(options.manifestPaths.map(manifestPath))].sort();
  const inputPaths = [
    ...manifestPaths,
    ".npmrc",
    ".pnpmfile.cjs",
    ".pnpmfile.mjs",
    "dependency-policy.json",
    "pnpm-lock.yaml",
    "pnpmfile.cjs",
    "pnpmfile.mjs",
    "pnpm-workspace.yaml",
  ];
  const policySource = readOptionalFile(projectRoot, "dependency-policy.json");
  let pins = [];
  if (policySource.exists) {
    try {
      const policy = JSON.parse(policySource.content);
      if (!Array.isArray(policy.pins)) throw new Error("pins must be an array");
      pins = policy.pins;
    } catch {
      throw new DependencyTransactionError(
        "dependency-policy.json changed to an invalid policy before the preview was frozen.",
      );
    }
  }
  const manifests = new Map();
  for (const relativePath of manifestPaths) {
    const source = readOptionalFile(projectRoot, relativePath);
    if (!source.exists) {
      throw new DependencyTransactionError(`Dependency manifest disappeared: ${relativePath}`);
    }
    let data;
    try {
      data = JSON.parse(source.content);
    } catch {
      throw new DependencyTransactionError(
        `Dependency manifest contains invalid JSON: ${relativePath}`,
      );
    }
    manifests.set(relativePath, { data, content: source.content });
  }

  const changed = new Map();
  const updateKeys = new Set();
  const skipped = [];
  const reviewedUpdates = [];
  for (const update of options.updates) {
    if (
      !["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].includes(
        update.section,
      )
    ) {
      throw new DependencyTransactionError(`Unsupported dependency section: ${update.section}`);
    }
    const relativePath = manifestPath(update.manifestPath);
    const canonicalKey = `${relativePath}:${update.section}:${update.name}`;
    if (String(update.key) !== canonicalKey) {
      throw new DependencyTransactionError(
        `Dependency update key does not match its manifest identity: ${canonicalKey}`,
      );
    }
    if (updateKeys.has(canonicalKey)) {
      throw new DependencyTransactionError(`Dependency update is duplicated: ${canonicalKey}`);
    }
    updateKeys.add(canonicalKey);
    const nowPinned = pins.some(
      (pin) =>
        pin?.name === update.name &&
        (!pin.manifest || pin.manifest === relativePath) &&
        (!pin.section || pin.section === update.section),
    );
    if (nowPinned && !request.includePinned) {
      throw new DependencyTransactionError(
        `Dependency became pinned before the preview was frozen: ${update.key}`,
      );
    }
    const source = manifests.get(relativePath);
    const oldSpec = source?.data?.[update.section]?.[update.name];
    if (oldSpec === undefined) {
      throw new DependencyTransactionError(`Dependency target disappeared: ${update.key}`);
    }
    if (String(oldSpec) !== String(update.currentSpec)) {
      throw new DependencyTransactionError(`Dependency source spec changed: ${update.key}`);
    }
    const nextSpec = updatedDependencySpec(oldSpec, update.target);
    if (!nextSpec) {
      skipped.push(`${update.key}: unsupported spec ${oldSpec}`);
      continue;
    }
    const nextData = changed.get(relativePath) ?? structuredClone(source.data);
    nextData[update.section][update.name] = nextSpec;
    changed.set(relativePath, nextData);
    reviewedUpdates.push({
      key: String(update.key),
      manifestPath: relativePath,
      section: String(update.section),
      name: String(update.name),
      current: String(update.current),
      currentSpec: String(update.currentSpec),
      target: String(update.target),
      nextSpec,
      delta: String(update.delta),
    });
  }

  const manifestOutputs = [...changed.entries()]
    .map(([relativePath, data]) => {
      const content = `${JSON.stringify(data, null, 2)}\n`;
      return { path: relativePath, hash: contentHash(content), content };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (manifestOutputs.length === 0) {
    throw new DependencyTransactionError("No supported dependency manifest updates were planned.");
  }

  const localInputs = discoverLocalInputs(projectRoot, manifests);
  const inputsByPath = new Map(
    [...new Set(inputPaths)]
      .sort()
      .map((relativePath) => [relativePath, inputRecord(projectRoot, relativePath)]),
  );
  for (const record of localInputs) inputsByPath.set(record.path, record);
  const inputs = [...inputsByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const planLockfile = options.lockfilePlanner ?? defaultLockfilePlanner;
  const lockfileContent = planLockfile({
    projectRoot,
    manifestPaths,
    manifestOutputs,
    localInputs,
  });
  verifyInputRecords(projectRoot, inputs);
  const payload = {
    version: schemaVersion,
    createdAt: (options.now ?? new Date()).toISOString(),
    request,
    updates: reviewedUpdates.sort((left, right) => left.key.localeCompare(right.key)),
    skipped: skipped.sort(),
    inputs,
    outputs: {
      manifests: manifestOutputs,
      lockfile: {
        path: "pnpm-lock.yaml",
        hash: contentHash(lockfileContent),
        content: lockfileContent,
      },
    },
  };
  return { ...payload, hash: planHash(payload) };
}

export function validateDependencyPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new DependencyTransactionError("Dependency plan must be an object.");
  }
  const { hash, ...payload } = plan;
  if (plan.version !== schemaVersion || typeof hash !== "string" || hash !== planHash(payload)) {
    throw new DependencyTransactionError("Dependency plan hash or schema is invalid.");
  }
  if (!Array.isArray(plan.inputs) || !Array.isArray(plan.outputs?.manifests)) {
    throw new DependencyTransactionError("Dependency plan structure is incomplete.");
  }
  const inputPaths = new Set();
  for (const input of plan.inputs) {
    const relativePath = normalizeRelativePath(input?.path);
    const validExistingInput =
      input?.exists === true &&
      ["file", "directory"].includes(input?.kind) &&
      /^[a-f0-9]{64}$/.test(input?.hash);
    const validMissingInput =
      input?.exists === false && input?.kind === "missing" && input?.hash === null;
    if (inputPaths.has(relativePath) || (!validExistingInput && !validMissingInput)) {
      throw new DependencyTransactionError(`Dependency plan input is invalid: ${relativePath}`);
    }
    inputPaths.add(relativePath);
  }
  for (const output of plan.outputs.manifests) {
    outputPath(output.path);
    if (contentHash(String(output.content)) !== output.hash) {
      throw new DependencyTransactionError(
        `Dependency plan output hash is invalid: ${output.path}`,
      );
    }
  }
  outputPath(plan.outputs.lockfile?.path);
  if (contentHash(String(plan.outputs.lockfile?.content)) !== plan.outputs.lockfile?.hash) {
    throw new DependencyTransactionError("Dependency plan lockfile hash is invalid.");
  }
  return plan;
}

export function storeDependencyPlan(projectRoot, plan) {
  validateDependencyPlan(plan);
  const paths = dependencyTransactionPaths(projectRoot);
  if (existsSync(paths.journal)) {
    throw new DependencyTransactionError(
      "An interrupted dependency transaction must be recovered before replacing its plan.",
      75,
    );
  }
  atomicWrite(paths.plan, `${JSON.stringify(plan, null, 2)}\n`);
  return paths.plan;
}

export function loadDependencyPlan(projectRoot) {
  const plan = readJsonFile(
    dependencyTransactionPaths(projectRoot).plan,
    "reviewed dependency plan",
  );
  return validateDependencyPlan(plan);
}

function currentOutputHash(projectRoot, output) {
  const current = readOptionalFile(projectRoot, output.path);
  return current.exists ? current.hash : null;
}

function journalOriginal(projectRoot, relativePath) {
  const current = readOptionalFile(projectRoot, relativePath);
  return {
    path: relativePath,
    existed: current.exists,
    hash: current.hash,
    content: current.content,
  };
}

function writeRepositoryOutput(projectRoot, output) {
  const relativePath = outputPath(output.path);
  const target = safeRepositoryPath(projectRoot, relativePath, { allowMissing: true });
  atomicWrite(target, String(output.content), 0o644);
}

function journalRecoveryEntries(journal) {
  const expectedByPath = new Map();
  for (const expected of journal.expectedOutputs) {
    const relativePath = outputPath(expected.path);
    if (expectedByPath.has(relativePath) || typeof expected.hash !== "string") {
      throw new DependencyTransactionError(
        "Dependency transaction journal is invalid; manual recovery is required.",
        75,
      );
    }
    expectedByPath.set(relativePath, expected);
  }

  const seenOriginals = new Set();
  const entries = journal.originals.map((original) => {
    const relativePath = outputPath(original.path);
    const expected = expectedByPath.get(relativePath);
    const validOriginal =
      typeof original.existed === "boolean" &&
      (original.existed
        ? typeof original.hash === "string" &&
          contentHash(String(original.content)) === original.hash
        : original.hash === null && original.content === null);
    if (seenOriginals.has(relativePath) || !expected || !validOriginal) {
      throw new DependencyTransactionError(
        "Dependency transaction journal is invalid; manual recovery is required.",
        75,
      );
    }
    seenOriginals.add(relativePath);
    return { expected, original: { ...original, path: relativePath } };
  });

  if (seenOriginals.size !== expectedByPath.size) {
    throw new DependencyTransactionError(
      "Dependency transaction journal is invalid; manual recovery is required.",
      75,
    );
  }
  return entries;
}

function outputMatchesOriginal(current, original) {
  return current.exists === original.existed && current.hash === original.hash;
}

function outputMatchesExpected(current, expected) {
  return current.exists && current.hash === expected.hash;
}

function assertRecoveryOutputOwned(projectRoot, entry) {
  const current = readOptionalFile(projectRoot, entry.original.path);
  if (
    !outputMatchesOriginal(current, entry.original) &&
    !outputMatchesExpected(current, entry.expected)
  ) {
    throw new DependencyTransactionError(
      `Dependency recovery refused to overwrite ${entry.original.path} because it contains an unrelated change; journal preserved for manual recovery.`,
      75,
    );
  }
  return current;
}

function restoreJournal(projectRoot, journal) {
  const entries = journalRecoveryEntries(journal);
  for (const entry of entries) assertRecoveryOutputOwned(projectRoot, entry);
  for (const entry of entries) {
    const current = assertRecoveryOutputOwned(projectRoot, entry);
    const { original } = entry;
    if (outputMatchesOriginal(current, original)) continue;
    const relativePath = original.path;
    const target = safeRepositoryPath(projectRoot, relativePath, { allowMissing: true });
    if (original.existed) atomicWrite(target, String(original.content), 0o644);
    else rmSync(target, { force: true });
  }
}

function verifyJournalRestored(projectRoot, journal) {
  for (const original of journal.originals) {
    const current = readOptionalFile(projectRoot, original.path);
    if (current.exists !== original.existed || current.hash !== original.hash) {
      throw new DependencyTransactionError(
        `Dependency rollback verification failed for ${original.path}; journal was preserved.`,
        75,
      );
    }
  }
}

function removePlanIfOwned(paths, planHashValue) {
  if (!existsSync(paths.plan)) return;
  try {
    const plan = validateDependencyPlan(readJsonFile(paths.plan, "reviewed dependency plan"));
    if (plan.hash === planHashValue) rmSync(paths.plan);
  } catch {
    // Preserve an invalid or unrelated plan for explicit inspection.
  }
}

function recoverUnderLock(projectRoot) {
  const paths = dependencyTransactionPaths(projectRoot);
  if (!existsSync(paths.journal)) return { recovered: false, result: null };
  const journal = readJsonFile(paths.journal, "dependency transaction journal");
  const { hash: journalHash, ...journalPayload } = journal ?? {};
  if (
    journal?.version !== schemaVersion ||
    journalHash !== planHash(journalPayload) ||
    typeof journal?.planHash !== "string" ||
    !Array.isArray(journal?.originals) ||
    !Array.isArray(journal?.expectedOutputs)
  ) {
    throw new DependencyTransactionError(
      "Dependency transaction journal is invalid; manual recovery is required.",
      75,
    );
  }
  const recoveryEntries = journalRecoveryEntries(journal);
  const fullyApplied = recoveryEntries.every(({ expected }) => {
    const current = readOptionalFile(projectRoot, expected.path);
    return outputMatchesExpected(current, expected);
  });
  if (fullyApplied) {
    rmSync(paths.journal);
    removePlanIfOwned(paths, journal.planHash);
    return {
      recovered: true,
      result: "finalized",
      changed: journal.changed ?? [],
      skipped: journal.skipped ?? [],
      planHash: journal.planHash,
      request: journal.request,
    };
  }
  restoreJournal(projectRoot, journal);
  verifyJournalRestored(projectRoot, journal);
  rmSync(paths.journal);
  return { recovered: true, result: "rolled-back" };
}

function journalWithHash(payload) {
  return { ...payload, hash: planHash(payload) };
}

export function recoverDependencyTransaction(projectRoot, options = {}) {
  return withDependencyTransactionLock(
    projectRoot,
    () => recoverUnderLock(projectRoot),
    options.lockOptions,
  );
}

function injectedInterruption(point, requestedPoint) {
  if (requestedPoint !== point) return;
  const error = new DependencyTransactionError(`Injected dependency interruption at ${point}.`, 86);
  error.simulatedInterruption = true;
  throw error;
}

export function applyStoredDependencyPlan(options) {
  const projectRoot = projectIdentity(options.projectRoot).root;
  return withDependencyTransactionLock(
    projectRoot,
    () => {
      const recovery = recoverUnderLock(projectRoot);
      if (recovery.result === "finalized") {
        if (
          stableJson(normalizeDependencyRequest(options.request)) !== stableJson(recovery.request)
        ) {
          throw new DependencyTransactionError(
            "A prior dependency transaction was finalized, but its request differs from this apply command.",
            64,
          );
        }
        return {
          changed: recovery.changed,
          skipped: recovery.skipped,
          planHash: recovery.planHash,
          recovered: recovery.result,
        };
      }
      const plan = loadDependencyPlan(projectRoot);
      const request = normalizeDependencyRequest(options.request);
      if (stableJson(request) !== stableJson(plan.request)) {
        throw new DependencyTransactionError(
          "Apply arguments do not match the reviewed dependency preview; use the same options.",
          64,
        );
      }
      verifyInputRecords(projectRoot, plan.inputs);
      const outputs = [...plan.outputs.manifests, plan.outputs.lockfile];
      const originals = outputs.map((output) => journalOriginal(projectRoot, output.path));
      const paths = dependencyTransactionPaths(projectRoot);
      const journalPayload = {
        version: schemaVersion,
        planHash: plan.hash,
        startedAt: new Date().toISOString(),
        request: plan.request,
        changed: plan.outputs.manifests.map((output) => output.path),
        skipped: plan.skipped,
        originals,
        expectedOutputs: outputs.map((output) => ({ path: output.path, hash: output.hash })),
      };
      const journal = journalWithHash(journalPayload);
      atomicWrite(paths.journal, `${JSON.stringify(journal, null, 2)}\n`);

      try {
        for (const output of plan.outputs.manifests) writeRepositoryOutput(projectRoot, output);
        injectedInterruption("after-manifests", options.injectedFailure);
        writeRepositoryOutput(projectRoot, plan.outputs.lockfile);
        injectedInterruption("after-lockfile", options.injectedFailure);
        for (const output of outputs) {
          if (currentOutputHash(projectRoot, output) !== output.hash) {
            throw new DependencyTransactionError(
              `Dependency transaction output verification failed: ${output.path}`,
            );
          }
        }
        rmSync(paths.journal);
        removePlanIfOwned(paths, plan.hash);
        return {
          changed: plan.outputs.manifests.map((output) => output.path),
          skipped: plan.skipped,
          planHash: plan.hash,
          recovered: recovery.result,
        };
      } catch (error) {
        if (error?.simulatedInterruption) throw error;
        try {
          restoreJournal(projectRoot, journal);
          verifyJournalRestored(projectRoot, journal);
          rmSync(paths.journal, { force: true });
        } catch (rollbackError) {
          throw new DependencyTransactionError(
            `${error.message}; automatic rollback failed: ${rollbackError.message}. Journal preserved at ${paths.journal}`,
            75,
          );
        }
        throw error;
      }
    },
    options.lockOptions,
  );
}

export function prepareDependencyPlan(options) {
  return withDependencyTransactionLock(
    options.projectRoot,
    () => {
      recoverUnderLock(options.projectRoot);
      const plan = createDependencyPlan(options);
      const planPath = storeDependencyPlan(options.projectRoot, plan);
      return { plan, planPath };
    },
    options.lockOptions,
  );
}

export function clearStoredDependencyPlan(projectRoot) {
  return withDependencyTransactionLock(projectRoot, () => {
    const paths = dependencyTransactionPaths(projectRoot);
    recoverUnderLock(projectRoot);
    if (existsSync(paths.plan)) rmSync(paths.plan);
  });
}
