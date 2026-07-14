import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverProductLayout } from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";
import { classifyPath, isFullRelevantPath } from "./adaptive-state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];

function readRelative(relativePath) {
  const fullPath = path.join(root, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function requireContent(relativePath, expected) {
  const content = readRelative(relativePath);
  if (!content.includes(expected)) failures.push(`${relativePath} must include ${expected}`);
}

function validateMinimalMiseTools(content) {
  const versions = Object.create(null);
  const errors = [];
  let toolsSectionCount = 0;
  let inToolsSection = false;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[tools]") {
      toolsSectionCount += 1;
      inToolsSection = true;
      if (toolsSectionCount > 1) errors.push("must declare [tools] exactly once");
      continue;
    }
    if (line.startsWith("[")) {
      inToolsSection = false;
      errors.push(`line ${index + 1} declares a disallowed section or directive`);
      continue;
    }
    if (!inToolsSection) {
      errors.push(`line ${index + 1} defines a key outside [tools]`);
      continue;
    }
    const match = line.match(/^([a-z][a-z0-9_-]*)\s*=\s*"(\d+\.\d+\.\d+)"$/);
    if (!match) {
      errors.push(`line ${index + 1} is not a safe tool name with an exact semantic version pin`);
      continue;
    }
    const [, tool, version] = match;
    if (versions[tool]) errors.push(`${tool} must be declared exactly once`);
    else versions[tool] = version;
  }

  if (toolsSectionCount !== 1) errors.push("must declare [tools] exactly once");
  for (const tool of ["node", "pnpm"]) {
    if (!versions[tool]) errors.push(`must declare ${tool} exactly once`);
  }
  return { errors, versions };
}

const requiredFiles = [
  ".codex/README.md",
  ".codex/agents/default.toml",
  ".codex/agents/explorer.toml",
  ".codex/agents/worker.toml",
  ".codex/config.toml",
  ".gitignore",
  ".agents/skills/project-implementation/SKILL.md",
  ".agents/skills/task-quality/SKILL.md",
  "AGENTS.md",
  "README.md",
  "docs/project.md",
  "instructions.md",
  "mise.lock",
  "mise.toml",
  "package.json",
  "pnpm-workspace.yaml",
  "scripts/repository/product-roots.mjs",
  "scripts/repository/product-roots.test.mjs",
  "scripts/repository/source-inventory.mjs",
  "scripts/web/update-sitemap-lastmod.test.mjs",
  "scripts/setup/start-codex.sh",
  "scripts/setup/validate-codex-config.mjs",
  "scripts/setup/validate-codex-model-policy.mjs",
  "scripts/setup/validate-staged-project.mjs",
  "scripts/verify/adaptive.mjs",
];

for (const relativePath of requiredFiles) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) {
    failures.push(`missing required file: ${relativePath}`);
    continue;
  }
  const stats = lstatSync(fullPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    failures.push(`required file must be regular and non-symlink: ${relativePath}`);
  }
}

const activeFiles = listActiveFiles({ root });
const productLayout = discoverProductLayout({ repositoryRoot: root, relativePaths: activeFiles });
failures.push(...productLayout.findings);

let packageJson;
try {
  packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
} catch {
  failures.push("package.json must contain valid JSON");
}

if (packageJson) {
  if (packageJson.private !== true) failures.push("package.json must remain private");
  if (packageJson.type !== "module") failures.push('package.json type must be "module"');
  if (!/^pnpm@\d/.test(packageJson.packageManager ?? "")) {
    failures.push("package.json must pin pnpm through packageManager");
  }
  for (const scriptName of [
    "codex:start",
    "codex:validate",
    "context:check",
    "context:index",
    "context:search",
    "docs:check",
    "setup",
    "verify",
    "verify:changed",
    "verify:external",
    "verify:pre-push",
  ]) {
    if (!packageJson.scripts?.[scriptName]) failures.push(`missing package script: ${scriptName}`);
  }
  if (!packageJson.scripts?.["codex:start"]?.includes("scripts/setup/start-codex.sh")) {
    failures.push("codex:start must use the project launcher");
  }
  if (!packageJson.scripts?.setup?.includes("node scripts/context/index-codebase.mjs --setup")) {
    failures.push("setup must materialize and validate the root context vector space");
  }
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const hasLance = Boolean(dependencies["@lancedb/lancedb"]);
  const hasTransformers = Boolean(dependencies["@huggingface/transformers"]);
  if (hasLance !== hasTransformers) {
    failures.push("local retrieval dependencies must be installed or removed together");
  }
  if (
    packageJson.dependencies?.["@lancedb/lancedb"] ||
    packageJson.dependencies?.["@huggingface/transformers"]
  ) {
    failures.push("local retrieval packages belong in devDependencies");
  }
}

