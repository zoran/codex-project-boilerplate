import process from "node:process";
import {
  classifyUpdate,
  formatDependencyTable,
  isPinned,
  latestPatchTarget,
  packageManifests,
  readOutdated,
  readPolicy,
  root,
  validatePolicy,
} from "./dependency-policy.mjs";
import {
  applyStoredDependencyPlan,
  clearStoredDependencyPlan,
  normalizeDependencyRequest,
  prepareDependencyPlan,
} from "./dependency-transaction.mjs";

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { level: "patch", select: [], yes: false, allowMajor: false, includePinned: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--yes" || value === "-y") args.yes = true;
    else if (value === "--allow-major") args.allowMajor = true;
    else if (value === "--include-pinned") args.includePinned = true;
    else if (value === "--level") args.level = argv[++index] ?? "";
    else if (value.startsWith("--level=")) args.level = value.slice(8);
    else if (value === "--select") args.select.push(...splitList(argv[++index] ?? ""));
    else if (value.startsWith("--select=")) args.select.push(...splitList(value.slice(9)));
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`unknown argument ${value}`);
  }
  if (!["patch", "minor", "major", "all"].includes(args.level)) {
    throw new Error("--level must be patch, minor, major, or all");
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  pnpm deps:update:patch",
    "  pnpm deps:update -- --select <workspace>:<package> --level minor --yes",
    "  pnpm deps:update -- --select <workspace>:<package> --level major --allow-major --yes",
    "",
    "Omit --yes to create a reviewed immutable preview. Apply the same preview with --yes.",
    "A bare package name is accepted only when it occurs once.",
  ].join("\n");
}

function selectionIds(entry) {
  return new Set([
    entry.name,
    `${entry.workspacePath}:${entry.name}`,
    `${entry.manifestPath}:${entry.name}`,
  ]);
}

function selectedEntries(entries, selections) {
  if (selections.length === 0) return new Set();
  const selected = new Set();
  for (const selection of selections) {
    const matches = entries.filter((entry) => selectionIds(entry).has(selection));
    if (matches.length === 0)
      throw new Error(`selection did not match an outdated dependency: ${selection}`);
    if (!selection.includes(":") && matches.length > 1) {
      throw new Error(`selection is ambiguous; include workspace: ${selection}`);
    }
    for (const entry of matches) selected.add(entry.key);
  }
  return selected;
}

function targetFor(entry, args, selected) {
  if (selected) {
    const delta = classifyUpdate(entry.current, entry.latest);
    if (delta === "minor" && !["minor", "all"].includes(args.level)) {
      throw new Error(`${entry.workspacePath}:${entry.name} requires --level minor (or all)`);
    }
    if (delta === "major" && !["major", "all"].includes(args.level)) {
      throw new Error(`${entry.workspacePath}:${entry.name} requires --level major (or all)`);
    }
    if (delta === "major" && !args.allowMajor) {
      throw new Error(`${entry.workspacePath}:${entry.name} requires --allow-major`);
    }
    if (delta === "prerelease" || delta === "unknown") return null;
    return entry.latest;
  }
  if (args.level !== "patch") return null;
  const directDelta = classifyUpdate(entry.current, entry.latest);
  return directDelta === "patch" ? entry.latest : latestPatchTarget(entry);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.level !== "patch" && args.select.length === 0) {
    throw new Error("minor/major updates require explicit --select entries");
  }
  const request = normalizeDependencyRequest(args);
  if (args.yes) {
    const result = applyStoredDependencyPlan({ projectRoot: root, request });
    if (result.recovered) console.log(`Recovered prior transaction: ${result.recovered}.`);
    console.log(`Applied reviewed dependency plan ${result.planHash}.`);
    console.log(`Updated manifests: ${result.changed.join(", ")}`);
    if (result.skipped.length > 0) console.log(`Skipped: ${result.skipped.join(", ")}`);
    return;
  }

  const policy = readPolicy();
  const policyFailures = validatePolicy(policy);
  if (policyFailures.length > 0) throw new Error(policyFailures.join("; "));
  const entries = readOutdated();
  const selected = selectedEntries(entries, args.select);
  const updates = [];
  const skipped = [];

  for (const entry of entries) {
    const isSelected = selected.has(entry.key);
    if (isPinned(entry, policy) && !args.includePinned) {
      if (isSelected) skipped.push(`${entry.key}: pinned`);
      continue;
    }
    const target = targetFor(entry, args, isSelected);
    if (!target) continue;
    const delta = classifyUpdate(entry.current, target);
    if (!["patch", "minor", "major"].includes(delta)) continue;
    if (delta === "minor" && !["minor", "all"].includes(args.level) && !isSelected) continue;
    if (
      delta === "major" &&
      (!args.allowMajor || (!["major", "all"].includes(args.level) && !isSelected))
    )
      continue;
    updates.push({ ...entry, target, delta });
  }

  console.log(formatDependencyTable(entries, policy));
  if (updates.length === 0) {
    clearStoredDependencyPlan(root);
    if (skipped.length > 0) console.log(`Skipped: ${skipped.join(", ")}`);
    console.log("No dependency updates selected.");
    return;
  }
  console.log("\nPlanned updates:");
  for (const update of updates) {
    console.log(
      `- ${update.workspacePath} ${update.name}: ${update.current} -> ${update.target} (${update.delta})`,
    );
  }
  const { plan } = prepareDependencyPlan({
    projectRoot: root,
    request,
    updates,
    manifestPaths: packageManifests().map((manifest) => manifest.relativePath),
  });
  console.log(`Reviewed plan: ${plan.hash}`);
  console.log("Stored at .project-state/dependency-update/plan.json for exact review.");
  console.log("Preview only; rerun with the same options plus --yes to apply this exact plan.");
}

try {
  main();
} catch (error) {
  console.error(`Dependency update failed: ${error.message}`);
  process.exit(1);
}
