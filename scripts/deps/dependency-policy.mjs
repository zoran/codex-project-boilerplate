import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { repositoryRoot } from "../repository/source-inventory.mjs";

export const root = repositoryRoot;
export const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const registryCache = new Map();

function parseJsonFile(relativeFilePath, fallback) {
  const fullPath = path.join(root, relativeFilePath);
  if (!existsSync(fullPath)) return fallback;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8"));
  } catch {
    throw new Error(`${relativeFilePath} contains invalid JSON`);
  }
}

export function readPolicy() {
  return parseJsonFile("dependency-policy.json", { pins: [] });
}

export function validatePolicy(policy) {
  const failures = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["dependency-policy.json must be an object"];
  }
  if (!Array.isArray(policy.pins)) return ["dependency-policy.json pins must be an array"];

  const today = new Date().toISOString().slice(0, 10);
  const identities = new Set();
  for (const [index, pin] of policy.pins.entries()) {
    const label = `dependency-policy.json pins[${index}]`;
    if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (typeof pin.name !== "string" || !pin.name.trim()) {
      failures.push(`${label} must include name`);
    }
    if (typeof pin.reason !== "string" || !pin.reason.trim()) {
      failures.push(`${label} must include reason`);
    }
    if (pin.manifest !== undefined && typeof pin.manifest !== "string") {
      failures.push(`${label} manifest must be a repository-relative string`);
    }
    if (pin.section !== undefined && !dependencySections.includes(pin.section)) {
      failures.push(`${label} section must be a dependency section`);
    }
    if (pin.expires !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pin.expires)) {
        failures.push(`${label} expires must be an ISO date`);
      } else if (pin.expires < today) {
        failures.push(`${label} expired on ${pin.expires}`);
      }
    }
    const identity = `${pin.manifest ?? "*"}:${pin.section ?? "*"}:${pin.name ?? ""}`;
    if (identities.has(identity)) failures.push(`${label} duplicates pin ${identity}`);
    identities.add(identity);
  }
  return failures;
}

export function packageManifests({
  repositoryRoot: projectRoot = root,
  spawnPnpm = spawnSync,
} = {}) {
  const projects = runPnpmJson(
    ["--recursive", "list", "--depth", "-1", "--json"],
    "pnpm recursive workspace list",
    { cwd: projectRoot, spawnPnpm },
  );
  if (!Array.isArray(projects)) {
    throw new Error("pnpm recursive workspace list returned an invalid project graph");
  }
  const realRoot = realpathSync.native(projectRoot);
  const rootManifest = path.join(realRoot, "package.json");
  try {
    const rootManifestStats = lstatSync(rootManifest);
    if (
      rootManifestStats.isSymbolicLink() ||
      !rootManifestStats.isFile() ||
      realpathSync.native(rootManifest) !== rootManifest
    ) {
      throw new Error("manifest");
    }
  } catch {
    throw new Error("dependency workspace root must contain a real package.json");
  }
  const manifestPaths = new Set(["package.json"]);
  for (const project of projects) {
    if (!isRecord(project) || typeof project.path !== "string" || !project.path.trim()) {
      throw new Error("pnpm recursive workspace list returned an invalid project location");
    }
    const rawLocation = project.path.trim();
    if (
      rawLocation.includes("\0") ||
      hasTraversal(rawLocation) ||
      (path.win32.isAbsolute(rawLocation) && !path.isAbsolute(rawLocation))
    ) {
      throw new Error("pnpm recursive workspace list returned an unsafe project location");
    }
    const absolute = path.isAbsolute(rawLocation)
      ? path.normalize(rawLocation)
      : path.resolve(realRoot, rawLocation);
    const relative = path.relative(realRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("pnpm recursive workspace list returned a project outside the repository");
    }
    let cursor = realRoot;
    try {
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        if (lstatSync(cursor).isSymbolicLink()) {
          throw new Error("symlink");
        }
      }
      if (!lstatSync(absolute).isDirectory() || realpathSync.native(absolute) !== absolute) {
        throw new Error("directory");
      }
      const manifest = path.join(absolute, "package.json");
      const manifestStats = lstatSync(manifest);
      if (
        manifestStats.isSymbolicLink() ||
        !manifestStats.isFile() ||
        realpathSync.native(manifest) !== manifest
      ) {
        throw new Error("manifest");
      }
    } catch {
      throw new Error("pnpm recursive workspace list returned a non-real project location");
    }
    manifestPaths.add(path.posix.join(relative.split(path.sep).join("/") || ".", "package.json"));
  }
  const manifests = [...manifestPaths].sort().map((relativePath) => {
    const fullPath = path.join(projectRoot, relativePath);
    let data;
    try {
      data = JSON.parse(readFileSync(fullPath, "utf8"));
    } catch {
      throw new Error(`${relativePath} contains invalid JSON`);
    }
    return {
      path: fullPath,
      relativePath,
      workspacePath:
        path.posix.dirname(relativePath) === "." ? "." : path.posix.dirname(relativePath),
      name: typeof data.name === "string" ? data.name : null,
      data,
    };
  });
  return manifests;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rawOutdatedEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) throw new Error("pnpm outdated returned an unsupported JSON shape");
  return Object.entries(raw).flatMap(([name, value]) => {
    const entries = Array.isArray(value) ? value : [value];
    if (entries.length === 0 || entries.some((entry) => !isRecord(entry))) {
      throw new Error("pnpm outdated returned an incomplete package record");
    }
    return entries.map((entry) => {
      if (entry.packageName !== undefined && entry.packageName !== name) {
        throw new Error("pnpm outdated returned contradictory package identities");
      }
      return { ...entry, packageName: name };
    });
  });
}

