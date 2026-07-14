import { readFileSync } from "node:fs";
import path from "node:path";
import {
  discoverProductLayout,
  isProductSurfacePath,
  productSourceRootForPath,
  productUnitForPath,
} from "../repository/product-roots.mjs";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import { detectStacks } from "../stack/stack-detector.mjs";

export const root = repositoryRoot;
const lineStartsByFile = new WeakMap();

export const htmlLikeExtensions = new Set([
  ".astro",
  ".htm",
  ".html",
  ".jsx",
  ".mdx",
  ".svelte",
  ".tsx",
  ".vue",
]);
export const styleExtensions = new Set([
  ".css",
  ".scss",
  ".html",
  ".astro",
  ".jsx",
  ".mdx",
  ".tsx",
  ".vue",
  ".svelte",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

export function relativePath(fullPath) {
  return toPosix(path.relative(root, fullPath));
}

export function isWebCandidate(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    htmlLikeExtensions.has(ext) ||
    styleExtensions.has(ext) ||
    [".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"].includes(ext)
  );
}

export function isProductWebSource(relativePathValue, productLayout) {
  const layout = productLayout ?? discoverProductLayout({ repositoryRoot: root });
  return isWebCandidate(relativePathValue) && isProductSurfacePath(relativePathValue, layout);
}

export function readWebFiles({ sourceRoot = root, relativePaths, readText, productLayout } = {}) {
  const inventory = relativePaths ?? listActiveFiles({ root: sourceRoot });
  const layout =
    productLayout ??
    discoverProductLayout({ repositoryRoot: sourceRoot, relativePaths: inventory });
  return inventory
    .filter((relativePathValue) => isProductWebSource(relativePathValue, layout))
    .map((relativePathValue) => {
      const filePath = path.join(sourceRoot, relativePathValue);
      const productUnit = productUnitForPath(relativePathValue, layout, { surface: true });
      return {
        path: filePath,
        relativePath: relativePathValue,
        extension: path.extname(filePath).toLowerCase(),
        content: readText ? readText(relativePathValue, filePath) : readFileSync(filePath, "utf8"),
        productSourceRoot: productSourceRootForPath(relativePathValue, layout, { surface: true }),
        productUnitRoot: productUnit?.root ?? null,
      };
    });
}

export function webSurfaceSummary({
  sourceRoot = root,
  relativePaths: allRelativePaths = listActiveFiles({ root: sourceRoot }),
  stackResult = detectStacks({ root: sourceRoot, relativePaths: allRelativePaths }),
  readText,
  productLayout,
} = {}) {
  const layout =
    productLayout ??
    discoverProductLayout({ repositoryRoot: sourceRoot, relativePaths: allRelativePaths });
  const relativePaths = allRelativePaths.filter((relativePathValue) =>
    isProductWebSource(relativePathValue, layout),
  );
  const hasHtmlLikeSource = relativePaths.some((relativePathValue) =>
    htmlLikeExtensions.has(path.extname(relativePathValue).toLowerCase()),
  );
  const hasWebSurface = stackResult.hasWebSurface || hasHtmlLikeSource;
  const files = hasWebSurface
    ? readWebFiles({ sourceRoot, relativePaths, readText, productLayout: layout })
    : [];
  const htmlLikeFiles = files.filter((file) => htmlLikeExtensions.has(file.extension));
  return {
    sourceRoot,
    stackResult,
    files,
    htmlLikeFiles,
    hasWebSurface,
    productLayout: layout,
  };
}

function indexedLineNumber(file, index) {
  let starts = lineStartsByFile.get(file);
  if (!starts) {
    starts = [0];
    for (let cursor = file.content.indexOf("\n"); cursor >= 0;) {
      starts.push(cursor + 1);
      cursor = file.content.indexOf("\n", cursor + 1);
    }
    lineStartsByFile.set(file, starts);
  }
  let lower = 0;
  let upper = starts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle] <= index) lower = middle + 1;
    else upper = middle;
  }
  return Math.max(1, lower);
}

export function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

export function failMessage(file, message, index = 0) {
  return `${file.relativePath}:${indexedLineNumber(file, index)}: ${message}`;
}

export function reportResult(title, failures, skippedMessage) {
  if (skippedMessage) {
    console.log(skippedMessage);
    return;
  }

  if (failures.length > 0) {
    console.error(`${title} failed:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`${title} passed.`);
}
