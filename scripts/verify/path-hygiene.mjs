import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverProductLayout } from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..", "..");
const commonPathSegments = new Set([
  "",
  "app",
  "apps",
  "bin",
  "code",
  "dev",
  "home",
  "media",
  "mnt",
  "opt",
  "private",
  "root",
  "run",
  "src",
  "srv",
  "tmp",
  "users",
  "var",
  "volumes",
]);
const agentOnlyDirectoryNames = new Set([".agents", ".codex", ".context-index", ".project-state"]);
const agentOnlyFileNames = new Set(["AGENTS.md", "AGENTS.override.md"]);

const failures = [];

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function activePathMarkers() {
  const markers = new Set();
  let cursor = root;

  for (let depth = 0; depth < 3; depth += 1) {
    if (!cursor || cursor === path.dirname(cursor)) break;
    const marker = toPosix(cursor);
    if (marker.length >= 12) markers.add(marker);
    cursor = path.dirname(cursor);
  }

  const segments = toPosix(root).split("/").filter(Boolean);
  for (let start = 0; start < segments.length - 1; start += 1) {
    const firstSegment = segments[start].toLowerCase();
    if (commonPathSegments.has(firstSegment)) continue;
    const marker = segments.slice(start).join("/");
    if (marker.includes("/") && marker.length >= 12) {
      markers.add(marker);
    }
  }

  return [...markers].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function createPathMarkerScanner(markers) {
  const encodedMarkers = markers.map((marker) => ({ marker, value: Buffer.from(marker, "utf8") }));
  const overlap = Math.max(0, ...encodedMarkers.map(({ value }) => value.length - 1));
  const matches = new Set();
  let tail = Buffer.alloc(0);
  return {
    write(chunk) {
      const content = Buffer.concat([tail, Buffer.from(chunk)]);
      for (const { marker, value } of encodedMarkers) {
        if (!matches.has(marker) && content.indexOf(value) >= 0) matches.add(marker);
      }
      tail =
        overlap > 0 ? content.subarray(Math.max(0, content.length - overlap)) : Buffer.alloc(0);
    },
    matches() {
      return [...matches].sort((left, right) => left.localeCompare(right));
    },
  };
}

function scanFile(label, filePath, markers) {
  const scanner = createPathMarkerScanner(markers);
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      scanner.write(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return scanner
    .matches()
    .map((marker) => `${label}: contains local path marker ${JSON.stringify(marker)}`);
}

export function activePathMarkerFindings({ markers, repositoryRoot = root }) {
  const findings = [];
  for (const relativePathValue of listActiveFiles({ root: repositoryRoot })) {
    findings.push(
      ...scanFile(relativePathValue, path.join(repositoryRoot, relativePathValue), markers),
    );
  }
  return findings;
}

export function productSourceBoundaryFindings({ repositoryRoot = root } = {}) {
  const layout = discoverProductLayout({
    repositoryRoot,
    relativePaths: listActiveFiles({ root: repositoryRoot }),
  });
  const findings = [...layout.findings];
  const boundaries = layout.units.flatMap((productUnit) =>
    productUnit.root === "." ? productUnit.sourceRoots : [productUnit.root],
  );

  for (const boundary of boundaries) {
    const boundaryRoot = path.join(repositoryRoot, ...boundary.split("/"));
    if (!existsSync(boundaryRoot)) continue;
    const pending = [boundaryRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        const relativePath = toPosix(path.relative(repositoryRoot, absolutePath));
        if (entry.isSymbolicLink()) {
          findings.push(`${relativePath}: symlinks are forbidden inside product unit ${boundary}`);
          continue;
        }
        if (agentOnlyDirectoryNames.has(entry.name)) {
          findings.push(
            `${relativePath}: agent-only path is forbidden inside product unit ${boundary}`,
          );
          continue;
        }
        if (agentOnlyFileNames.has(entry.name)) {
          findings.push(
            `${relativePath}: agent instruction path is forbidden inside product unit ${boundary}`,
          );
          continue;
        }
        if (entry.isDirectory()) pending.push(absolutePath);
      }
    }
  }

  return [...new Set(findings)].sort((left, right) => left.localeCompare(right));
}

export function neutralProductSourceFindings({ repositoryRoot = root } = {}) {
  const boundaryFindings = productSourceBoundaryFindings({ repositoryRoot });
  if (boundaryFindings.length > 0) return boundaryFindings;

  const layout = discoverProductLayout({
    repositoryRoot,
    relativePaths: listActiveFiles({ root: repositoryRoot }),
  });
  if (layout.units.length !== 1 || layout.units[0].root !== ".") {
    return ["product roots: neutral template must contain only the default src root"];
  }

  const productSourceRoot = path.join(repositoryRoot, "src");
  const entries = readdirSync(productSourceRoot).sort();
  if (entries.join("\n") !== ".gitkeep") {
    return ["src: neutral template must contain only the .gitkeep placeholder"];
  }
  const placeholderPath = path.join(productSourceRoot, ".gitkeep");
  const placeholderStats = lstatSync(placeholderPath);
  if (
    placeholderStats.isSymbolicLink() ||
    !placeholderStats.isFile() ||
    readFileSync(placeholderPath, "utf8").trim() !== ""
  ) {
    return ["src/.gitkeep: neutral template placeholder must be a real empty file"];
  }
  return [];
}

function main() {
  const markers = activePathMarkers();
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  if (unknownArguments.length > 0) {
    console.error(`Unknown path hygiene argument: ${unknownArguments[0]}`);
    process.exit(1);
  }
  failures.push(...activePathMarkerFindings({ markers }));
  failures.push(...productSourceBoundaryFindings());

  if (failures.length > 0) {
    console.error("Path hygiene verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Path hygiene verification passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