function nonemptyScalar(value) {
  return ["string", "number"].includes(typeof value) && String(value).trim().length > 0;
}

function normalizeSection(value) {
  const text = String(value ?? "");
  const aliases = {
    dependency: "dependencies",
    devDependency: "devDependencies",
    optionalDependency: "optionalDependencies",
    peerDependency: "peerDependencies",
  };
  if (dependencySections.includes(text)) return text;
  return aliases[text] ?? null;
}

function isCompleteOutdatedEntry(entry) {
  return (
    isRecord(entry) &&
    nonemptyScalar(entry.packageName ?? entry.name) &&
    nonemptyScalar(entry.current) &&
    nonemptyScalar(entry.wanted) &&
    nonemptyScalar(entry.latest) &&
    normalizeSection(entry.dependencyType ?? entry.type) !== null
  );
}

function hasCompleteOutdatedPayload(raw) {
  try {
    const entries = rawOutdatedEntries(raw);
    return entries.length > 0 && entries.every(isCompleteOutdatedEntry);
  } catch {
    return false;
  }
}

function hasFatalPnpmDiagnostic(stderr) {
  const diagnostic = String(stderr ?? "");
  return (
    /\bERR_PNPM_[A-Z0-9_]+\b/i.test(diagnostic) ||
    /(?:^|\n)\s*(?:ERR!(?:\s|$)|ERROR\b|FATAL\b)/i.test(diagnostic)
  );
}

export function parsePnpmJsonResult(result, label, { acceptOutdatedStatus = false } = {}) {
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  const output = (result.stdout ?? "").trim();
  const hasOutdatedResult = acceptOutdatedStatus && result.status === 1 && output.length > 0;
  if (result.status !== 0 && !hasOutdatedResult) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
  if (!output) return {};
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (result.status === 1 && acceptOutdatedStatus) {
    if (hasFatalPnpmDiagnostic(result.stderr)) {
      throw new Error(`${label} failed with status 1 and a fatal pnpm diagnostic`);
    }
    if (!hasCompleteOutdatedPayload(parsed)) {
      throw new Error(`${label} failed with status 1 without a complete outdated result`);
    }
  }
  return parsed;
}

function runPnpmJson(args, label, { spawnPnpm = spawnSync, cwd = root, ...options } = {}) {
  const result = spawnPnpm("pnpm", args, {
    cwd,
    encoding: "utf8",
    input: "",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
    timeout: 120_000,
  });
  return parsePnpmJsonResult(result, label, options);
}

function diagnosticIdentity(value) {
  return String(value ?? "unknown")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 120);
}

function ownerError(packageName, section, detail) {
  return new Error(
    `pnpm outdated owner for ${diagnosticIdentity(packageName)} (${section}) ${detail}`,
  );
}

function hasTraversal(value) {
  return String(value).replaceAll("\\", "/").split("/").includes("..");
}

