import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { discoverProductLayout } from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";
import {
  changedPathsFromGit,
  classifyPath,
  insideGitWorktree,
  normalizePath,
  root,
} from "./adaptive-state.mjs";

export { printPlan, runPlan } from "./verification-executor.mjs";

const completeRiskCategories = new Set([
  "app/package/service/runtime source",
  "dependency/package manager files",
  "infrastructure/runtime config",
  "unknown or incomplete change scope",
]);

const ownedFrameworkCategories = new Set([
  "context workflow",
  "dependency workflow",
  "setup workflow",
  "stack workflow",
  "verification orchestration",
  "web workflow",
]);

export function verificationCommand({
  key,
  label,
  executable,
  args = [],
  reason,
  phase = "read-only",
}) {
  return { key, label, executable, args, reason, phase };
}

function commandSignature(command) {
  return JSON.stringify([command.executable, command.args, command.phase]);
}

export function dedupeCommands(commands) {
  const deduped = new Map();
  for (const command of commands) {
    const existing = deduped.get(command.key);
    if (!existing) {
      deduped.set(command.key, command);
      continue;
    }
    if (commandSignature(existing) !== commandSignature(command)) {
      throw new Error(`Verification command key ${command.key} has conflicting definitions.`);
    }
  }
  return [...deduped.values()];
}

function nodeCommand(key, label, script, reason, args = [], phase = "read-only") {
  return verificationCommand({
    key,
    label,
    executable: process.execPath,
    args: [script, ...args],
    reason,
    phase,
  });
}

function bashCommand(key, label, script, reason, args = []) {
  return verificationCommand({ key, label, executable: "bash", args: [script, ...args], reason });
}

function existingTestFiles(relativePaths) {
  return relativePaths.filter((relativePath) => existsSync(path.join(root, relativePath)));
}

