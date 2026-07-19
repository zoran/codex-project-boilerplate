import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

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

export function packageManifests() {
  return listActiveFiles()
    .filter((filePath) => path.basename(filePath) === "package.json")
    .map((relativePath) => {
      const fullPath = path.join(root, relativePath);
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
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function rawOutdatedEntries(raw) {
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw ?? {}).flatMap(([name, value]) => {
    const entries = Array.isArray(value) ? value : [value];
    return entries.map((entry) => ({ name, ...entry }));
  });
}

function hasCompleteOutdatedEntry(raw) {
  return rawOutdatedEntries(raw).some(
    (entry) => (entry.packageName ?? entry.name) && entry.current && entry.latest,
  );
}

function hasFatalPnpmDiagnostic(stderr) {
  return /\bERR_PNPM_[A-Z0-9_]+\b/.test(String(stderr ?? ""));
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
    if (!hasCompleteOutdatedEntry(parsed)) {
      throw new Error(`${label} failed with status 1 without a complete outdated result`);
    }
  }
  return parsed;
}

function runPnpmJson(args, label, { spawnPnpm = spawnSync, ...options } = {}) {
  const result = spawnPnpm("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    input: "",
    maxBuffer: 16 * 1024 * 1024,
    stdio: "pipe",
    timeout: 120_000,
  });
  return parsePnpmJsonResult(result, label, options);
}

function normalizeSection(value) {
  const text = String(value ?? "");
  const aliases = {
    dependency: "dependencies",
    devDependency: "devDependencies",
    optionalDependency: "optionalDependencies",
    peerDependency: "peerDependencies",
  };
  return dependencySections.includes(text) ? text : (aliases[text] ?? "dependencies");
}

function relativeManifestFromLocation(location) {
  if (!location) return null;
  const absolute = path.isAbsolute(location) ? location : path.resolve(root, location);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return relative.endsWith("package.json")
    ? relative
    : path.posix.join(relative || ".", "package.json");
}

export function normalizeOutdated(raw, manifests = packageManifests()) {
  const normalized = [];
  for (const entry of rawOutdatedEntries(raw)) {
    const name = entry.packageName ?? entry.name;
    if (!name || !entry.current || !entry.latest) continue;
    const section = normalizeSection(entry.dependencyType ?? entry.type);
    let candidates = manifests.filter((manifest) =>
      Object.prototype.hasOwnProperty.call(manifest.data[section] ?? {}, name),
    );
    const locationManifest = relativeManifestFromLocation(
      entry.dependentPackageLocation ?? entry.dependentLocation,
    );
    if (locationManifest) {
      candidates = candidates.filter((manifest) => manifest.relativePath === locationManifest);
    }
    const dependentName = entry.dependentPackageName ?? entry.dependent;
    if (dependentName && dependentName !== "workspace") {
      const named = candidates.filter((manifest) => manifest.name === dependentName);
      if (named.length > 0) candidates = named;
    }
    if (candidates.length !== 1) {
      throw new Error(
        `pnpm outdated did not identify one manifest for ${name} (${section}); found ${candidates.length}`,
      );
    }
    const manifest = candidates[0];
    normalized.push({
      key: `${manifest.relativePath}:${section}:${name}`,
      name: String(name),
      current: String(entry.current),
      wanted: String(entry.wanted ?? entry.latest),
      latest: String(entry.latest),
      section,
      manifestPath: manifest.relativePath,
      workspacePath: manifest.workspacePath,
      workspaceName: manifest.name ?? manifest.workspacePath,
      currentSpec: String(manifest.data[section][name]),
    });
  }
  return normalized.sort(
    (left, right) =>
      left.manifestPath.localeCompare(right.manifestPath) ||
      left.section.localeCompare(right.section) ||
      left.name.localeCompare(right.name),
  );
}

export function readOutdated({ manifests = packageManifests(), spawnPnpm = spawnSync } = {}) {
  return normalizeOutdated(
    runPnpmJson(["--recursive", "outdated", "--format", "json"], "pnpm recursive outdated", {
      acceptOutdatedStatus: true,
      spawnPnpm,
    }),
    manifests,
  );
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
  const delta = classifyUpdate(entry.current, entry.latest);
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
    "| Package | Workspace | Section | Current | Wanted | Latest | Delta | Action |",
    "|---|---|---|---:|---:|---:|---|---|",
  ];
  if (entries.length === 0) {
    rows.push(
      "| None | - | - | - | - | - | - | Registry reports no outdated direct dependencies. |",
    );
  }
  for (const entry of entries) {
    rows.push(
      `| ${escapeCell(entry.name)} | ${escapeCell(entry.workspacePath)} | ${entry.section} | ${entry.current} | ${entry.wanted} | ${entry.latest} | ${classifyUpdate(entry.current, entry.latest)} | ${escapeCell(recommendation(entry, policy))} |`,
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
    registryVersions(entry.name)
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
