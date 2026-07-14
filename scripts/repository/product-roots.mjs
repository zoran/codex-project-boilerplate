import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

const discoveryFileNames = new Set([
  "AndroidManifest.xml",
  "build.gradle",
  "build.gradle.kts",
  "package.json",
  "pnpm-workspace.yaml",
  "settings.gradle",
  "settings.gradle.kts",
]);
const excludedDiscoveryDirectories = new Set([
  ".agents",
  ".cache",
  ".codex",
  ".context-index",
  ".git",
  ".next",
  ".pnpm-store",
  ".project-state",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "backup",
  "backups",
  "blob-report",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "target",
  "test-results",
  "vendor",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function normalizeProductPath(value) {
  const raw = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const normalized = path.posix.normalize(raw);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(raw) ||
    normalized.includes("\0")
  ) {
    return null;
  }
  return normalized;
}

function isInsidePath(parent, candidate, { allowSame = true } = {}) {
  if (parent === ".") return allowSame || candidate !== ".";
  return candidate === parent ? allowSame : candidate.startsWith(`${parent}/`);
}

function pathsOverlap(left, right) {
  return isInsidePath(left, right) || isInsidePath(right, left);
}

function realDirectoryState(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) return { exists: false, valid: false };
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      return { exists: true, valid: false };
    }
  }
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { exists: true, valid: false };
  const realRoot = realpathSync.native(root);
  const realPath = realpathSync.native(absolutePath);
  const relative = path.relative(realRoot, realPath);
  const inside = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  return { exists: true, valid: inside };
}

function isRealFile(root, relativePath) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  if (!existsSync(absolutePath)) return false;
  const stats = lstatSync(absolutePath);
  return !stats.isSymbolicLink() && stats.isFile();
}

function discoverDeclarationFiles(root) {
  const files = [];
  const pending = [{ absolutePath: root, relativePath: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current.relativePath &&
      existsSync(path.join(current.absolutePath, ".codex-context-index.json"))
    ) {
      continue;
    }
    for (const entry of readdirSync(current.absolutePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (!excludedDiscoveryDirectories.has(entry.name)) {
          pending.push({
            absolutePath: path.join(current.absolutePath, entry.name),
            relativePath,
          });
        }
      } else if (entry.isFile() && discoveryFileNames.has(entry.name)) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function normalizedFiles(root, relativePaths) {
  const candidates = relativePaths ?? discoverDeclarationFiles(root);
  return [...new Set(candidates.map(normalizeProductPath).filter(Boolean))].sort();
}

function readProjectText(root, relativePath, readText) {
  if (readText) return readText(relativePath);
  return readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
}

export function pnpmWorkspacePatterns(content) {
  const patterns = [];
  let inPackages = false;
  for (const line of String(content ?? "").split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const match = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) patterns.push(value);
  }
  return patterns;
}

function matchesWorkspacePattern(packageRoot, patterns) {
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  const negative = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    positive.some((pattern) => path.matchesGlob(packageRoot, pattern)) &&
    !negative.some((pattern) => path.matchesGlob(packageRoot, pattern))
  );
}

function gradleModules(content) {
  const modules = new Set();
  const includeExpressions = [
    ...String(content ?? "").matchAll(/\binclude\s*\(([^)]*)\)/gs),
    ...String(content ?? "").matchAll(/^\s*include\s+(.+)$/gm),
  ];
  for (const expression of includeExpressions) {
    for (const match of String(expression[1] ?? "").matchAll(/["'](:[^"']+)["']/g)) {
      const modulePath = match[1].slice(1).replaceAll(":", "/");
      const normalized = normalizeProductPath(modulePath);
      if (normalized) modules.add(normalized);
    }
  }
  return [...modules].sort();
}

function unit({ root, sourceRoot, kind, declaredBy }) {
  return {
    root,
    sourceRoots: [sourceRoot],
    surfaceRoot: root === "." ? sourceRoot : root,
    kind,
    declaredBy,
  };
}

