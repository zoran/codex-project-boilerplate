import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

export const maxExecutableLines = 700;

const executableExtensions = new Set([
  ".c",
  ".cc",
  ".cjs",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".h",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
]);
const genericNames = new Set(["common", "helper", "helpers", "misc", "stuff", "utils"]);
const nonMaintainedCodePattern =
  /(?:^|\/)(?:fixtures?|generated|snapshots?)(?:\/|$)|\.(?:fixture|generated|snapshot)\.[^.]+$/i;

export function physicalLineCount(content) {
  if (content === "") return 0;
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

function isExecutablePath(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return executableExtensions.has(extension) || relativePath.startsWith("scripts/git-hooks/");
}

export function isMaintainedExecutablePath(relativePath) {
  return isExecutablePath(relativePath) && !nonMaintainedCodePattern.test(relativePath);
}

export function analyzeCodePatterns({
  activeFiles = listActiveFiles(),
  readText = (relativePath) =>
    readFileSync(path.join(repositoryRoot, ...relativePath.split("/")), "utf8"),
} = {}) {
  const failures = [];
  const advice = [];
  const caseFoldedPaths = new Map();

  for (const relativePath of activeFiles) {
    if (/[\u0000-\u001f\u007f]/u.test(relativePath)) {
      failures.push(`path contains a control character: ${JSON.stringify(relativePath)}`);
    }
    const folded = relativePath.toLocaleLowerCase("en-US");
    const existing = caseFoldedPaths.get(folded);
    if (existing && existing !== relativePath) {
      failures.push(`case-insensitive path collision: ${existing} and ${relativePath}`);
    } else {
      caseFoldedPaths.set(folded, relativePath);
    }

    if (!isExecutablePath(relativePath)) continue;

    const extension = path.extname(relativePath).toLowerCase();
    const basename = path.basename(relativePath, extension).toLowerCase();
    if (genericNames.has(basename)) {
      advice.push(`${relativePath}: generic module name; confirm the owner is clear`);
    }
    if (!isMaintainedExecutablePath(relativePath)) continue;

    const lines = physicalLineCount(readText(relativePath));
    if (lines > maxExecutableLines) {
      failures.push(
        `${relativePath}: ${lines} physical lines; maximum for maintained executable code is ${maxExecutableLines}`,
      );
    }
  }

  return { advice, failures };
}

function main() {
  const { advice, failures } = analyzeCodePatterns();
  if (advice.length > 0) {
    console.log("Code pattern advice:");
    for (const finding of advice) console.log(`- ${finding}`);
  }
  if (failures.length > 0) {
    console.error("Code pattern verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Code pattern verification passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
