import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findSecretMatches } from "./secret-patterns.mjs";

function parseArgs(argv) {
  const parsed = {
    remoteName: "",
    remoteUrl: "",
  };
  const args = argv.filter((arg) => arg !== "--");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--remote-name") {
      parsed.remoteName = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--remote-url") {
      parsed.remoteUrl = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  pnpm verify:git-remote
  pnpm verify:git-remote -- --remote-name origin --remote-url https://example.com/repo.git`);
      process.exit(0);
    }
    throw new Error(`Unknown git remote identity option: ${arg}`);
  }

  return parsed;
}

function runGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function configuredRemoteUrls() {
  const output = runGit(["remote", "-v"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] ?? "",
        url: parts[1] ?? "",
        mode: (parts[2] ?? "").replace(/[()]/g, ""),
      };
    })
    .filter((entry) => entry.url);
}

function entryLabel(entry) {
  const parts = [entry.name || "unnamed remote", entry.mode].filter(Boolean);
  return parts.join(" ");
}

export function isLocalPathLike(rawUrl) {
  const normalized = rawUrl.replaceAll("\\", "/");
  const schemeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized);
  const scpLike = /^(?:[^@\s/:]+@)?[^@\s/:]+:[^:\s]+$/.test(normalized);
  return (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    /^(?:file|git\+file):/i.test(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith("//") ||
    (!schemeUrl && !scpLike)
  );
}

function hostnameFromRemoteUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    const scpLike = rawUrl.match(/^([^@\s:]+@)?([^:\s/]+):[^:\s]+/);
    return scpLike ? scpLike[2].toLowerCase() : "";
  }
}

function isLoopbackOrLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.endsWith(".local")
  );
}

export function hasEmbeddedCredential(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (["http:", "https:"].includes(url.protocol)) {
      return Boolean(url.username || url.password);
    }
    return Boolean(url.password);
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]*@/i.test(rawUrl);
  }
}

function expectedRemotePattern(failures) {
  const configured = process.env.EXPECTED_GIT_REMOTE_PATTERN;
  if (!configured) return null;
  try {
    return new RegExp(configured, "i");
  } catch {
    failures.push("EXPECTED_GIT_REMOTE_PATTERN is not a valid regular expression");
    return null;
  }
}

export function checkRemoteEntry(entry, expectedPattern = null) {
  const findings = [];
  const label = entryLabel(entry);
  const hostname = hostnameFromRemoteUrl(entry.url);

  if (findSecretMatches(entry.url).length > 0 || hasEmbeddedCredential(entry.url)) {
    findings.push(`${label}: remote URL must not contain credentials or tokens`);
  }
  if (isLocalPathLike(entry.url)) {
    findings.push(`${label}: remote URL must not be a local filesystem path`);
  }
  if (hostname && isLoopbackOrLocalHost(hostname)) {
    findings.push(`${label}: remote URL must not target localhost or a machine-local host`);
  }
  if (expectedPattern && !expectedPattern.test(entry.url)) {
    findings.push(`${label}: remote URL does not match EXPECTED_GIT_REMOTE_PATTERN`);
  }
  return findings;
}

function main() {
  const failures = [];
  const args = parseArgs(process.argv.slice(2));
  const expectedPattern = expectedRemotePattern(failures);
  const entries = args.remoteUrl
    ? [{ name: args.remoteName, url: args.remoteUrl, mode: "push" }]
    : configuredRemoteUrls();

  for (const entry of entries) failures.push(...checkRemoteEntry(entry, expectedPattern));

  if (failures.length > 0) {
    console.error("Git remote identity verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  if (entries.length === 0) {
    console.log("Git remote identity verification passed; no Git remotes are configured.");
  } else {
    console.log(`Git remote identity verification passed for ${entries.length} remote URL(s).`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Git remote identity verification failed: ${error.message}`);
    process.exit(1);
  }
}