export function completeVerificationCommands() {
  const commands = [
    bashCommand(
      "syntax-lint",
      "repository syntax and lint",
      "scripts/verify/lint.sh",
      "complete verification always checks repository-owned shell, JavaScript, and JSON syntax",
    ),
    nodeCommand(
      "docs",
      "documentation",
      "scripts/verify/docs.mjs",
      "complete verification always checks documentation structure, map, and links",
    ),
    bashCommand(
      "scripts",
      "script inventory",
      "scripts/verify/scripts.sh",
      "complete verification always checks script inventory and executable entry points",
    ),
    nodeCommand(
      "repository-smoke",
      "repository baseline",
      "scripts/verify/repository-smoke.mjs",
      "complete verification always checks the repository's minimum operational shape",
    ),
    nodeCommand(
      "skills",
      "skill boundaries",
      "scripts/verify/skill-paths.mjs",
      "complete verification always checks repository-owned skill boundaries and metadata",
    ),
    nodeCommand(
      "codex-config",
      "project Codex config",
      "scripts/setup/validate-codex-config.mjs",
      "complete verification always validates the tracked project policy layer",
    ),
    nodeCommand(
      "dependencies",
      "dependency policy and lockfile",
      "scripts/verify/dependencies.mjs",
      "complete verification always checks deterministic dependency policy and offline lockfile consistency",
    ),
    verificationCommand({
      key: "dependency-regressions",
      label: "dependency workflow regressions",
      executable: process.execPath,
      args: [
        "--test",
        "--test-reporter=dot",
        ...existingTestFiles([
          "scripts/deps/dependency-policy.test.mjs",
          "scripts/deps/dependency-owner-normalization.test.mjs",
        ]),
      ],
      reason:
        "complete verification checks workspace ownership, ambiguity, scoped pins, stable selections, transactions, and version classification",
    }),
    nodeCommand(
      "secrets",
      "secret scan",
      "scripts/verify/secrets.mjs",
      "complete verification always checks committable content for secret material",
    ),
    nodeCommand(
      "language",
      "language hygiene",
      "scripts/verify/language.mjs",
      "complete verification always checks active repository language policy",
    ),
    nodeCommand(
      "patterns",
      "code-pattern policy",
      "scripts/verify/patterns.mjs",
      "complete verification always checks maintainability and source-role policy",
    ),
    nodeCommand(
      "context-policy",
      "context source policy",
      "scripts/verify/context-source-policy.mjs",
      "complete verification checks retrieval source boundaries without loading the model or index",
    ),
    verificationCommand({
      key: "context-regressions",
      label: "context retrieval regressions",
      executable: process.execPath,
      args: ["--test", "--test-reporter=dot", "scripts/context/context-regression.test.mjs"],
      reason:
        "complete verification exercises retrieval behavior in isolated temporary index roots",
    }),
    verificationCommand({
      key: "setup-regressions",
      label: "setup and project isolation regressions",
      executable: process.execPath,
      args: [
        "--test",
        "--test-reporter=dot",
        ...existingTestFiles([
          "scripts/setup/codex-launcher.test.mjs",
          "scripts/setup/setup-regression.test.mjs",
          "scripts/setup/project-initialization.source.test.mjs",
        ]),
      ],
      reason:
        "complete verification exercises runtime isolation, non-destructive hook installation, and clean project initialization",
    }),
    verificationCommand({
      key: "verification-boundary-regressions",
      label: "verification boundary regressions",
      executable: process.execPath,
      args: [
        "--test",
        "--test-reporter=dot",
        "scripts/docs/document-scope.test.mjs",
        "scripts/repository/product-roots.test.mjs",
        "scripts/repository/source-inventory.test.mjs",
        "scripts/repository/stable-file-snapshot.test.mjs",
        "scripts/stack/stack-detector.test.mjs",
        "scripts/verify/adaptive-runner.test.mjs",
        "scripts/verify/adaptive-surfaces.test.mjs",
        "scripts/verify/api-security.test.mjs",
        "scripts/verify/format-project.test.mjs",
        "scripts/verify/git-remote-identity.test.mjs",
        "scripts/goals/goal-publication-precondition.test.mjs",
        "scripts/verify/path-hygiene.test.mjs",
        "scripts/verify/patterns.test.mjs",
        "scripts/verify/pushed-object-scan.test.mjs",
        "scripts/verify/secrets.test.mjs",
        "scripts/verify/image-assets.test.mjs",
        "scripts/verify/surface-quality.test.mjs",
        "scripts/web/update-sitemap-lastmod.test.mjs",
        "scripts/web/web-quality-scan.test.mjs",
      ],
      reason:
        "complete verification exercises pushed history, remote, API, stable source snapshots, active-source, documentation-scope, and layout-neutral surface boundaries",
    }),
    nodeCommand(
      "path-hygiene",
      "active-source path hygiene",
      "scripts/verify/path-hygiene.mjs",
      "complete verification checks active source paths without replaying unrelated commands",
    ),
    nodeCommand(
      "surface-quality",
      "stack and product surfaces",
      "scripts/verify/surface-quality.mjs",
      "one repository snapshot owns stack, web, accessibility, search, responsive, and image checks",
    ),
  ];

  const sourceBaselineScript = "scripts/verify/source-baseline.mjs";
  if (existsSync(path.join(root, sourceBaselineScript))) {
    commands.push(
      nodeCommand(
        "source-baseline",
        "clean reusable source baseline",
        sourceBaselineScript,
        "source-template verification refuses goals, slices, process history, generated exports, and project transaction state",
      ),
    );
  }

  commands.push(
    nodeCommand(
      "api-security",
      "API static boundary heuristic",
      "scripts/verify/api-security.mjs",
      "complete verification includes a static API boundary heuristic when API-like source exists",
    ),
    nodeCommand(
      "adaptive-regressions",
      "verification orchestration fixtures",
      "scripts/verify/adaptive.mjs",
      "complete verification exercises clean-full, routing, dedupe, workspace, and pushed-ref invariants",
      ["--self-test"],
    ),
    verificationCommand({
      key: "format",
      label: "formatting",
      executable: process.execPath,
      args: ["scripts/verify/format-project.mjs", "--check"],
      reason:
        "complete verification checks project formatting without traversing repository-root Codex runtime state",
    }),
  );

  return dedupeCommands(commands);
}

function loadWorkspaceManifest(repositoryRoot, packageDirectory) {
  const packagePath = path.join(packageDirectory, "package.json");
  if (!existsSync(packagePath) || lstatSync(packagePath).isSymbolicLink()) {
    throw new Error(
      `${normalizePath(path.relative(repositoryRoot, packagePath))} must be a real package manifest.`,
    );
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch {
    throw new Error(
      `${normalizePath(path.relative(repositoryRoot, packagePath))} contains invalid JSON.`,
    );
  }
  if (
    pkg.scripts !== undefined &&
    (pkg.scripts === null || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts))
  ) {
    throw new Error(
      `${normalizePath(path.relative(repositoryRoot, packagePath))} scripts must be an object.`,
    );
  }
  for (const [scriptName, command] of Object.entries(pkg.scripts ?? {})) {
    if (typeof command !== "string") {
      throw new Error(
        `${normalizePath(path.relative(repositoryRoot, packagePath))} script ${JSON.stringify(scriptName)} must be a string.`,
      );
    }
  }
  return {
    directory: normalizePath(path.relative(repositoryRoot, packageDirectory)) || ".",
    name: typeof pkg.name === "string" ? pkg.name : "",
    scripts: pkg.scripts ?? {},
  };
}

