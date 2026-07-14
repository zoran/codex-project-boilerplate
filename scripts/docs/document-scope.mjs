import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

export const projectManifestPath = "docs/project.md";
export const projectContextPath = "docs/project-context.md";

const strategicDocumentBudgets = new Map([
  [projectManifestPath, { maxBytes: 8 * 1024, maxLines: 100, maxWords: 700 }],
  [projectContextPath, { maxBytes: 6 * 1024, maxLines: 80, maxWords: 500 }],
]);

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

export function strategicDocumentBudgetFailures(relativePath, content) {
  const budget = strategicDocumentBudgets.get(relativePath);
  if (!budget) return [];
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines =
    normalizedContent.length === 0
      ? 0
      : normalizedContent.split("\n").length - (normalizedContent.endsWith("\n") ? 1 : 0);
  const words = content.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const bytes = Buffer.byteLength(content, "utf8");
  const failures = [];
  if (lines > budget.maxLines) failures.push(`${lines} lines; maximum is ${budget.maxLines}`);
  if (words > budget.maxWords) failures.push(`${words} words; maximum is ${budget.maxWords}`);
  if (bytes > budget.maxBytes) failures.push(`${bytes} bytes; maximum is ${budget.maxBytes}`);
  return failures;
}
