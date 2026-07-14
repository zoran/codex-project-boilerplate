import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

const executableExtensions = new Set([
  ".c",
  ".cc",
  ".cjs",
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
const genericNames = new Set(["common", "helper", "helpers", "misc", "stuff", "utils"]);
const advisoryLineThreshold = 900;
const maxAdvisoryReadBytes = 4 * 1024 * 1024;
const contextCarrierPattern = /(?:^|\/)(?:fixtures?|snapshots?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;
const failures = [];
const advice = [];

function physicalLineCount(filePath) {
  const content = readFileSync(filePath, "utf8");
  if (content === "") return 0;
  return content.split(/\r?\n/).length - (content.endsWith("\n") ? 1 : 0);
}

const activeFiles = listActiveFiles();
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

  const extension = path.extname(relativePath).toLowerCase();
  if (!executableExtensions.has(extension) && !relativePath.startsWith("scripts/git-hooks/")) {
    continue;
  }

  const basename = path.basename(relativePath, extension).toLowerCase();
  if (genericNames.has(basename)) {
    advice.push(`${relativePath}: generic module name; confirm the owner is clear`);
  }
  if (contextCarrierPattern.test(relativePath)) continue;
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (statSync(absolutePath).size > maxAdvisoryReadBytes) {
    advice.push(`${relativePath}: executable module exceeds 4 MiB; review ownership and cohesion`);
    continue;
  }
  const lines = physicalLineCount(absolutePath);
  if (lines > advisoryLineThreshold) {
    advice.push(
      `${relativePath}: ${lines} executable lines; review cohesion instead of splitting by quota`,
    );
  }
}

if (advice.length > 0) {
  console.log("Code pattern advice:");
  for (const finding of advice) console.log(`- ${finding}`);
}
if (failures.length > 0) {
  console.error("Code pattern verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Code pattern verification passed.");
