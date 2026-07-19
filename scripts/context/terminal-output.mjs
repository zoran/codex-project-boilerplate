import { redactSecretMatches } from "../verify/secret-patterns.mjs";

const ansiEscapePattern =
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const multilineControlPattern = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const formatControlPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const terminalSeparator = "\ue000";

export function sanitizeForTerminal(value) {
  return String(value)
    .replace(ansiEscapePattern, "")
    .replace(controlPattern, " ")
    .replace(formatControlPattern, "");
}

export function truncateForTerminal(value, maxLength = 180) {
  const sanitized = sanitizeForTerminal(value).trim();
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, maxLength - 3)}...`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceKnownRoot(output, candidate) {
  if (!candidate) return output;
  const leftBoundary = "(^|[^A-Za-z0-9._/\\\\])";
  const rightBoundary = "(?=$|[\\\\/\\s\"'`()<>\\[\\]{}:,;])";
  const pattern = new RegExp(`${leftBoundary}${escapeRegExp(candidate)}${rightBoundary}`, "gm");
  return output.replace(pattern, (_match, prefix) => `${prefix}.`);
}

function safeWebUrlRanges(line) {
  const ranges = [];
  const pattern = /https?:\/\/[^\s]+/gi;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function firstUnknownAbsolutePathIndex(line) {
  const protectedRanges = safeWebUrlRanges(line);
  let protectedIndex = 0;
  const isPathLeftBoundary = (index) => index === 0 || !/[A-Za-z0-9._/\\]/.test(line[index - 1]);

  for (let index = 0; index < line.length; index += 1) {
    const range = protectedRanges[protectedIndex];
    if (range && index >= range[1]) {
      protectedIndex += 1;
      index -= 1;
      continue;
    }
    if (range && index >= range[0]) {
      index = range[1] - 1;
      protectedIndex += 1;
      continue;
    }

    const remainder = line.slice(index);
    if (/^file:\/\//i.test(remainder) && isPathLeftBoundary(index)) return index;
    if (/^[A-Za-z]:[\\/]/.test(remainder) && isPathLeftBoundary(index)) return index;
    if (remainder.startsWith("\\\\") || remainder.startsWith("//")) return index;
    if (line[index] === "/" && isPathLeftBoundary(index)) return index;
  }
  return -1;
}

export function redactLocalPaths(value, rootPath = process.cwd()) {
  let output = String(value);
  const rawRoot = String(rootPath).replace(/[\\/]+$/, "");
  const normalizedRoot = rawRoot.replaceAll("\\", "/");
  if (normalizedRoot) {
    const fileRoot = /^[A-Za-z]:\//.test(normalizedRoot)
      ? `file:///${normalizedRoot}`
      : `file://${normalizedRoot}`;
    output = replaceKnownRoot(output, fileRoot);
    for (const candidate of new Set([rawRoot, normalizedRoot])) {
      output = replaceKnownRoot(output, candidate);
    }
  }
  return output
    .split("\n")
    .map((line) => {
      const pathIndex = firstUnknownAbsolutePathIndex(line);
      return pathIndex === -1 ? line : `${line.slice(0, pathIndex)}<local-path>`;
    })
    .join("\n");
}

export function sanitizeMultilineForTerminal(value, rootPath = process.cwd()) {
  const normalized = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(ansiEscapePattern, terminalSeparator)
    .replace(multilineControlPattern, terminalSeparator)
    .replace(formatControlPattern, terminalSeparator);
  const redacted = redactSecretMatches(normalized, "<redacted-secret>", terminalSeparator);
  return redactLocalPaths(redacted.replaceAll(terminalSeparator, " "), rootPath);
}

export function formatContextError(error, rootPath = process.cwd()) {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = sanitizeMultilineForTerminal(message, rootPath);
  return truncateForTerminal(redacted, 500);
}
