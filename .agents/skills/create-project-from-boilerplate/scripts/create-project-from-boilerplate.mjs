#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { portableFileMode } from "../../../../scripts/repository/portable-file-mode.mjs";
import {
  isManagedMarkdownPath,
  listManagedMarkdownFiles,
} from "../../../../scripts/docs/document-scope.mjs";
import { manifestAuthorityPreamble } from "../../../../scripts/docs/project-manifest-contract.mjs";
import { listPortableTransferFiles } from "../../../../scripts/repository/source-inventory.mjs";
import { ensureProductSourceBoundary } from "../../../../scripts/setup/stage-project-export.mjs";
import {
  neutralProductSourceFindings,
  productSourceBoundaryFindings,
} from "../../../../scripts/verify/path-hygiene.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = path.resolve(scriptDirectory, "..", "..", "..", "..");
const tick = String.fromCharCode(96);
const sourceOnlyPaths = new Set([
  ".agents/skills/create-project-from-boilerplate",
  ".agents/skills/reset-boilerplate",
  "scripts/setup/project-initialization.source.test.mjs",
  "scripts/verify/source-baseline.mjs",
]);
const excludedTopDirectories = new Set([".github"]);
const generatedProjectDocuments = new Set([
  "AGENTS.md",
  "README.md",
  "docs/project.md",
  "instructions.md",
]);
const requiredPortableContractFiles = new Set([
  "mise.lock",
  "mise.toml",
  "scripts/repository/product-roots.mjs",
  "scripts/repository/product-roots.test.mjs",
  "scripts/web/update-sitemap-lastmod.test.mjs",
]);

function fail(message) {
  throw new Error(message);
}

function usage() {
  return [
    "Usage:",
    "  mise exec --locked -- node .agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
    '    --name "<Project Name>" [--directory <project-folder>] [--output-parent <path>] [--include-untracked]',
  ].join("\n");
}

function optionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(optionName + " requires a value.");
  return value;
}

function parseArgs(argv) {
  const options = {
    directory: "",
    help: false,
    includeUntracked: false,
    name: "",
    outputParent: "",
    skipVerify: false,
    source: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--include-untracked") options.includeUntracked = true;
    else if (argument === "--skip-verify") options.skipVerify = true;
    else if (argument.startsWith("--name=")) options.name = argument.slice(7);
    else if (argument === "--name") {
      options.name = optionValue(argv, index, "--name");
      index += 1;
    } else if (argument.startsWith("--directory=")) options.directory = argument.slice(12);
    else if (argument === "--directory") {
      options.directory = optionValue(argv, index, "--directory");
      index += 1;
    } else if (argument.startsWith("--source=")) options.source = argument.slice(9);
    else if (argument === "--source") {
      options.source = optionValue(argv, index, "--source");
      index += 1;
    } else if (argument.startsWith("--output-parent=")) options.outputParent = argument.slice(16);
    else if (argument === "--output-parent") {
      options.outputParent = optionValue(argv, index, "--output-parent");
      index += 1;
    } else if (!argument.startsWith("--") && !options.name) options.name = argument;
    else fail("Unknown argument: " + argument);
  }
  return options;
}

function normalizedName(value) {
  const name = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!name) fail('A project name is required. Pass --name "<Project Name>".');
  if (/[\u0000-\u001f\u007f]/u.test(name)) fail("Project name contains a control character.");
  return name;
}

function slugify(value, label) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    fail(label + " could not be derived safely; provide --directory explicitly.");
  }
  return slug;
}

function directoryName(value) {
  const name = String(value).trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    name === "." ||
    name === ".." ||
    /[\/\\]/.test(name)
  ) {
    fail("Directory must be one safe path segment.");
  }
  return name;
}

function defaultDirectoryName(projectName) {
  try {
    return directoryName(projectName);
  } catch {
    return slugify(projectName, "directory name");
  }
}

function isStrictDescendant(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requiredRealDirectory(value, label) {
  if (!existsSync(value)) fail("Missing " + label + ": " + value);
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(label + " must be a real directory: " + value);
  }
  return realpathSync(value);
}

function defaultOutputParent(sourceRoot) {
  const sourceParent = path.dirname(sourceRoot);
  return path.basename(sourceRoot) === "code" ? path.dirname(sourceParent) : sourceParent;
}

