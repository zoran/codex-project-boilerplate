import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { format as formatWithPrettier } from "prettier";
import { repositoryRoot } from "../repository/source-inventory.mjs";

const skillsRoot = path.join(repositoryRoot, ".agents", "skills");
const failures = [];

function relativePath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

function requireRegularFile(filePath) {
  if (!existsSync(filePath)) {
    failures.push(`missing required file: ${relativePath(filePath)}`);
    return false;
  }
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    failures.push(`${relativePath(filePath)} must be a non-symlink regular file`);
    return false;
  }
  return true;
}

function rejectSymlinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      failures.push(`${relativePath(entryPath)} must not be a symlink`);
    } else if (stats.isDirectory()) {
      rejectSymlinks(entryPath);
    }
  }
}

function frontmatter(markdown, filePath) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  if (!match) {
    failures.push(`${relativePath(filePath)} must start with YAML frontmatter`);
    return null;
  }
  return match[1];
}

function yamlScalar(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
  if (index < 0) return "";
  const inline = lines[index].replace(new RegExp(`^${key}:\\s*`), "").trim();
  if (inline) return inline.replace(/^["']|["']$/g, "");
  const continuation = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^\S/.test(lines[cursor])) break;
    if (lines[cursor].trim()) continuation.push(lines[cursor].trim());
  }
  return continuation.join(" ");
}

function metadataScalar(yaml, key) {
  const match = new RegExp(`^  ${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(yaml);
  return match?.[1]?.replace(/["']$/, "") ?? "";
}

async function verifySkill(skillName) {
  const skillDirectory = path.join(skillsRoot, skillName);
  const stats = lstatSync(skillDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    failures.push(`.agents/skills/${skillName} must be a non-symlink directory`);
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    failures.push(`.agents/skills/${skillName} must use hyphen-case`);
  }

  const instructionPath = path.join(skillDirectory, "SKILL.md");
  const metadataPath = path.join(skillDirectory, "agents", "openai.yaml");
  const hasInstruction = requireRegularFile(instructionPath);
  const hasMetadata = requireRegularFile(metadataPath);
  if (!hasInstruction || !hasMetadata) return;

  const instruction = readFileSync(instructionPath, "utf8");
  const instructionFrontmatter = frontmatter(instruction, instructionPath);
  if (instructionFrontmatter) {
    const declaredName = yamlScalar(instructionFrontmatter, "name");
    const description = yamlScalar(instructionFrontmatter, "description");
    if (declaredName !== skillName) {
      failures.push(
        `${relativePath(instructionPath)} name must match its directory (${skillName})`,
      );
    }
    if (!description) failures.push(`${relativePath(instructionPath)} needs a description`);
    if (description.length > 1024) {
      failures.push(`${relativePath(instructionPath)} description exceeds 1024 characters`);
    }
  }

  const metadata = readFileSync(metadataPath, "utf8");
  try {
    await formatWithPrettier(metadata, { parser: "yaml" });
  } catch (error) {
    failures.push(
      `${relativePath(metadataPath)} is invalid YAML: ${String(error.message).split("\n")[0]}`,
    );
    return;
  }
  for (const field of ["display_name", "short_description", "default_prompt"]) {
    if (!metadataScalar(metadata, field)) {
      failures.push(`${relativePath(metadataPath)} needs interface.${field}`);
    }
  }
  const shortDescription = metadataScalar(metadata, "short_description");
  if (shortDescription && (shortDescription.length < 25 || shortDescription.length > 64)) {
    failures.push(`${relativePath(metadataPath)} short_description must contain 25-64 characters`);
  }
  const defaultPrompt = metadataScalar(metadata, "default_prompt");
  if (defaultPrompt && !defaultPrompt.includes(`$${skillName}`)) {
    failures.push(`${relativePath(metadataPath)} default_prompt must mention $${skillName}`);
  }
  const allowsImplicitInvocation = /^  allow_implicit_invocation:\s*true\s*$/m.test(metadata);
  if (skillName === "context-retrieval" && !allowsImplicitInvocation) {
    failures.push(
      `${relativePath(metadataPath)} must explicitly allow implicit invocation for ordinary repository discovery`,
    );
  } else if (/^policy:/m.test(metadata) && !allowsImplicitInvocation) {
    failures.push(
      `${relativePath(metadataPath)} policy.allow_implicit_invocation must be true when present`,
    );
  }
}

if (!existsSync(skillsRoot) || lstatSync(skillsRoot).isSymbolicLink()) {
  failures.push(".agents/skills must be a real directory");
} else {
  rejectSymlinks(skillsRoot);
  const entries = readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      failures.push(`.agents/skills/${entry.name} must be a skill directory`);
      continue;
    }
    await verifySkill(entry.name);
  }
}

const trackedCodex = spawnSync("git", ["ls-files", "-z", "--", ".codex"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  input: "",
  stdio: ["pipe", "pipe", "ignore"],
});
if (trackedCodex.status === 0) {
  for (const trackedPath of trackedCodex.stdout.split("\0").filter(Boolean)) {
    if (
      ![".codex/README.md", ".codex/config.toml", ".codex/hooks.json"].includes(trackedPath) &&
      !/^\.codex\/agents\/[a-z][a-z0-9_-]*\.toml$/.test(trackedPath)
    ) {
      failures.push(`${trackedPath} must remain ignored Codex runtime state`);
    }
  }
}

if (failures.length > 0) {
  console.error("Skill verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Skill verification passed.");