export function discoverProductLayout({
  repositoryRoot: root = repositoryRoot,
  relativePaths,
  readText,
} = {}) {
  const realRoot = realpathSync.native(root);
  const files = normalizedFiles(realRoot, relativePaths);
  const fileSet = new Set(files);
  const findings = [];
  const unitsByRoot = new Map([
    [".", unit({ root: ".", sourceRoot: "src", kind: "default", declaredBy: "project policy" })],
  ]);

  const defaultState = realDirectoryState(realRoot, "src");
  if (!defaultState.exists) findings.push("src: required default product root is missing");
  else if (!defaultState.valid) findings.push("src: default product root must be a real directory");

  const workspacePath = "pnpm-workspace.yaml";
  const patterns =
    fileSet.has(workspacePath) && isRealFile(realRoot, workspacePath)
      ? pnpmWorkspacePatterns(readProjectText(realRoot, workspacePath, readText))
      : [];
  if (patterns.length > 0) {
    for (const manifestPath of files.filter((filePath) => filePath.endsWith("/package.json"))) {
      const packageRoot = path.posix.dirname(manifestPath);
      if (!matchesWorkspacePattern(packageRoot, patterns) || !isRealFile(realRoot, manifestPath)) {
        continue;
      }
      const sourceRoot = `${packageRoot}/src`;
      const state = realDirectoryState(realRoot, sourceRoot);
      if (!state.exists) continue;
      if (!state.valid) {
        findings.push(`${sourceRoot}: workspace product root must be a real directory`);
        continue;
      }
      unitsByRoot.set(
        packageRoot,
        unit({ root: packageRoot, sourceRoot, kind: "workspace", declaredBy: manifestPath }),
      );
    }
  }

  for (const settingsPath of ["settings.gradle", "settings.gradle.kts"]) {
    if (!fileSet.has(settingsPath) || !isRealFile(realRoot, settingsPath)) continue;
    const settings = readProjectText(realRoot, settingsPath, readText);
    for (const moduleRoot of gradleModules(settings)) {
      const buildManifest = [`${moduleRoot}/build.gradle.kts`, `${moduleRoot}/build.gradle`].find(
        (candidate) => fileSet.has(candidate) && isRealFile(realRoot, candidate),
      );
      const androidManifest = `${moduleRoot}/src/main/AndroidManifest.xml`;
      if (
        !buildManifest ||
        !fileSet.has(androidManifest) ||
        !isRealFile(realRoot, androidManifest)
      ) {
        continue;
      }
      const sourceRoot = `${moduleRoot}/src/main`;
      const state = realDirectoryState(realRoot, sourceRoot);
      if (!state.valid) {
        findings.push(`${sourceRoot}: Android product root must be a real directory`);
        continue;
      }
      unitsByRoot.set(
        moduleRoot,
        unit({ root: moduleRoot, sourceRoot, kind: "android", declaredBy: buildManifest }),
      );
    }
  }

  const units = [...unitsByRoot.values()].sort(
    (left, right) => left.root.localeCompare(right.root) || left.kind.localeCompare(right.kind),
  );
  return {
    units,
    sourceRoots: units.flatMap((entry) => entry.sourceRoots).sort(),
    findings: [...new Set(findings)].sort(),
  };
}

export function productUnitForPath(value, layout, { surface = false } = {}) {
  const relativePath = normalizeProductPath(value);
  if (!relativePath) return null;
  const candidates = layout.units.filter((entry) => {
    const roots = surface ? [entry.surfaceRoot] : entry.sourceRoots;
    return roots.some((rootPath) => isInsidePath(rootPath, relativePath));
  });
  return (
    candidates.sort(
      (left, right) =>
        right.surfaceRoot.length - left.surfaceRoot.length || left.root.localeCompare(right.root),
    )[0] ?? null
  );
}

export function productSourceRootForPath(value, layout, { surface = false } = {}) {
  const relativePath = normalizeProductPath(value);
  const owner = productUnitForPath(relativePath, layout, { surface });
  if (!owner) return null;
  return (
    owner.sourceRoots
      .filter((rootPath) => isInsidePath(rootPath, relativePath))
      .sort((left, right) => right.length - left.length)[0] ?? owner.sourceRoots[0]
  );
}

export function isProductImplementationPath(value, layout) {
  return Boolean(productUnitForPath(value, layout));
}

export function isProductSurfacePath(value, layout) {
  return Boolean(productUnitForPath(value, layout, { surface: true }));
}

export function overlappingProductRoots(value, layout) {
  const candidate = normalizeProductPath(value);
  if (!candidate) return [];
  const protectedRoots = layout.units.flatMap((entry) =>
    entry.root === "." ? entry.sourceRoots : [entry.root],
  );
  return [
    ...new Set(protectedRoots.filter((rootPath) => pathsOverlap(rootPath, candidate))),
  ].sort();
}
