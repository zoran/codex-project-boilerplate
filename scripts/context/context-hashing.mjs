import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function hashFiles(directory, relativePaths) {
  const hashes = [];
  for (const relativePath of [...relativePaths].sort()) {
    const filePath = path.join(directory, relativePath);
    if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink()) return null;
    hashes.push(`${toPosix(relativePath)}:${hashFile(filePath)}`);
  }
  return hashContent(hashes.join("\n"));
}