requireContent("scripts/context/index-codebase.mjs", "await verifyUsableIndex()");
requireContent("scripts/context/index-codebase.mjs", "Context vector space ready:");

const validMiseFixture = '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\n';
if (validateMinimalMiseTools(validMiseFixture).errors.length > 0) {
  failures.push("minimal mise.toml validator must accept the intended structure");
}
const extensibleMiseFixture =
  '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\npython = "3.14.0"\ngo = "1.26.0"\n';
if (validateMinimalMiseTools(extensibleMiseFixture).errors.length > 0) {
  failures.push("minimal mise.toml validator must permit safe exact project-specific tool pins");
}
for (const [name, fixture] of Object.entries({
  "backend expression":
    '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\npython = "ubi:example/tool@3.14.0"\n',
  "duplicate key": '[tools]\nnode = "1.2.3"\nnode = "1.2.4"\npnpm = "4.5.6"\n',
  "environment section": '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\n[env]\nFLAG = "1"\n',
  "floating version": '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\npython = "latest"\n',
  "hook section": '[tools]\nnode = "1.2.3"\npnpm = "4.5.6"\n[hooks]\npostinstall = "true"\n',
  "key outside tools": 'node = "1.2.3"\n[tools]\npnpm = "4.5.6"\n',
})) {
  if (validateMinimalMiseTools(fixture).errors.length === 0) {
    failures.push(`minimal mise.toml validator must reject fixture: ${name}`);
  }
}

const miseToml = readRelative("mise.toml");
const miseValidation = validateMinimalMiseTools(miseToml);
for (const error of miseValidation.errors) failures.push(`mise.toml ${error}`);
const miseVersions = miseValidation.versions;
if (
  packageJson &&
  miseVersions.pnpm &&
  packageJson.packageManager !== `pnpm@${miseVersions.pnpm}`
) {
  failures.push("mise.toml pnpm version must match package.json packageManager");
}

const miseLock = readRelative("mise.lock");
const lockedTools = [...miseLock.matchAll(/^\[\[tools\.([a-z0-9_-]+)\]\]$/gm)].map(
  ([, tool]) => tool,
);
const configuredTools = Object.keys(miseVersions);
if (
  new Set(lockedTools).size !== lockedTools.length ||
  [...lockedTools].sort().join(",") !== [...configuredTools].sort().join(",")
) {
  failures.push("mise.lock tool entries must match every configured mise.toml tool exactly once");
}

function lockedToolBlock(tool) {
  const marker = `[[tools.${tool}]]`;
  const start = miseLock.indexOf(marker);
  if (start < 0) return "";
  const next = miseLock.indexOf("\n[[tools.", start + marker.length);
  return miseLock.slice(start, next < 0 ? undefined : next);
}

function lockedPlatformBlock(tool, platform) {
  const toolBlock = lockedToolBlock(tool);
  const marker = `[tools.${tool}."platforms.${platform}"]`;
  const start = toolBlock.indexOf(marker);
  if (start < 0) return "";
  const next = toolBlock.indexOf(`\n[tools.${tool}."platforms.`, start + marker.length);
  return toolBlock.slice(start, next < 0 ? undefined : next);
}

function lockedField(block, field) {
  return block.match(new RegExp(`^${field} = "([^"\\r\\n]+)"$`, "m"))?.[1] ?? "";
}

function lockedPlatformsForTool(tool) {
  return [
    ...lockedToolBlock(tool).matchAll(/^\[tools\.[a-z0-9_-]+\."platforms\.([^"]+)"\]$/gm),
  ].map(([, platform]) => platform);
}