function resolveRoots(options, projectDirectoryName) {
  const sourceRoot = requiredRealDirectory(
    path.resolve(options.source || defaultSourceRoot),
    "source repository",
  );
  const outputParent = requiredRealDirectory(
    path.resolve(options.outputParent || defaultOutputParent(sourceRoot)),
    "output parent",
  );
  const projectRoot = path.join(outputParent, projectDirectoryName);
  const targetRoot = path.join(projectRoot, "code");
  if (existsSync(projectRoot)) fail("Target project directory already exists: " + projectRoot);
  if (
    projectRoot === sourceRoot ||
    isStrictDescendant(projectRoot, sourceRoot) ||
    isStrictDescendant(sourceRoot, projectRoot)
  ) {
    fail("Source and target must be separate sibling workspaces.");
  }
  return { sourceRoot, outputParent, projectRoot, targetRoot };
}

function runGit(root, args, label) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    input: Buffer.alloc(0),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = result.error?.message ?? `status ${result.status}`;
    fail(`${label} failed (${detail}).`);
  }
  return result.stdout;
}

function captureSourceGitState(sourceRoot) {
  const gitRoot = runGit(sourceRoot, ["rev-parse", "--show-toplevel"], "Source Git root probe")
    .toString("utf8")
    .trim();
  if (!gitRoot || realpathSync(gitRoot) !== sourceRoot) {
    fail("Source repository must be the root of a real Git worktree.");
  }
  return runGit(
    sourceRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
    "Source Git state capture",
  );
}

function assertSourceGitStateUnchanged(sourceRoot, before) {
  const after = captureSourceGitState(sourceRoot);
  if (!after.equals(before)) {
    fail(
      "Source boilerplate changed during project creation; staging was discarded and no project was published.",
    );
  }
}

function assertSourceBaselineClean(sourceRoot) {
  const resetScript = path.join(
    sourceRoot,
    ".agents",
    "skills",
    "reset-boilerplate",
    "scripts",
    "reset-boilerplate.mjs",
  );
  if (!existsSync(resetScript) || lstatSync(resetScript).isSymbolicLink()) {
    fail("Source repository is missing the real boilerplate reset boundary.");
  }
  const result = spawnSync(process.execPath, [resetScript, "--root", sourceRoot], {
    cwd: sourceRoot,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(
      "Source boilerplate baseline is not clean. Review the reset preview and run `pnpm boilerplate:reset --apply` before creating a project." +
        (detail ? `\n${detail}` : ""),
    );
  }
}

function assertSourceProductBoundaryClean(sourceRoot) {
  const findings = neutralProductSourceFindings({ repositoryRoot: sourceRoot });
  if (findings.length > 0) {
    fail(`Source boilerplate product boundary is not neutral: ${findings.join(", ")}`);
  }
}

function posixRelative(root, fullPath) {
  return path.relative(root, fullPath).split(path.sep).join("/");
}

function isSourceOnly(relativePath) {
  for (const excludedPath of sourceOnlyPaths) {
    if (relativePath === excludedPath || relativePath.startsWith(excludedPath + "/")) return true;
  }
  return false;
}

function shouldSkip(relativePath) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => excludedTopDirectories.has(segment))) return true;
  if (isSourceOnly(relativePath)) return true;
  if (isManagedMarkdownPath(relativePath) && !generatedProjectDocuments.has(relativePath)) {
    return true;
  }
  return false;
}

function copyTree(sourceRoot, targetRoot, { includeUntracked }) {
  mkdirSync(targetRoot, { recursive: true });
  const transferFiles = new Set(listPortableTransferFiles({ root: sourceRoot, includeUntracked }));
  for (const relativePath of requiredPortableContractFiles) {
    if (existsSync(path.join(sourceRoot, relativePath))) transferFiles.add(relativePath);
  }
  for (const relativePath of [...transferFiles].sort()) {
    if (shouldSkip(relativePath)) continue;
    const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
    const targetPath = path.join(targetRoot, ...relativePath.split("/"));
    const stats = lstatSync(sourcePath);
    if (stats.isFile()) {
      mkdirSync(path.dirname(targetPath), { recursive: true });
      copyFileSync(sourcePath, targetPath);
      chmodSync(targetPath, portableFileMode(sourcePath));
    }
  }
}

function markdown(lines) {
  return lines.join("\n") + "\n";
}

