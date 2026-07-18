import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

export const projectManifestPath = "docs/project.md";
export const projectContextPath = "docs/project-context.md";

const processDocumentDirectories = new Set([
  "goals",
  "handoffs",
  "planning",
  "plans",
  "reviews",
  "slices",
  "status",
  "tasks",
]);

export function isManagedMarkdownPath(relativePath) {
  return (
    /\.mdx?$/i.test(relativePath) &&
    !relativePath.startsWith(".agents/") &&
    !relativePath.startsWith(".codex/")
  );
}

export function listManagedMarkdownFiles({ root = repositoryRoot } = {}) {
  return listActiveFiles({ root }).filter(isManagedMarkdownPath);
}

export function isRepositoryProcessArtifactPath(relativePath) {
  if (relativePath === projectContextPath) return false;
  if (!/\.mdx?$/i.test(relativePath)) return false;
  const segments = relativePath.split("/").slice(0, -1);
  if (segments.some((segment) => processDocumentDirectories.has(segment.toLowerCase()))) {
    return true;
  }
  const basename = relativePath
    .split("/")
    .at(-1)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[_.]+/g, "-");
  if (
    /^(?:completed-context|completion-report|current-goal|current-slice|final-audit|final-review|implementation-plan|plan-audit|plan-review|progress-log|project-plan|research-notes|review-findings|session-handoff|task-plan|work-log)(?:-.+)?$/.test(
      basename,
    )
  ) {
    return true;
  }
  if (
    segments.some((segment) => ["archive", "archives"].includes(segment.toLowerCase())) &&
    /^(?:completed|completion|goal|handoff|plan|review|slice|task)(?:-.+)?$/.test(basename)
  ) {
    return true;
  }
  return (
    segments.some((segment) => segment.toLowerCase() === "history") &&
    /^(?:agent|session|task|work)(?:-.+)?$/.test(basename)
  );
}

export function isRepositoryProcessMarkdownPath(relativePath) {
  return isManagedMarkdownPath(relativePath) && isRepositoryProcessArtifactPath(relativePath);
}
