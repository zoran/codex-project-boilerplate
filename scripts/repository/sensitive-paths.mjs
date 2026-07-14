import path from "node:path";

const sensitiveDirectories = new Set([
  ".auth",
  ".aws",
  ".azure",
  ".gcloud",
  ".gnupg",
  ".kube",
  ".ssh",
]);
const sensitiveRootDirectories = new Set(["credentials", "private", "secrets"]);
const sensitiveBasenames = new Set([
  ".dockercfg",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".terraformrc",
  ".yarnrc",
  ".yarnrc.yml",
  "auth.json",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "terraform.tfstate",
]);
const credentialExtensions = new Set([".jks", ".key", ".keystore", ".p12", ".pfx", ".tfstate"]);
const credentialDataExtensions = new Set([
  "",
  ".conf",
  ".config",
  ".ini",
  ".json",
  ".properties",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const sensitiveNamePattern =
  /(^|[._-])(api[-_]?key|auth[-_]?token|credential|credentials|password|passwords|passwd|private[-_]?key|secret|secrets|token|tokens)([._-]|$)/i;

function normalizedSegments(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean);
}

function hasSensitiveRelativePath(segments) {
  const relative = segments.map((segment) => segment.toLowerCase()).join("/");
  return [
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".config/gh/hosts.yml",
    ".docker/config.json",
  ].some((candidate) => relative === candidate || relative.endsWith(`/${candidate}`));
}

export function sensitivePathReason(value) {
  const segments = normalizedSegments(value);
  const basename = (segments.at(-1) ?? "").toLowerCase();
  const extension = path.posix.extname(basename);
  if (!basename) return null;
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    return "environment credential file";
  }
  if (segments.some((segment) => sensitiveDirectories.has(segment.toLowerCase()))) {
    return "sensitive credential directory";
  }
  if (sensitiveRootDirectories.has(segments[0]?.toLowerCase())) {
    return "root-level private data directory";
  }
  if (hasSensitiveRelativePath(segments)) return "credential configuration path";
  if (sensitiveBasenames.has(basename)) return "credential configuration file";
  if (credentialExtensions.has(extension) || basename.endsWith(".key.json")) {
    return "credential/key file extension";
  }
  if (extension === ".pem" && sensitiveNamePattern.test(basename)) {
    return "private-key-like PEM file name";
  }
  if (credentialDataExtensions.has(extension) && sensitiveNamePattern.test(basename)) {
    return "credential-like data file name";
  }
  return null;
}
