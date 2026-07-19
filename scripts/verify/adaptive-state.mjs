import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  discoverProductLayout,
  isProductImplementationPath,
  isProductSurfacePath,
} from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(scriptDir, "..", "..");

const imageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const executableSkillExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
]);
const applicationSourceExtensions = new Set([
  ...executableSkillExtensions,
  ".astro",
  ".css",
  ".htm",
  ".html",
  ".mdx",
  ".scss",
  ".svelte",
  ".vue",
]);

export function unique(values) {
  return [...new Set(values)];
}

export function normalizePath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .trim();
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input: options.input ?? "",
    stdio: options.stdio ?? "pipe",
    env: { ...process.env, ...options.env },
  });
  if (result.error) {
    if (options.allowFailure) return null;
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.allowFailure) return null;
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(output || `${command} ${args.join(" ")} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}

function git(args, options = {}) {
  return run("git", args, options);
}

export function insideGitWorktree() {
  return git(["rev-parse", "--is-inside-work-tree"], { allowFailure: true })?.trim() === "true";
}

export function parsePorcelainStatus(output) {
  const paths = new Set();
  const fields = String(output ?? "").split("\0");

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== " ") {
      throw new Error("Git status emitted an unsupported porcelain record.");
    }

    const status = field.slice(0, 2);
    const currentPath = normalizePath(field.slice(3));
    if (currentPath) paths.add(currentPath);

    if (/[RC]/.test(status)) {
      const originalPath = normalizePath(fields[++index] ?? "");
      if (!originalPath) throw new Error("Git status emitted an incomplete rename/copy record.");
      paths.add(originalPath);
    }
  }

  return [...paths].sort();
}

export function changedPathsFromGit() {
  const output = git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"],
    { allowFailure: true },
  );
  if (output === null) {
    return { paths: [], incomplete: true, reason: "git status --porcelain=v1 -z" };
  }
  try {
    return { paths: parsePorcelainStatus(output), incomplete: false, reason: "" };
  } catch (error) {
    return { paths: [], incomplete: true, reason: error.message };
  }
}

function isGeneratedOrLocal(filePath) {
  return (
    filePath.startsWith(".git/") ||
    filePath.startsWith(".context-index/") ||
    filePath.startsWith("node_modules/") ||
    filePath.includes("/node_modules/") ||
    filePath.startsWith("dist/") ||
    filePath.includes("/dist/") ||
    filePath.startsWith("build/") ||
    filePath.includes("/build/") ||
    filePath.startsWith(".next/") ||
    filePath.includes("/.next/") ||
    filePath.endsWith(".tsbuildinfo") ||
    filePath.startsWith("playwright-report/") ||
    filePath.includes("/playwright-report/") ||
    filePath.startsWith("test-results/") ||
    filePath.includes("/test-results/")
  );
}

function isActiveDocumentation(filePath) {
  return (
    filePath === "AGENTS.md" ||
    filePath === "README.md" ||
    filePath === "instructions.md" ||
    filePath.startsWith("docs/") ||
    filePath.endsWith(".md") ||
    filePath.endsWith(".mdx") ||
    filePath.endsWith(".txt")
  );
}

function isContextPolicy(filePath) {
  return (
    filePath === "AGENTS.md" ||
    filePath === "README.md" ||
    filePath === "instructions.md" ||
    filePath === "docs/context-index.md" ||
    filePath.startsWith(".agents/skills/context-retrieval/") ||
    filePath === ".agents/skills/project-implementation/SKILL.md" ||
    filePath === ".agents/skills/resume-project/SKILL.md" ||
    /^\.codex\/agents\/(?:default|explorer|worker)\.toml$/.test(filePath) ||
    filePath.startsWith("scripts/context/") ||
    filePath === "scripts/verify/context-source-policy.mjs"
  );
}

function isImageQualityPolicy(filePath) {
  return (
    filePath === "instructions.md" ||
    filePath.startsWith(".agents/skills/generated-image-quality-review/") ||
    filePath === "scripts/verify/image-assets.mjs"
  );
}

function isCodexRuntimeConfig(filePath) {
  return (
    filePath === ".codex/config.toml" ||
    filePath === ".codex/hooks.json" ||
    filePath === ".codex/README.md" ||
    /^\.codex\/agents\/[a-z][a-z0-9_-]*\.toml$/.test(filePath)
  );
}

function isCodexRuntimeBoundary(filePath) {
  return filePath === ".codex" || filePath.startsWith(".codex/");
}

function isCodexSystemSkillCache(filePath) {
  return filePath === ".codex/skills/.system" || filePath.startsWith(".codex/skills/.system/");
}

export function isCodexSkillsBoundary(filePath) {
  return filePath === ".codex/skills" || filePath.startsWith(".codex/skills/");
}

function isRepoLocalSkill(filePath) {
  return filePath.startsWith(".agents/skills/");
}

function isRepoLocalSkillMetadata(filePath) {
  return isRepoLocalSkill(filePath) && filePath.endsWith("/agents/openai.yaml");
}

function isRepoLocalSkillExecutable(filePath) {
  return isRepoLocalSkill(filePath) && executableSkillExtensions.has(path.extname(filePath));
}

function isFrameworkScript(filePath) {
  return filePath.startsWith("scripts/") && !filePath.endsWith("/README.md");
}

function isDependencyFile(filePath) {
  return (
    filePath === "mise.lock" ||
    filePath === "mise.toml" ||
    filePath === "package.json" ||
    filePath.endsWith("/package.json") ||
    filePath === "pnpm-lock.yaml" ||
    filePath === "pnpm-workspace.yaml" ||
    filePath === "dependency-policy.json" ||
    /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lockb?)$/i.test(filePath)
  );
}

function isImageAsset(filePath, productLayout) {
  return (
    imageExtensions.has(path.extname(filePath).toLowerCase()) &&
    isProductSurfacePath(filePath, productLayout)
  );
}

function isAppRuntimeSource(filePath, productLayout) {
  return (
    (isProductImplementationPath(filePath, productLayout) &&
      applicationSourceExtensions.has(path.extname(filePath).toLowerCase())) ||
    isImageAsset(filePath, productLayout)
  );
}

function isInfrastructure(filePath) {
  return (
    filePath.startsWith("infra/") ||
    filePath.startsWith(".github/workflows/") ||
    /(^|\/)(?:dockerfile|compose\.ya?ml|docker-compose\.ya?ml|cloudbuild\.ya?ml|firebase\.json|\.firebaserc)$/i.test(
      filePath,
    ) ||
    /(^|\/)(?:tsconfig|vite\.config|next\.config|astro\.config|svelte\.config|nuxt\.config|wrangler)\b/i.test(
      filePath,
    )
  );
}

function isOperationsSurface(filePath) {
  if (isActiveDocumentation(filePath)) return false;
  const lower = filePath.toLowerCase();
  return (
    lower.includes("deploy") ||
    lower.includes("firebase") ||
    lower.includes("gcloud") ||
    lower.includes("cloud-auth") ||
    lower.includes("reauth") ||
    lower.includes("/auth/") ||
    /(^|[._/-])credential/i.test(filePath)
  );
}

export function classifyPath(inputPath, { productLayout } = {}) {
  const filePath = normalizePath(inputPath);
  const categories = [];
  const layout =
    productLayout ??
    discoverProductLayout({ repositoryRoot: root, relativePaths: listActiveFiles({ root }) });

  if (!filePath) return ["unknown or incomplete change scope"];
  if (isGeneratedOrLocal(filePath) || isCodexSystemSkillCache(filePath)) {
    categories.push("generated/cache/local-only files");
  }
  if (isActiveDocumentation(filePath)) categories.push("active documentation");
  if (isContextPolicy(filePath)) categories.push("context source-policy surface");
  if (isImageQualityPolicy(filePath)) categories.push("image quality surface");
  if (isCodexRuntimeConfig(filePath)) categories.push("project Codex config");
  if (isCodexRuntimeBoundary(filePath) && !isCodexRuntimeConfig(filePath)) {
    categories.push("Codex runtime boundary");
  }
  if (isCodexSkillsBoundary(filePath) && !isCodexSystemSkillCache(filePath)) {
    categories.push("skill path boundary");
  }
  if (isRepoLocalSkill(filePath)) categories.push("repo-local skill source");
  if (isRepoLocalSkillMetadata(filePath)) categories.push("repo-local skill metadata");
  if (isRepoLocalSkillExecutable(filePath)) {
    categories.push("repo-local skill executable source");
    categories.push("setup workflow");
  }
  if (isFrameworkScript(filePath)) categories.push("framework scripts");
  if (filePath.startsWith("scripts/verify/") || filePath === "scripts/git-hooks/pre-push") {
    categories.push("verification orchestration");
  }
  if (filePath.startsWith("scripts/context/")) categories.push("context workflow");
  if (filePath.startsWith("scripts/deps/")) categories.push("dependency workflow");
  if (filePath.startsWith("scripts/stack/")) categories.push("stack workflow");
  if (filePath.startsWith("scripts/web/")) categories.push("web workflow");
  if (filePath.startsWith("scripts/setup/")) categories.push("setup workflow");
  if (filePath === "scripts/README.md") categories.push("script catalog");
  if (isDependencyFile(filePath)) categories.push("dependency/package manager files");
  if (isAppRuntimeSource(filePath, layout)) categories.push("app/package/service/runtime source");
  if (isInfrastructure(filePath)) categories.push("infrastructure/runtime config");
  if (isImageAsset(filePath, layout)) categories.push("image asset surface");
  if (isOperationsSurface(filePath)) categories.push("deployment/auth/operations surface");

  if (categories.length === 0) categories.push("unknown or incomplete change scope");
  return unique(categories);
}

export function isFullRelevantPath(filePath, options) {
  const categories = classifyPath(filePath, options);
  return categories.some((category) =>
    [
      "app/package/service/runtime source",
      "dependency/package manager files",
      "framework scripts",
      "infrastructure/runtime config",
      "unknown or incomplete change scope",
    ].includes(category),
  );
}

const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function isZeroObjectId(value) {
  return objectIdPattern.test(value) && /^0+$/.test(value);
}

export function parsePrePushInput(input) {
  const entries = [];
  for (const [index, rawLine] of String(input ?? "")
    .split(/\r?\n/)
    .entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      throw new Error(`Pre-push ref line ${index + 1} must contain four fields.`);
    }
    const [localRef, localObject, remoteRef, remoteObject] = fields;
    if (!objectIdPattern.test(localObject) || !objectIdPattern.test(remoteObject)) {
      throw new Error(`Pre-push ref line ${index + 1} contains an invalid object ID.`);
    }
    entries.push({ localRef, localObject, remoteRef, remoteObject });
  }
  return entries;
}

export function validatePushedRefsAgainstHead(entries, { headObject, resolveCommit }) {
  if (!objectIdPattern.test(headObject) || isZeroObjectId(headObject)) {
    throw new Error("Current HEAD did not resolve to a valid commit object ID.");
  }

  const pushedCommits = new Set();
  for (const entry of entries) {
    if (isZeroObjectId(entry.localObject)) continue;
    const commitObject = resolveCommit(entry.localObject);
    if (!commitObject || !objectIdPattern.test(commitObject) || isZeroObjectId(commitObject)) {
      throw new Error(`Pushed object for ${entry.localRef} does not resolve to a commit.`);
    }
    if (commitObject.toLowerCase() !== headObject.toLowerCase()) {
      throw new Error(
        `Pushed ref ${entry.localRef} does not match the clean checked-out HEAD; check out that commit before pushing.`,
      );
    }
    pushedCommits.add(commitObject.toLowerCase());
  }

  return [...pushedCommits].sort();
}

export function validateCurrentCheckoutForPush(input) {
  if (!insideGitWorktree()) throw new Error("Pre-push verification requires a Git worktree.");

  const status = git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
    "--ignore-submodules=none",
  ]);
  if (status.length > 0) {
    throw new Error(
      "Pre-push verification requires a clean working tree so checks cannot substitute uncommitted content for the pushed commit.",
    );
  }

  const headObject = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const entries = parsePrePushInput(input);
  const pushedCommits =
    entries.length === 0
      ? [headObject.toLowerCase()]
      : validatePushedRefsAgainstHead(entries, {
          headObject,
          resolveCommit(objectId) {
            return git(["rev-parse", "--verify", `${objectId}^{commit}`], {
              allowFailure: true,
            })?.trim();
          },
        });

  return { directInvocation: entries.length === 0, headObject, pushedCommits };
}