function escapeMarkdownText(value) {
  return String(value).replace(/[\\`*_{}\[\]<>()#+!|]/g, "\\$&");
}

function writeRelative(targetRoot, relativePath, content) {
  const targetPath = path.join(targetRoot, ...relativePath.split("/"));
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
}

function writeIdentityDocs(targetRoot, projectName) {
  const fence = tick.repeat(3);
  const displayName = escapeMarkdownText(projectName);
  writeRelative(
    targetRoot,
    "AGENTS.md",
    markdown([
      "# AGENTS.md",
      "",
      "## Entry-Point Guardrails",
      "",
      "This is a code-first Codex project. `instructions.md` owns the complete agent workflow; the",
      "root README owns setup and use; `docs/project.md` owns durable project truth; and optional",
      "`docs/project-context.md` holds only bounded current work. Read them, then inspect task-relevant",
      "source and tests. Current files and command output outrank remembered context.",
      "",
      "Treat root `src/` as the required default Product Root. A real declared pnpm package activates",
      "`<unit>/src`; an evidenced Android Gradle module activates `<module>/src/main`. Arbitrary folders",
      "do not activate. Create or import a requested web application as a declared package when needed,",
      "rather than pre-creating an empty `apps/web`.",
      "",
      "Keep `.codex`, `.agents`, agent instructions, process state, and other Codex tooling outside every",
      "product unit. Repo-wide vector state is fixed at ignored root `.context-index/`. `pnpm setup`",
      "is complete only after that vector space is current and passes its database smoke search.",
      "",
      "Keep normal plans, progress, reviews, and handoffs in the conversation. Complex multi-session",
      "work may use one bounded, overwritten project-context file for the current goal and slice; it",
      "cannot override the manifest or become a diary or archive. Add docs only for a real durable",
      "contract; normal work should produce implementation and tests.",
      "",
      "Fix root causes at the owning boundary, keep secrets and machine-local state out of Git, run",
      "focused checks while iterating, and run `mise exec --locked -- pnpm verify` once before handoff.",
    ]),
  );
  writeRelative(
    targetRoot,
    "README.md",
    markdown([
      "# " + displayName,
      "",
      "A code-first Codex project. Portable project policy is committed under `.codex/`; mutable",
      "installation, authentication, trust, sessions, logs, and caches stay in the user's Codex home.",
      "",
      "The repository root is the Codex and tooling workspace. Root `src/` is the default Product Root;",
      "real declared pnpm packages and evidenced Android modules may add contracted source roots.",
      "Requested web applications are created or imported as declared packages when needed. Project",
      "verification keeps Codex configuration, skills, instructions, process state, and the fixed root",
      "`.context-index/` vector space outside every product unit.",
      "",
      "Host prerequisites are the current user-level [Codex CLI](https://developers.openai.com/codex/cli/),",
      "[mise](https://mise.jdx.dev/installing-mise.html), Git, Bash, ripgrep, and ShellCheck.",
      "Codex can start before project dependencies are installed:",
      "",
      fence + "bash",
      'env -u NO_COLOR codex --cd "$PWD"',
      fence,
      "",
      "Install and run project tools separately through the checked-in mise configuration:",
      "",
      fence + "bash",
      "mise install --locked",
      "mise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts",
      "mise exec --locked -- pnpm setup",
      fence,
      "",
      "The final setup command creates and validates the local vector space at `.context-index/`.",
      "First use may download the pinned local embedding model. Setup reports the path, index/build",
      "statistics, and smoke-search result, and is incomplete if that bootstrap fails.",
      "",
      "Locked runtimes support Linux x64/arm64 (glibc and musl), macOS arm64, and Windows x64.",
      "Intel macOS is intentionally not supported because pnpm 11 has no Darwin x64 artifact.",
      "",
      "## Project Authority",
      "",
      "[Project Instructions](instructions.md) own the complete agent workflow. The always-read",
      "[Project Manifest](docs/project.md) owns durable project truth and cannot be replaced by memory,",
      "generated indexes, or optional working context. `docs/project-context.md`, when present, is only",
      "a bounded current-goal cache. Source, tests, and configuration remain implementation truth; keep",
      "normal planning and status in the conversation.",
      "",
      'Use `rg` for exact discovery and `mise exec --locked -- pnpm context:search -- "query"` for',
      "broad conceptual discovery. Use focused checks while iterating and",
      "`mise exec --locked -- pnpm verify` before handoff.",
    ]),
  );
  writeRelative(
    targetRoot,
    "instructions.md",
    markdown([
      "# Project Instructions",
      "",
      "This file is the single committed workflow authority. Other entry documents repeat only the",
      "guardrails needed to remain safe when opened alone; resolve workflow detail here.",
      "",
      "Normal development should primarily change product code, tests, and necessary configuration.",
      "The concise `docs/project.md` manifest is the central truth for intent, scope, system shape,",
      "constraints, and durable decisions.",
      "",
      "## Product Roots",
      "",
      "Root `src/` is the required default Product Root. A real package matched by",
      "`pnpm-workspace.yaml`, with its own `package.json` and `src/`, activates `<unit>/src`. A declared",
      "Android Gradle module with a build file, manifest, and `src/main/` activates that implementation",
      "root. Arbitrary folders do not activate. Create or import a requested web app as a declared",
      "package then; do not pre-create an empty `apps/web` in a neutral project.",
      "",
      "Keep `.codex`, `.agents`, `AGENTS.md`, process state, and other Codex tooling outside every",
      "product unit. The repo-wide semantic vector state is fixed at ignored root `.context-index/` and",
      "cannot be redirected into product source. Product verification shares this one roots contract.",
      "`pnpm setup` materializes and smoke-tests that vector space; later searches refresh it",
      "incrementally, while unrelated verification and pre-push remain read-only.",
      "",
      "## Workflow",
      "",
      "1. Read the README, manifest, and optional `docs/project-context.md`, then inspect relevant source,",
      "   tests, manifests, and configuration.",
      "2. Trust current files and command output over remembered context; keep normal preflight plans,",
      "   progress, reviews, and handoffs in the conversation.",
      "3. Fix the owning invariant, follow the detected stack, and add focused regression evidence.",
      "4. Run focused checks while iterating and the complete deterministic `pnpm verify` once before",
      "   handoff.",
      "",
      "## Compact Project Memory",
      "",
      "For complex work that must survive multiple sessions, maintain at most one",
      "`docs/project-context.md` with the current goal, one current slice, essential active decisions,",
      "blockers, and next actions. It cannot override the manifest. Keep it under 80 lines, 500 words,",
      "and 6 KiB; replace stale content, never append history, and delete it when the goal is complete.",
      "Do not create separate goal, slice, task, status, audit, review, or completion files or archives.",
      "",
      "## Documentation",
      "",
      "Update docs only when the user requested documentation, externally consumed usage/API/operations",
      "changed, or a durable project decision cannot be recovered from code, tests, configuration, or an",
      "existing canonical document. Keep the manifest under 100 lines, 700 words, and 8 KiB. Prefer the",
      "README or manifest; never create docs merely to record agent activity or prove a code change.",
      "",
      "## Safety",
      "",
      "Keep secrets, personal paths, local trust/runtime state, and private context out of Git. Preserve",
      "compatible user changes. Use specialized security or domain review only for surfaces that changed,",
      "and keep review output in the conversation.",
      "",
      'Use `rg` for exact discovery. Use `pnpm context:search -- "query"` only for a concrete conceptual',
      "or ownership question that exact search cannot answer, then read the returned source files directly.",
    ]),
  );
  writeRelative(
    targetRoot,
    "docs/project.md",
    markdown([
      "# Project Manifest",
      "",
      "This is the always-read, concise central source of durable project truth for " +
        displayName +
        ".",
      "",
      manifestAuthorityPreamble,
      "This manifest owns product intent, scope, system shape, constraints, and durable decisions.",
      "",
      "## Definition",
      "",
      "Project name: " + displayName,
      "",
      "Product definition: pending.",
      "",
      "## Users And Outcome",
      "",
      "- Target users: pending.",
      "- Problem and desired outcome: pending.",
      "- Success evidence: pending.",
      "",
      "## Scope",
      "",
      "- In scope: pending.",
      "- Non-goals: do not infer a stack, provider, deployment target, data model, or trust boundary.",
      "",
      "## System Shape",
      "",
      "- Key domains and ownership boundaries: pending.",
      "- External systems and data flows: pending.",
      "- Runtime and delivery shape: pending.",
      "",
      "## Constraints And Decisions",
      "",
      "- Keep this manifest concise and update it before implementation depends on a new assumption.",
      "- Portable Codex policy belongs under `.codex/`; mutable user state stays in the user's Codex home.",
      "- Root `src/` is the default Product Root; declared pnpm packages and evidenced Android modules",
      "  may add contracted source roots, while arbitrary folders do not.",
      "- Create or import a requested web app as a declared workspace package when needed; do not keep",
      "  an empty `apps/web` in a neutral project.",
      "- Codex policy, skills, instructions, process state, and fixed root `.context-index/` vector state",
      "  remain outside every product unit and outside generated or exported portable source.",
      "- Record durable product, architecture, security, integration, and delivery decisions before use.",
      "",
      "## Maintenance",
      "",
      "Replace pending entries when the user defines the project. Keep active truth only within 100",
      "lines, 700 words, and 8 KiB; update entries instead of appending history. Keep plans, progress,",
      "reviews, and implementation detail out.",
    ]),
  );
}

function updatePackage(targetRoot, packageName) {
  const packagePath = path.join(targetRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.name = packageName;
  delete packageJson.scripts["boilerplate:reset"];
  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + "\n", "utf8");

  const exportPath = path.join(targetRoot, "scripts/setup/export-project.sh");
  const exportScript = readFileSync(exportPath, "utf8").replaceAll("codex-project", packageName);
  writeFileSync(exportPath, exportScript, "utf8");
}

function runNode(root, relativeScript, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, relativeScript), ...args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(relativeScript + " failed to start: " + result.error.message);
  if (result.status !== 0) fail(relativeScript + " failed with status " + result.status);
}

function formatGeneratedMarkdown(targetRoot) {
  const formatterPath = path.join(
    defaultSourceRoot,
    "node_modules",
    "prettier",
    "bin",
    "prettier.cjs",
  );
  if (!existsSync(formatterPath)) {
    fail(
      "Project initialization requires the boilerplate's installed formatter. Run mise install --locked and then mise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts first.",
    );
  }
  const result = spawnSync(
    process.execPath,
    [formatterPath, "--write", "AGENTS.md", "README.md", "docs/project.md", "instructions.md"],
    {
      cwd: targetRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (result.error) fail("Generated Markdown formatter failed to start: " + result.error.message);
  if (result.status !== 0) fail("Generated Markdown formatter failed with status " + result.status);
}

function assertClean(targetRoot, packageName) {
  for (const forbidden of [
    ".git",
    ".github",
    ".context-index",
    ".codex/runtime",
    "docs/planning",
    ".project-state",
    "node_modules",
    ".agents/skills/create-project-from-boilerplate",
    ".agents/skills/reset-boilerplate",
    "scripts/setup/project-initialization.source.test.mjs",
    "scripts/verify/source-baseline.mjs",
  ]) {
    if (existsSync(path.join(targetRoot, ...forbidden.split("/")))) {
      fail("Generated project contains forbidden state: " + forbidden);
    }
  }
  const forbiddenSegments = new Set([
    ".git",
    ".github",
    ".context-index",
    ".next",
    ".pnpm-store",
    ".project-state",
    "coverage",
    "node_modules",
    "playwright-report",
    "test-results",
  ]);
  const originHints = [];
  const pendingDirectories = [targetRoot];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = posixRelative(targetRoot, absolutePath);
      if (entry.isSymbolicLink()) fail(`Generated project contains a symlink: ${relativePath}`);
      if (entry.isFile()) {
        const content = readFileSync(absolutePath, "utf8");
        if (/\bboilerplate\b/i.test(content)) originHints.push(relativePath);
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (forbiddenSegments.has(entry.name)) {
        fail(`Generated project contains forbidden nested state: ${relativePath}`);
      }
      pendingDirectories.push(absolutePath);
    }
  }
  if (originHints.length > 0) {
    fail(`Generated project contains source-origin text: ${originHints.join(", ")}`);
  }
  const boundaryFindings = productSourceBoundaryFindings({ repositoryRoot: targetRoot });
  if (boundaryFindings.length > 0) {
    fail(`Generated project violates the Product Roots contract: ${boundaryFindings.join(", ")}`);
  }
  const codexEntries = readdirSync(path.join(targetRoot, ".codex")).sort();
  if (codexEntries.join("\n") !== ["README.md", "agents", "config.toml"].join("\n")) {
    fail(
      "Generated .codex directory must contain only portable config, agents, and documentation.",
    );
  }
  const agentEntries = readdirSync(path.join(targetRoot, ".codex", "agents")).sort();
  if (agentEntries.join("\n") !== ["default.toml", "explorer.toml", "worker.toml"].join("\n")) {
    fail("Generated project must retain the exact built-in subagent role overrides.");
  }
  const packageJson = JSON.parse(readFileSync(path.join(targetRoot, "package.json"), "utf8"));
  if (packageJson.name !== packageName) fail("Generated package name was not updated.");
  const projectDocuments = listManagedMarkdownFiles({ root: targetRoot });
  const expectedDocuments = [...generatedProjectDocuments].sort();
  if (projectDocuments.join("\n") !== expectedDocuments.join("\n")) {
    fail(
      `Generated project documentation must stay code-first and minimal. Expected ${expectedDocuments.join(", ")}; found ${projectDocuments.join(", ")}.`,
    );
  }
  const documentationLines = projectDocuments.reduce(
    (total, relativePath) =>
      total + readFileSync(path.join(targetRoot, relativePath), "utf8").split(/\r?\n/).length - 1,
    0,
  );
  if (documentationLines > 250) {
    fail(
      `Generated core documentation exceeds the 250-line baseline budget (${documentationLines}).`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const projectName = normalizedName(options.name);
  const projectDirectoryName = directoryName(
    options.directory || defaultDirectoryName(projectName),
  );
  const packageName = slugify(projectDirectoryName, "package name");
  const roots = resolveRoots(options, projectDirectoryName);
  const sourceGitState = captureSourceGitState(roots.sourceRoot);
  assertSourceBaselineClean(roots.sourceRoot);
  assertSourceProductBoundaryClean(roots.sourceRoot);
  const stagingProjectRoot = path.join(
    roots.outputParent,
    `.${projectDirectoryName}.staging-${process.pid}-${randomUUID()}`,
  );
  const stagingRoot = path.join(stagingProjectRoot, "code");
  let staged = false;
  let published = false;

  try {
    mkdirSync(stagingProjectRoot, { mode: 0o700 });
    staged = true;
    mkdirSync(stagingRoot, { mode: 0o700 });
    copyTree(roots.sourceRoot, stagingRoot, { includeUntracked: options.includeUntracked });
    ensureProductSourceBoundary(stagingRoot);
    writeIdentityDocs(stagingRoot, projectName);
    updatePackage(stagingRoot, packageName);
    formatGeneratedMarkdown(stagingRoot);
    runNode(stagingRoot, "scripts/setup/validate-staged-project.mjs", [stagingRoot]);
    assertClean(stagingRoot, packageName);
    if (!options.skipVerify) {
      runNode(stagingRoot, "scripts/verify/repository-smoke.mjs");
    }
    assertSourceBaselineClean(roots.sourceRoot);
    assertSourceProductBoundaryClean(roots.sourceRoot);
    assertSourceGitStateUnchanged(roots.sourceRoot, sourceGitState);
    if (existsSync(roots.projectRoot)) {
      fail("Target project directory appeared during project creation: " + roots.projectRoot);
    }
    renameSync(stagingProjectRoot, roots.projectRoot);
    staged = false;
    published = true;
    assertSourceBaselineClean(roots.sourceRoot);
    assertSourceProductBoundaryClean(roots.sourceRoot);
    assertSourceGitStateUnchanged(roots.sourceRoot, sourceGitState);
    published = false;
  } catch (error) {
    if (staged && existsSync(stagingProjectRoot)) {
      rmSync(stagingProjectRoot, { force: true, recursive: true });
    }
    if (published && existsSync(roots.projectRoot)) {
      rmSync(roots.projectRoot, { force: true, recursive: true });
    }
    throw error;
  }

  console.log("Created project: " + roots.targetRoot);
  console.log("Project name: " + projectName);
  console.log("Package name: " + packageName);
  console.log("Source boilerplate state remained unchanged and baseline-clean.");
  console.log(
    "The project has a clean default src Product Root, evidence-based unit contract, and no inherited Git history, GitHub metadata, planning history, context index, or user Codex state.",
  );
  console.log("Run pnpm setup in the generated project to create and validate .context-index/.");
}

try {
  main();
} catch (error) {
  console.error("Project creation failed: " + error.message);
  console.error(usage());
  process.exit(1);
}
