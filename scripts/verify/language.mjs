import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

const policyTextExtensions = new Set([".md", ".txt", ".toml", ".yaml", ".yml"]);
const germanMarkers = [
  "aktuell",
  "bitte",
  "deutsch",
  "dokumentation",
  "frage",
  "inhalt",
  "keine",
  "nicht",
  "oder",
  "quelltext",
  "schritt",
  "skript",
  "soll",
  "verwende",
  "werden",
  "wird",
  "ziel",
];
const markerPattern = new RegExp("\\b(" + germanMarkers.join("|") + ")\\b", "i");
const germanCharacterPattern = /[\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc\u00df]/;
const failures = [];

function isPolicyText(relativePath) {
  const extension = path.extname(relativePath);
  return (
    ["AGENTS.md", "README.md", "instructions.md", "scripts/README.md"].includes(relativePath) ||
    relativePath.startsWith("docs/") ||
    (relativePath.startsWith(".agents/skills/") && policyTextExtensions.has(extension))
  );
}

function inspectLine(relativePath, line, lineNumber) {
  if (germanCharacterPattern.test(line)) {
    failures.push(`${relativePath}:${lineNumber}: contains a German-specific character`);
    return;
  }
  const marker = line.match(markerPattern)?.[0];
  if (marker) {
    failures.push(`${relativePath}:${lineNumber}: contains German marker '${marker}'`);
  }
}

function scanPolicyText(relativePath) {
  const descriptor = openSync(path.join(repositoryRoot, relativePath), "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let lineNumber = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const content = pending + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      const lines = content.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) inspectLine(relativePath, line, ++lineNumber);
    }
    pending += decoder.decode();
    if (pending) inspectLine(relativePath, pending, ++lineNumber);
  } finally {
    closeSync(descriptor);
  }
}

for (const relativePath of listActiveFiles().filter(isPolicyText)) {
  scanPolicyText(relativePath);
}

if (failures.length > 0) {
  console.error("Language verification failed for framework policy and documentation:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Framework policy and documentation language verification passed.");
