import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { embeddingDimensions } from "./context-embedding.mjs";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

export function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error(`Model fixture contains unsupported entry: ${entry.name}`);
  }
}

export function storageRecord(index, text, filePath = `docs/chunk-${index}.md`) {
  const vector = Array.from({ length: embeddingDimensions }, (_, dimension) =>
    Math.sin((index + 1) * (dimension + 1) * 0.017453292519943295),
  );
  const norm = Math.hypot(...vector);
  for (let dimension = 0; dimension < vector.length; dimension += 1) {
    vector[dimension] /= norm;
  }
  return {
    id: `row-${index}`,
    path: filePath,
    startLine: 1,
    endLine: 3,
    text,
    headingsText: "Scale fixture",
    symbolsText: "",
    importsText: "",
    searchText: `${filePath}\nScale fixture\n${text}`,
    tokenCount: 12,
    contentHash: String(index).padStart(64, "0"),
    embeddingHash: String(index + 1).padStart(64, "0"),
    vector,
  };
}