for (const tool of configuredTools) {
  const block = lockedToolBlock(tool);
  if (!block.includes(`version = "${miseVersions[tool]}"`)) {
    failures.push(`mise.lock ${tool} entry must match mise.toml version ${miseVersions[tool]}`);
  }
  if (!/^backend = "[^"\r\n]+"$/m.test(block)) {
    failures.push(`mise.lock ${tool} entry must declare its resolved backend`);
  }
  const platforms = lockedPlatformsForTool(tool);
  if (platforms.length === 0) {
    failures.push(`mise.lock ${tool} entry must contain at least one locked platform artifact`);
  }
  for (const platform of platforms) {
    const platformBlock = lockedPlatformBlock(tool, platform);
    if (!/^checksum = "sha256:[a-f0-9]{64}"$/m.test(platformBlock)) {
      failures.push(`mise.lock ${tool} ${platform} entry must include a SHA-256 checksum`);
    }
    if (!/^url = "https:\/\/[^"\r\n]+"$/m.test(platformBlock)) {
      failures.push(`mise.lock ${tool} ${platform} entry must include an HTTPS URL`);
    }
  }
}

const lockedPlatforms = {
  node: [
    "linux-arm64",
    "linux-arm64-musl",
    "linux-x64",
    "linux-x64-musl",
    "macos-arm64",
    "macos-x64",
    "windows-x64",
  ],
  pnpm: [
    "linux-arm64",
    "linux-arm64-musl",
    "linux-x64",
    "linux-x64-musl",
    "macos-arm64",
    "windows-x64",
  ],
};
for (const [tool, platforms] of Object.entries(lockedPlatforms)) {
  const block = lockedToolBlock(tool);
  const expectedBackend = tool === "node" ? "core:node" : "aqua:pnpm/pnpm";
  if (lockedPlatformsForTool(tool).join(",") !== platforms.join(",")) {
    failures.push(`mise.lock ${tool} platforms must match the supported artifact matrix exactly`);
  }
  for (const expected of [`version = "${miseVersions[tool]}"`, `backend = "${expectedBackend}"`]) {
    if (!block.includes(expected))
      failures.push(`mise.lock ${tool} entry must include ${expected}`);
  }
  for (const platform of platforms) {
    const platformBlock = lockedPlatformBlock(tool, platform);
    if (!/^checksum = "sha256:[a-f0-9]{64}"$/m.test(platformBlock)) {
      failures.push(`mise.lock ${tool} ${platform} entry must include a SHA-256 checksum`);
    }
    if (!/^url = "https:\/\/[^"]+"$/m.test(platformBlock)) {
      failures.push(`mise.lock ${tool} ${platform} entry must include an HTTPS URL`);
    }
    if (tool === "pnpm" && !platformBlock.includes('provenance = "github-attestations"')) {
      failures.push(`mise.lock pnpm ${platform} entry must include GitHub attestation provenance`);
    }
  }
}
const officialArtifactUrls = {
  node: {
    "linux-arm64": `https://nodejs.org/dist/v${miseVersions.node}/node-v${miseVersions.node}-linux-arm64.tar.gz`,
    "linux-arm64-musl": `https://unofficial-builds.nodejs.org/download/release/v${miseVersions.node}/node-v${miseVersions.node}-linux-arm64-musl.tar.gz`,
    "linux-x64": `https://nodejs.org/dist/v${miseVersions.node}/node-v${miseVersions.node}-linux-x64.tar.gz`,
    "linux-x64-musl": `https://unofficial-builds.nodejs.org/download/release/v${miseVersions.node}/node-v${miseVersions.node}-linux-x64-musl.tar.gz`,
    "macos-arm64": `https://nodejs.org/dist/v${miseVersions.node}/node-v${miseVersions.node}-darwin-arm64.tar.gz`,
    "macos-x64": `https://nodejs.org/dist/v${miseVersions.node}/node-v${miseVersions.node}-darwin-x64.tar.gz`,
    "windows-x64": `https://nodejs.org/dist/v${miseVersions.node}/node-v${miseVersions.node}-win-x64.zip`,
  },
  pnpm: {
    "linux-arm64": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-linux-arm64.tar.gz`,
    "linux-arm64-musl": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-linux-arm64-musl.tar.gz`,
    "linux-x64": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-linux-x64.tar.gz`,
    "linux-x64-musl": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-linux-x64-musl.tar.gz`,
    "macos-arm64": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-darwin-arm64.tar.gz`,
    "windows-x64": `https://github.com/pnpm/pnpm/releases/download/v${miseVersions.pnpm}/pnpm-win32-x64.zip`,
  },
};
for (const [tool, platformUrls] of Object.entries(officialArtifactUrls)) {
  for (const [platform, expectedUrl] of Object.entries(platformUrls)) {
    const platformBlock = lockedPlatformBlock(tool, platform);
    if (lockedField(platformBlock, "url") !== expectedUrl) {
      failures.push(`mise.lock ${tool} ${platform} URL must match its official versioned artifact`);
    }
    if (tool === "pnpm") {
      if (lockedField(platformBlock, "provenance") !== "github-attestations") {
        failures.push(
          `mise.lock pnpm ${platform} entry must include GitHub attestation provenance`,
        );
      }
      if (
        !/^https:\/\/api\.github\.com\/repos\/pnpm\/pnpm\/releases\/assets\/[1-9]\d*$/.test(
          lockedField(platformBlock, "url_api"),
        )
      ) {
        failures.push(`mise.lock pnpm ${platform} URL API must identify an official GitHub asset`);
      }
    }
  }
}