function manifestFromOwnerLocation(location, manifests, projectRoot, packageName, section) {
  if (typeof location !== "string" || !location.trim() || location.includes("\0")) {
    throw ownerError(packageName, section, "has an invalid location");
  }
  const rawLocation = location.trim();
  if (
    hasTraversal(rawLocation) ||
    (path.win32.isAbsolute(rawLocation) && !path.isAbsolute(rawLocation))
  ) {
    throw ownerError(packageName, section, "uses an unsafe location");
  }

  let realRoot;
  try {
    realRoot = realpathSync.native(projectRoot);
  } catch {
    throw ownerError(packageName, section, "cannot resolve the repository root");
  }
  const absoluteLocation = path.isAbsolute(rawLocation)
    ? path.normalize(rawLocation)
    : path.resolve(realRoot, rawLocation);
  const locationRelative = path.relative(realRoot, absoluteLocation);
  if (
    locationRelative === ".." ||
    locationRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(locationRelative)
  ) {
    throw ownerError(packageName, section, "resolves outside the repository");
  }

  let cursor = realRoot;
  try {
    for (const segment of locationRelative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink()) {
        throw ownerError(packageName, section, "crosses a symbolic-link boundary");
      }
    }
    const locationStats = lstatSync(absoluteLocation);
    let manifestPath;
    if (locationStats.isDirectory()) manifestPath = path.join(absoluteLocation, "package.json");
    else if (locationStats.isFile() && path.basename(absoluteLocation) === "package.json") {
      manifestPath = absoluteLocation;
    } else {
      throw ownerError(packageName, section, "does not identify a package manifest");
    }
    const manifestStats = lstatSync(manifestPath);
    if (manifestStats.isSymbolicLink()) {
      throw ownerError(packageName, section, "uses a symbolic-link manifest");
    }
    if (!manifestStats.isFile() || realpathSync.native(manifestPath) !== manifestPath) {
      throw ownerError(packageName, section, "does not identify a real package manifest");
    }
    const relativePath = path.relative(realRoot, manifestPath).split(path.sep).join("/");
    const matches = manifests.filter((manifest) => manifest.relativePath === relativePath);
    if (matches.length !== 1) {
      throw ownerError(packageName, section, "does not identify one declared workspace manifest");
    }
    return matches[0];
  } catch (error) {
    if (error?.message?.startsWith("pnpm outdated owner for ")) throw error;
    throw ownerError(packageName, section, "does not identify a readable workspace location");
  }
}

function manifestFromOwnerName(ownerName, manifests, packageName, section) {
  if (typeof ownerName !== "string" || !ownerName.trim()) {
    throw ownerError(packageName, section, "has an invalid workspace name");
  }
  const matches = manifests.filter((manifest) => manifest.name === ownerName);
  if (matches.length !== 1) {
    throw ownerError(packageName, section, "does not identify one declared workspace name");
  }
  return matches[0];
}

function singularOwner(entry, manifests, projectRoot, packageName, section) {
  const names = [entry.dependentPackageName, entry.dependent].filter(
    (value) => value !== undefined && value !== null,
  );
  const locations = [entry.dependentPackageLocation, entry.dependentLocation].filter(
    (value) => value !== undefined && value !== null,
  );
  if (names.length === 0 && locations.length === 0) return null;
  const owners = [
    ...names.map((name) => manifestFromOwnerName(name, manifests, packageName, section)),
    ...locations.map((location) =>
      manifestFromOwnerLocation(location, manifests, projectRoot, packageName, section),
    ),
  ];
  if (new Set(owners.map((manifest) => manifest.relativePath)).size !== 1) {
    throw ownerError(packageName, section, "has contradictory singular owner fields");
  }
  return owners[0];
}

function arrayOwners(entry, manifests, projectRoot, packageName, section) {
  if (!Object.prototype.hasOwnProperty.call(entry, "dependentPackages")) return null;
  if (!Array.isArray(entry.dependentPackages)) {
    throw ownerError(packageName, section, "has an invalid dependentPackages value");
  }
  const owners = entry.dependentPackages.map((owner) => {
    if (!isRecord(owner)) {
      throw ownerError(packageName, section, "has an invalid dependentPackages entry");
    }
    const byLocation = manifestFromOwnerLocation(
      owner.location,
      manifests,
      projectRoot,
      packageName,
      section,
    );
    if (owner.name !== undefined) {
      const byName = manifestFromOwnerName(owner.name, manifests, packageName, section);
      if (byName.relativePath !== byLocation.relativePath) {
        throw ownerError(packageName, section, "has contradictory owner name and location");
      }
    }
    return byLocation;
  });
  if (new Set(owners.map((manifest) => manifest.relativePath)).size !== owners.length) {
    throw ownerError(packageName, section, "contains a duplicate dependentPackages owner");
  }
  return owners;
}