export function parsePnpmWorkspaceProjects(output, { repositoryRoot = root } = {}) {
  let projects;
  try {
    projects = JSON.parse(output);
  } catch {
    throw new Error("pnpm workspace graph output is not valid JSON.");
  }
  if (!Array.isArray(projects)) throw new Error("pnpm workspace graph output must be an array.");

  const lexicalRoot = path.resolve(repositoryRoot);
  const realRoot = realpathSync(lexicalRoot);
  const projectDirectories = new Set([realRoot]);
  for (const project of projects) {
    if (!project || typeof project.path !== "string" || !project.path.trim()) {
      throw new Error("pnpm workspace graph contains a project without a path.");
    }
    const lexicalPath = path.resolve(lexicalRoot, project.path);
    const lexicalRelative = path.relative(lexicalRoot, lexicalPath);
    if (
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(lexicalRelative)
    ) {
      throw new Error(`pnpm workspace project escapes the repository: ${project.path}`);
    }
    if (!existsSync(lexicalPath) || lstatSync(lexicalPath).isSymbolicLink()) {
      throw new Error(`pnpm workspace project must be a real directory: ${project.path}`);
    }
    let ancestor = lexicalPath;
    while (ancestor !== lexicalRoot) {
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(`pnpm workspace project has a symlinked path component: ${project.path}`);
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const realProject = realpathSync(lexicalPath);
    const resolvedRelative = path.relative(realRoot, realProject);
    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelative)
    ) {
      throw new Error(`pnpm workspace project resolves outside the repository: ${project.path}`);
    }
    projectDirectories.add(realProject);
  }

  return [...projectDirectories]
    .map((packageDirectory) => loadWorkspaceManifest(realRoot, packageDirectory))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

export function discoverWorkspaceManifests() {
  const result = spawnSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "error" },
    input: "",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || "Unable to read the pnpm workspace graph.");
  }
  return parsePnpmWorkspaceProjects(result.stdout);
}

function recursivelyDelegatesLifecycle(command, scriptName) {
  if (typeof command !== "string") return false;
  const escapedScript = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    /\bpnpm\b[^\n]*(?:\s-r(?:\s|$)|--recursive\b)/.test(command) &&
    new RegExp(`(?:\\brun\\s+)?${escapedScript}(?:\\s|$)`).test(command)
  );
}

function delegatesToManagedVerification(command) {
  return (
    typeof command === "string" &&
    /(?:^|&&|;)\s*(?:bash|node)\s+scripts\/verify\/|\bpnpm\s+verify(?::[a-z-]+)?\b/.test(command)
  );
}

export function workspaceLifecycleCommands(manifests = discoverWorkspaceManifests()) {
  const commands = [];
  const lifecycleOrder = [
    "lint",
    "build",
    "typecheck",
    "test",
    "test:unit",
    "test:integration",
    "test:e2e",
  ];

  for (const scriptName of lifecycleOrder) {
    const owners = manifests.filter(
      (manifest) =>
        manifest.scripts?.[scriptName] &&
        !recursivelyDelegatesLifecycle(manifest.scripts[scriptName], scriptName) &&
        !delegatesToManagedVerification(manifest.scripts[scriptName]),
    );
    if (owners.length === 0) continue;
    const filters = owners.flatMap((manifest) => {
      const selector = manifest.directory === "." ? "." : `./${manifest.directory}`;
      if (/[*?[\]{}!]/.test(selector)) {
        throw new Error(
          `Workspace path ${JSON.stringify(manifest.directory)} contains pnpm filter metacharacters and cannot be selected exactly.`,
        );
      }
      return ["--filter", selector];
    });
    commands.push(
      verificationCommand({
        key: `workspace:${scriptName}`,
        label: `project lifecycle ${scriptName}`,
        executable: "pnpm",
        args: ["--recursive", ...filters, "--if-present", "run", scriptName],
        reason: `${owners.length} project(s) in the pnpm workspace graph expose ${scriptName}; explicit filters include root and arbitrary workspace layouts without running non-owners`,
        phase: "workspace",
      }),
    );
  }

  return dedupeCommands(commands);
}

function commandsByKey(commands) {
  return new Map(commands.map((command) => [command.key, command]));
}

function selectCommands(available, keys) {
  return keys.map((key) => available.get(key)).filter(Boolean);
}