if (miseVersions.node) {
  requireContent("scripts/setup/check-prereqs.sh", `required_node_version="${miseVersions.node}"`);
}
if (miseVersions.pnpm) {
  requireContent("scripts/setup/check-prereqs.sh", `required_pnpm_version="${miseVersions.pnpm}"`);
}
if (/corepack/iu.test(readRelative("scripts/setup/check-prereqs.sh"))) {
  failures.push("the local prerequisite check must not install or activate Corepack shims");
}
for (const [filePath, expected] of [
  ["README.md", "mise install --locked"],
  ["README.md", 'env -u NO_COLOR codex --cd "$PWD"'],
  ["README.md", "`src/`"],
  ["AGENTS.md", "default Product Root"],
  ["instructions.md", "## Product Roots"],
  ["instructions.md", "root `.context-index/`"],
  ["docs/project.md", "default Product Root"],
  ["README.md", "Linux x64/arm64 (glibc and musl), macOS arm64"],
  ["README.md", "is intentionally not supported"],
  [".codex/README.md", 'env -u NO_COLOR codex --cd "$PWD"'],
  ["scripts/setup/check-prereqs.sh", "Locked runtime platforms: Linux x64/arm64"],
  ["scripts/setup/start-codex.sh", "https://developers.openai.com/codex/cli/"],
  ["scripts/context/source-policy.mjs", '"mise.lock"'],
  ["scripts/verify/context-source-policy.mjs", '"mise.toml"'],
]) {
  requireContent(filePath, expected);
}
if (existsSync(path.join(root, ".github/workflows/ci.yml"))) {
  requireContent(".github/workflows/ci.yml", `version: ${miseVersions.pnpm}`);
  requireContent(".github/workflows/ci.yml", `node-version: ${miseVersions.node}`);
}
for (const runtimePath of ["mise.lock", "mise.toml"]) {
  const categories = classifyPath(runtimePath, { productLayout });
  if (
    !categories.includes("dependency/package manager files") ||
    !isFullRelevantPath(runtimePath, { productLayout })
  ) {
    failures.push(`${runtimePath} must remain a full-relevant dependency/package manager file`);
  }
}

const gitignore = existsSync(path.join(root, ".gitignore"))
  ? readFileSync(path.join(root, ".gitignore"), "utf8")
  : "";
for (const entry of [
  ".codex/*",
  "!.codex/config.toml",
  "!.codex/README.md",
  "!.codex/agents/",
  "!.codex/agents/*.toml",
  ".context-index/",
  "node_modules/",
  ".env",
]) {
  if (!gitignore.includes(entry)) failures.push(`.gitignore must include ${entry}`);
}

if (failures.length > 0) {
  console.error("Repository smoke check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Repository smoke check passed.");