function ownersForEntry(entry, manifests, projectRoot, packageName, section) {
  const singular = singularOwner(entry, manifests, projectRoot, packageName, section);
  const array = arrayOwners(entry, manifests, projectRoot, packageName, section);
  if (array?.length > 0 && singular) {
    if (array.length !== 1 || array[0].relativePath !== singular.relativePath) {
      throw ownerError(packageName, section, "conflicts with dependentPackages");
    }
  }
  if (array?.length > 0) return array;
  return singular ? [singular] : [];
}

function registryNameForDeclaration(name, spec) {
  const match = /^npm:((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(String(spec ?? "").trim());
  return match?.[1] ?? name;
}

function declarationsForManifest(manifest, section, registryName, explicitName) {
  const declarations = manifest.data[section] ?? {};
  if (explicitName !== undefined) {
    return Object.prototype.hasOwnProperty.call(declarations, explicitName)
      ? [{ manifest, name: explicitName }]
      : [];
  }
  return Object.entries(declarations)
    .filter(([name, spec]) => registryNameForDeclaration(name, spec) === registryName)
    .map(([name]) => ({ manifest, name }));
}

export function normalizeOutdated(
  raw,
  manifests = packageManifests(),
  { repositoryRoot: projectRoot = root } = {},
) {
  const normalized = [];
  for (const entry of rawOutdatedEntries(raw)) {
    if (!isRecord(entry)) throw new Error("pnpm outdated returned an incomplete package record");
    const registryName = entry.packageName ?? entry.name;
    const section = normalizeSection(entry.dependencyType ?? entry.type);
    if (!isCompleteOutdatedEntry(entry) || !section) {
      throw new Error("pnpm outdated returned an incomplete package record");
    }
    const explicitName = entry.manifestDependencyName;
    if (explicitName !== undefined && (typeof explicitName !== "string" || !explicitName.trim())) {
      throw ownerError(registryName, section, "has an invalid manifest dependency name");
    }
    const explicitOwners = ownersForEntry(entry, manifests, projectRoot, registryName, section);
    const ownerPool = explicitOwners.length > 0 ? explicitOwners : manifests;
    const declarations = ownerPool.flatMap((manifest) =>
      declarationsForManifest(manifest, section, registryName, explicitName),
    );
    if (explicitOwners.length === 0 && declarations.length !== 1) {
      throw new Error(
        `pnpm outdated did not identify one manifest dependency for ${diagnosticIdentity(registryName)} (${section}); found ${declarations.length}`,
      );
    }
    for (const owner of explicitOwners) {
      const ownerDeclarations = declarations.filter(
        (declaration) => declaration.manifest.relativePath === owner.relativePath,
      );
      if (ownerDeclarations.length !== 1) {
        throw ownerError(
          registryName,
          section,
          `does not identify one dependency declaration in ${owner.relativePath}`,
        );
      }
    }
    for (const declaration of declarations) {
      const { manifest, name } = declaration;
      normalized.push({
        key: `${manifest.relativePath}:${section}:${name}`,
        name: String(name),
        registryName: String(registryName),
        current: String(entry.current),
        wanted: String(entry.wanted),
        latest: String(entry.latest),
        delta: classifyUpdate(entry.current, entry.latest),
        section,
        manifestPath: manifest.relativePath,
        workspacePath: manifest.workspacePath,
        workspaceName: manifest.name ?? manifest.workspacePath,
        currentSpec: String(manifest.data[section][name]),
      });
    }
  }
  const entries = normalized.sort(
    (left, right) =>
      left.manifestPath.localeCompare(right.manifestPath) ||
      left.section.localeCompare(right.section) ||
      left.name.localeCompare(right.name),
  );
  const keys = new Set();
  for (const entry of entries) {
    if (keys.has(entry.key)) {
      throw new Error(`pnpm outdated returned duplicate dependency identity ${entry.key}`);
    }
    keys.add(entry.key);
  }
  return entries;
}

export function readOutdated(options = {}) {
  const projectRoot = options.repositoryRoot ?? root;
  const spawnPnpm = options.spawnPnpm ?? spawnSync;
  const manifests =
    options.manifests ?? packageManifests({ repositoryRoot: projectRoot, spawnPnpm });
  const rawEntries = [];
  for (const manifest of manifests) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest.data[section] ?? {}).sort()) {
        if (
          section === "optionalDependencies" &&
          Object.prototype.hasOwnProperty.call(manifest.data.dependencies ?? {}, name)
        ) {
          throw new Error(
            `pnpm outdated cannot isolate ${name} in dependencies and optionalDependencies of ${manifest.relativePath}`,
          );
        }
        const sectionArgs =
          section === "devDependencies"
            ? ["--dev"]
            : section === "dependencies"
              ? ["--prod", "--no-optional"]
              : ["--prod"];
        const label = `pnpm outdated for ${manifest.relativePath}:${section}:${name}`;
        const workspaceDirectory = path.dirname(
          manifest.path ?? path.join(projectRoot, manifest.relativePath),
        );
        const raw = runPnpmJson(["outdated", name, "--format", "json", ...sectionArgs], label, {
          acceptOutdatedStatus: true,
          cwd: workspaceDirectory,
          spawnPnpm,
        });
        const entries = rawOutdatedEntries(raw);
        if (entries.length === 0) continue;
        if (entries.length !== 1) {
          throw new Error(`${label} returned more than one dependency record`);
        }
        const entry = entries[0];
        if (normalizeSection(entry.dependencyType ?? entry.type) !== section) {
          throw new Error(`${label} returned a contradictory dependency section`);
        }
        rawEntries.push({
          ...entry,
          manifestDependencyName: name,
          dependentPackageLocation: workspaceDirectory,
          ...(manifest.name ? { dependentPackageName: manifest.name } : {}),
        });
      }
    }
  }
  return normalizeOutdated(rawEntries, manifests, { repositoryRoot: projectRoot });
}

