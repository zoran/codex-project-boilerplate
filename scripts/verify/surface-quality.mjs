import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { discoverProductLayout } from "../repository/product-roots.mjs";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import {
  readStableRepositoryPrefixText,
  readStableRepositoryText,
} from "../repository/stable-file-snapshot.mjs";
import { detectStacks, formatStackReport } from "../stack/stack-detector.mjs";
import { webSurfaceSummary } from "../web/web-quality-scan.mjs";
import { formatContextError, sanitizeMultilineForTerminal } from "../context/terminal-output.mjs";
import { accessibilityFailures } from "./a11y.mjs";
import { hasImageSurfaceInFiles } from "./adaptive-surfaces.mjs";
import { analyzeImageAssets } from "./image-assets.mjs";
import { responsiveFailures } from "./responsive.mjs";
import { seoFailures } from "./seo.mjs";
import { stackStandardsFailures } from "./stack-standards.mjs";
import { webStackFailures } from "./web-stack.mjs";

const stackPrefixBytes = 512 * 1024;

function prefixFromContent(content) {
  return content.length <= stackPrefixBytes ? content : content.slice(0, stackPrefixBytes);
}

export function createSurfaceSnapshot({
  root = repositoryRoot,
  files,
  listFiles = listActiveFiles,
  readFile,
} = {}) {
  const relativePaths = files ?? listFiles({ root });
  const activePaths = new Set(relativePaths);
  const cache = new Map();
  const readFull =
    readFile ??
    ((_absolutePath, relativePath) =>
      readStableRepositoryText({ repositoryRoot: root, relativePath }).text);

  const relativeFor = (absolutePath) => {
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    if (!activePaths.has(relativePath)) {
      throw new Error(`Surface analysis attempted to read outside its snapshot: ${relativePath}`);
    }
    return relativePath;
  };
  const readText = (relativePath, absolutePath = path.join(root, ...relativePath.split("/"))) => {
    if (!activePaths.has(relativePath)) {
      throw new Error(`Surface analysis attempted to read outside its snapshot: ${relativePath}`);
    }
    const cached = cache.get(relativePath);
    if (cached?.full !== undefined) return cached.full;
    const full = readFull(absolutePath, relativePath);
    cache.set(relativePath, { full, prefix: prefixFromContent(full) });
    return full;
  };
  const readSource = (absolutePath, { prefixOnly = false } = {}) => {
    const relativePath = relativeFor(absolutePath);
    if (!prefixOnly) return readText(relativePath, absolutePath);
    const cached = cache.get(relativePath);
    if (cached?.prefix !== undefined) return cached.prefix;
    if (readFile) {
      return prefixFromContent(readText(relativePath, absolutePath));
    }
    const prefix = readStableRepositoryPrefixText({
      repositoryRoot: root,
      relativePath,
      maxBytes: stackPrefixBytes,
    }).text;
    cache.set(relativePath, { prefix });
    return prefix;
  };

  return { cache, readSource, readText, relativePaths };
}

function labelFindings(label, findings) {
  return findings.map((finding) => `${label}: ${finding}`);
}

export function analyzeRepositorySurfaces(options = {}) {
  const root = options.root ?? repositoryRoot;
  const snapshot = createSurfaceSnapshot({ ...options, root });
  const productLayout =
    options.productLayout ??
    discoverProductLayout({ repositoryRoot: root, relativePaths: snapshot.relativePaths });
  const stackResult = detectStacks({
    root,
    relativePaths: snapshot.relativePaths,
    readSource: snapshot.readSource,
    productLayout,
  });
  const webSummary = webSurfaceSummary({
    sourceRoot: root,
    relativePaths: snapshot.relativePaths,
    stackResult,
    readText: snapshot.readText,
    productLayout,
  });
  const hasImageSurface = hasImageSurfaceInFiles(snapshot.relativePaths, {
    readText: snapshot.readText,
    productLayout,
    repositoryRoot: root,
  });
  const findings = [
    ...labelFindings(
      "stack",
      stackStandardsFailures(stackResult, { root, readText: snapshot.readText }),
    ),
  ];
  if (webSummary.hasWebSurface) {
    findings.push(
      ...labelFindings("web stack", webStackFailures(stackResult)),
      ...labelFindings("responsive", responsiveFailures(webSummary)),
      ...labelFindings("SEO", seoFailures(webSummary)),
      ...labelFindings("accessibility", accessibilityFailures(webSummary)),
    );
  }
  if (hasImageSurface) {
    findings.push(
      ...labelFindings(
        "images",
        analyzeImageAssets({
          root,
          files: snapshot.relativePaths,
          readText: snapshot.readText,
          productLayout,
        }),
      ),
    );
  }
  return {
    findings: [...new Set(findings)],
    hasImageSurface,
    productLayout,
    stackResult,
    webSummary,
  };
}

function main() {
  const result = analyzeRepositorySurfaces();
  if (result.findings.length > 0) {
    console.error("Repository surface verification failed:");
    for (const finding of result.findings) {
      console.error(`- ${sanitizeMultilineForTerminal(finding, repositoryRoot)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(formatStackReport(result.stackResult));
  console.log(
    `Repository surface verification passed (web: ${result.webSummary.hasWebSurface ? "yes" : "no"}, images: ${result.hasImageSurface ? "yes" : "no"}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `Repository surface verification failed: ${formatContextError(error, repositoryRoot)}`,
    );
    process.exitCode = 1;
  }
}