function targetedReadOnlyCommands(classifiedPaths) {
  const allCommands = completeVerificationCommands();
  const available = commandsByKey(allCommands);
  const keys = new Set();
  const hasCategory = (category) =>
    classifiedPaths.some((entry) => entry.categories.includes(category));

  if (hasCategory("active documentation")) {
    for (const key of ["docs", "secrets", "language", "path-hygiene"]) {
      keys.add(key);
    }
  }
  if (hasCategory("script catalog")) keys.add("scripts");
  if (hasCategory("context source-policy surface") || hasCategory("context workflow")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "context-policy",
      "context-regressions",
      "verification-boundary-regressions",
      "patterns",
    ]) {
      keys.add(key);
    }
  }
  if (hasCategory("dependency workflow")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "dependencies",
      "dependency-regressions",
      "patterns",
    ]) {
      keys.add(key);
    }
  }
  if (hasCategory("setup workflow")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "codex-config",
      "setup-regressions",
      "secrets",
      "path-hygiene",
      "patterns",
    ]) {
      keys.add(key);
    }
  }
  if (hasCategory("stack workflow")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "surface-quality",
      "verification-boundary-regressions",
      "patterns",
    ]) {
      keys.add(key);
    }
  }
  if (hasCategory("web workflow")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "surface-quality",
      "verification-boundary-regressions",
      "patterns",
    ]) {
      keys.add(key);
    }
  }
  if (hasCategory("image quality surface") || hasCategory("image asset surface")) {
    keys.add("surface-quality");
    keys.add("verification-boundary-regressions");
  }
  if (hasCategory("project Codex config") || hasCategory("Codex runtime boundary")) {
    for (const key of ["codex-config", "secrets", "path-hygiene"]) keys.add(key);
  }
  if (hasCategory("repo-local skill source") || hasCategory("skill path boundary")) {
    for (const key of ["skills", "secrets", "language", "path-hygiene"]) keys.add(key);
  }
  if (hasCategory("repo-local skill executable source")) keys.add("syntax-lint");
  if (hasCategory("verification orchestration")) {
    for (const key of [
      "syntax-lint",
      "scripts",
      "repository-smoke",
      "patterns",
      "adaptive-regressions",
    ]) {
      keys.add(key);
    }
  }
  const routeCategories = [...new Set(classifiedPaths.flatMap((entry) => entry.categories))].join(
    ", ",
  );
  return dedupeCommands(
    selectCommands(available, [...keys]).map((command) => ({
      ...command,
      reason: `targeted development feedback for ${routeCategories}`,
    })),
  );
}

export function buildPlan(options, dependencies = {}) {
  const gitAvailable = dependencies.gitAvailable ?? insideGitWorktree();
  const changed = dependencies.changedPaths
    ? { paths: dependencies.changedPaths, incomplete: false, reason: "injected fixture paths" }
    : options.simulatedPaths.length > 0
      ? { paths: options.simulatedPaths, incomplete: false, reason: "simulated --path input" }
      : ["full", "pre-push"].includes(options.mode)
        ? {
            paths: [],
            incomplete: false,
            reason: `${options.mode} mode does not need path routing`,
          }
        : gitAvailable
          ? changedPathsFromGit()
          : { paths: [], incomplete: true, reason: "no Git worktree detected" };
  const productLayout =
    dependencies.productLayout ??
    discoverProductLayout({ repositoryRoot: root, relativePaths: listActiveFiles({ root }) });
  const classificationOptions = { productLayout };
  const classifiedPaths = changed.paths.map((filePath) => ({
    path: filePath,
    categories: classifyPath(filePath, classificationOptions),
  }));
  const completeTriggerPaths = classifiedPaths
    .filter((entry) => {
      if (entry.categories.some((category) => completeRiskCategories.has(category))) return true;
      if (!entry.categories.includes("framework scripts")) return false;
      return !entry.categories.some((category) => ownedFrameworkCategories.has(category));
    })
    .map((entry) => entry.path);
  const triggerSummary = `${completeTriggerPaths.slice(0, 5).join(", ")}${
    completeTriggerPaths.length > 5 ? `, and ${completeTriggerPaths.length - 5} more` : ""
  }`;

  const complete =
    options.mode === "full" ||
    options.mode === "pre-push" ||
    changed.incomplete ||
    completeTriggerPaths.length > 0;
  const reason = ["full", "pre-push"].includes(options.mode)
    ? `${options.mode} mode always runs the complete deterministic command plan`
    : changed.incomplete
      ? `changed-path scope is incomplete (${changed.reason})`
      : completeTriggerPaths.length > 0
        ? `complete-risk paths changed: ${triggerSummary}`
        : changed.paths.length === 0
          ? "no changed paths need focused development feedback; full and CI remain complete"
          : "known low-risk paths use targeted development feedback; full and CI remain complete";

  const readOnlyCommands = complete
    ? completeVerificationCommands()
    : targetedReadOnlyCommands(classifiedPaths);
  const workspaceCommands = complete
    ? workspaceLifecycleCommands(dependencies.workspaceManifests)
    : [];

  return {
    options,
    gitAvailable,
    changed,
    classifiedPaths,
    completeTriggerPaths,
    verificationScope: complete ? "complete" : "targeted feedback",
    reason,
    readOnlyCommands: dedupeCommands(readOnlyCommands),
    workspaceCommands: dedupeCommands(workspaceCommands),
  };
}