export function parseVersion(version) {
  const match = String(version)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: String(version).includes("-"),
    raw: String(version),
  };
}

export function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

export function classifyUpdate(currentVersion, targetVersion) {
  const current = parseVersion(currentVersion);
  const target = parseVersion(targetVersion);
  if (!current || !target) return "unknown";
  if (target.prerelease) return "prerelease";
  if (compareVersions(target, current) <= 0) return "current";
  if (target.major !== current.major) return "major";
  if (target.minor !== current.minor) return current.major === 0 ? "major" : "minor";
  return target.patch !== current.patch ? "patch" : "current";
}

export function isPinned(entry, policy) {
  return (policy.pins ?? []).some(
    (pin) =>
      pin.name === entry.name &&
      (!pin.manifest || pin.manifest === entry.manifestPath) &&
      (!pin.section || pin.section === entry.section),
  );
}

function recommendation(entry, policy) {
  if (isPinned(entry, policy)) return "Pinned; review the recorded reason.";
  const delta = entry.delta ?? classifyUpdate(entry.current, entry.latest);
  if (delta === "patch") return "Eligible for explicit patch maintenance.";
  if (delta === "minor") return "Select after compatibility review.";
  if (delta === "major") return "Select after migration review.";
  if (delta === "prerelease") return "Do not update automatically.";
  return "Review manually.";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

export function formatDependencyTable(entries, policy) {
  const rows = [
    "| Package | Manifest | Workspace | Section | Current | Wanted | Latest | Delta | Action |",
    "|---|---|---|---|---:|---:|---:|---|---|",
  ];
  if (entries.length === 0) {
    rows.push(
      "| None | - | - | - | - | - | - | - | Registry reports no outdated direct dependencies. |",
    );
  }
  for (const entry of entries) {
    rows.push(
      `| ${escapeCell(entry.name)} | ${escapeCell(entry.manifestPath)} | ${escapeCell(entry.workspacePath)} | ${entry.section} | ${entry.current} | ${entry.wanted} | ${entry.latest} | ${entry.delta ?? classifyUpdate(entry.current, entry.latest)} | ${escapeCell(recommendation(entry, policy))} |`,
    );
  }
  return rows.join("\n");
}

export function registryVersions(packageName) {
  if (registryCache.has(packageName)) return registryCache.get(packageName);
  const raw = runPnpmJson(
    ["view", packageName, "versions", "--json"],
    `registry lookup for ${packageName}`,
  );
  const versions = (Array.isArray(raw) ? raw : [raw]).map(String);
  registryCache.set(packageName, versions);
  return versions;
}

export function latestPatchTarget(entry) {
  const current = parseVersion(entry.current);
  if (!current) return null;
  return (
    registryVersions(entry.registryName ?? entry.name)
      .map(parseVersion)
      .filter(Boolean)
      .filter(
        (version) =>
          !version.prerelease &&
          version.major === current.major &&
          version.minor === current.minor &&
          compareVersions(version, current) > 0,
      )
      .sort(compareVersions)
      .at(-1)?.raw ?? null
  );
}
