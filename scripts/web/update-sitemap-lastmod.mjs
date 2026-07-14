import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverProductLayout, productSourceRootForPath } from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";
import { isInsidePath, verifyRealDirectory, verifyRealFileInside } from "./sitemap-files.mjs";
import {
  canonicalUrlFromHtml,
  hasRobotsNoindex,
  httpUrlOrigin,
  isIso8601Timestamp,
  parseSitemapEntries,
  textFromTag,
} from "./sitemap-metadata.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const root = path.resolve(scriptDir, "..", "..");

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = updateSitemapLastmod(options);
    const action = options.check ? "Verified" : "Updated";
    console.log(
      `${action} ${result.updatedUrls.length} sitemap lastmod entr${
        result.updatedUrls.length === 1 ? "y" : "ies"
      } across ${result.sitemaps.length} product source root(s) at ${result.timestamp}.`,
    );
    for (const url of result.updatedUrls) console.log(`- ${url}`);
    if (result.skippedPages.length > 0) {
      console.log(`Skipped ${result.skippedPages.length} non-indexable page(s).`);
      for (const pagePath of result.skippedPages) console.log(`- ${pagePath}`);
    }
  } catch (error) {
    console.error(`Sitemap lastmod update failed: ${error.message}`);
    process.exit(1);
  }
}

export function updateSitemapLastmod(options, dependencies = {}) {
  const repositoryRoot = dependencies.repositoryRoot ?? root;
  const timestamp = normalizeTimestamp(options.timestamp);
  const files = dependencies.files ?? listActiveFiles({ root: repositoryRoot });
  const layout =
    dependencies.productLayout ?? discoverProductLayout({ repositoryRoot, relativePaths: files });
  const pagePaths = collectTargetPagePaths(options, repositoryRoot, layout);
  if (pagePaths.length === 0) {
    throw new Error("provide at least one changed product HTML page or --changed-from <git-ref>");
  }

  const pathsBySourceRoot = new Map();
  for (const pagePath of pagePaths) {
    const sourceRoot = productSourceRootForPath(pagePath, layout);
    if (!sourceRoot) {
      throw new Error(`${pagePath} is outside every declared product source root`);
    }
    if (!pathsBySourceRoot.has(sourceRoot)) pathsBySourceRoot.set(sourceRoot, []);
    pathsBySourceRoot.get(sourceRoot).push(pagePath);
  }

  const updatedUrls = [];
  const skippedPages = [];
  const sitemaps = [];
  for (const [productSourceRoot, targetPaths] of pathsBySourceRoot) {
    const result = updateProductSitemap({
      repositoryRoot,
      productSourceRoot,
      pagePaths: targetPaths,
      timestamp,
      check: options.check,
    });
    updatedUrls.push(...result.updatedUrls);
    skippedPages.push(...result.skippedPages);
    sitemaps.push(result.sitemapPath);
  }

  return {
    timestamp,
    updatedUrls: [...new Set(updatedUrls)].sort(),
    skippedPages: [...new Set(skippedPages)].sort(),
    sitemaps: sitemaps.sort(),
  };
}

function updateProductSitemap({ repositoryRoot, productSourceRoot, pagePaths, timestamp, check }) {
  const productRoot = path.join(repositoryRoot, ...productSourceRoot.split("/"));
  const sitemapRepositoryPath = `${productSourceRoot}/sitemap.xml`;
  const sitemapPath = path.join(repositoryRoot, ...sitemapRepositoryPath.split("/"));
  const realProductRoot = verifyRealDirectory(productRoot, productSourceRoot);
  const realSitemapPath = verifyRealFileInside({
    filePath: sitemapPath,
    parentPath: productRoot,
    realParentPath: realProductRoot,
    label: sitemapRepositoryPath,
  });

  const sitemap = readFileSync(realSitemapPath, "utf8");
  const sitemapEntries = parseSitemapEntries(sitemap);
  if (sitemapEntries.length === 0) {
    throw new Error(`${sitemapRepositoryPath} must contain at least one <url> entry`);
  }

  const sitemapLocs = new Set(sitemapEntries.map((entry) => entry.loc));
  const sitemapOrigins = sitemapCanonicalOrigins(sitemapEntries, sitemapRepositoryPath);
  const targetUrls = new Set();
  const skippedPages = [];

  for (const repositoryPath of pagePaths) {
    const pagePath = resolvePagePath(repositoryRoot, repositoryPath, productRoot, realProductRoot);
    const page = readIndexablePage(pagePath, sitemapOrigins, repositoryRoot, sitemapRepositoryPath);
    if (!page.indexable) {
      skippedPages.push(toRepositoryPath(repositoryRoot, pagePath));
      continue;
    }
    if (!sitemapLocs.has(page.canonical)) {
      throw new Error(
        `${toRepositoryPath(repositoryRoot, pagePath)} canonical URL is missing from ${sitemapRepositoryPath}`,
      );
    }
    targetUrls.add(page.canonical);
  }

  if (targetUrls.size === 0) {
    return { sitemapPath: sitemapRepositoryPath, updatedUrls: [], skippedPages };
  }

  const { content, updatedUrls } = replaceLastmodValues(sitemap, targetUrls, timestamp);
  if (updatedUrls.length !== targetUrls.size) {
    throw new Error(`failed to update every matching entry in ${sitemapRepositoryPath}`);
  }

  if (check) {
    const mismatches = updatedUrls.filter(
      (url) => Date.parse(lastmodForUrl(sitemapEntries, url)) !== Date.parse(timestamp),
    );
    if (mismatches.length > 0) {
      throw new Error(`${sitemapRepositoryPath} lastmod does not match the requested timestamp`);
    }
  } else if (content !== sitemap) {
    writeFileSync(realSitemapPath, content, "utf8");
  }

  return { sitemapPath: sitemapRepositoryPath, updatedUrls, skippedPages };
}

function parseArgs(args) {
  const options = { timestamp: "", changedFrom: "", check: false, paths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--timestamp") {
      options.timestamp = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--timestamp=")) {
      options.timestamp = arg.slice("--timestamp=".length);
    } else if (arg === "--changed-from") {
      options.changedFrom = requireValue(args, (index += 1), arg);
    } else if (arg.startsWith("--changed-from=")) {
      options.changedFrom = arg.slice("--changed-from=".length);
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }
  if (!options.timestamp) {
    throw new Error("--timestamp <ISO-8601 timestamp with timezone> is required");
  }
  return options;
}

function requireValue(args, index, optionName) {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${optionName} requires a value`);
  return value;
}

function printUsage() {
  console.log(`Usage:
  pnpm web:update-sitemap-lastmod -- --timestamp <ISO> <product/page.html ...>
  pnpm web:update-sitemap-lastmod -- --timestamp <ISO> --changed-from <git-ref>
  pnpm web:update-sitemap-lastmod -- --check --timestamp <ISO> <product/page.html ...>

Updates the sitemap.xml beside each affected product source root. The timestamp must be the
significant page modification time, not the sitemap generation or deployment time.`);
}

function collectTargetPagePaths(options, repositoryRoot, layout) {
  const paths = new Set(options.paths.map((pagePath) => normalizePagePath(pagePath)));
  if (options.changedFrom) {
    for (const pagePath of changedHtmlPaths(options.changedFrom, repositoryRoot, layout)) {
      paths.add(normalizePagePath(pagePath));
    }
  }
  return [...paths].sort();
}

function normalizePagePath(pagePath) {
  const rawPath = String(pagePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  const normalized = path.posix.normalize(rawPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(rawPath) ||
    normalized.includes("\0")
  ) {
    throw new Error("provided page paths must be repository-relative");
  }
  return normalized;
}

function changedHtmlPaths(changedFrom, repositoryRoot, layout) {
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRTUXB", changedFrom, "--", ...layout.sourceRoots],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("git diff failed for provided --changed-from ref");
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".html"));
}

function resolvePagePath(repositoryRoot, repositoryPath, productRoot, realProductRoot) {
  const resolved = path.join(repositoryRoot, ...repositoryPath.split("/"));
  if (!isInsidePath(productRoot, resolved)) {
    throw new Error(`${repositoryPath} is outside its product source root`);
  }
  if (!existsSync(resolved)) throw new Error(`${repositoryPath} does not exist`);
  if (hasSymlinkPathSegment(productRoot, resolved)) {
    throw new Error(`${repositoryPath} must be a real file, not a symlink path`);
  }
  if (!lstatSync(resolved).isFile() || path.extname(resolved) !== ".html") {
    throw new Error(`${repositoryPath} is not a regular HTML page`);
  }
  if (!isInsidePath(realProductRoot, realpathSync.native(resolved))) {
    throw new Error(`${repositoryPath} resolves outside its product source root`);
  }
  return resolved;
}

function hasSymlinkPathSegment(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  let current = parentPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function readIndexablePage(pagePath, sitemapOrigins, repositoryRoot, sitemapRepositoryPath) {
  const content = stripHtmlComments(readFileSync(pagePath, "utf8"));
  if (hasRobotsNoindex(content)) return { indexable: false, canonical: "" };
  const pageLabel = toRepositoryPath(repositoryRoot, pagePath);
  const canonical = canonicalUrlFromHtml(content);
  if (!canonical) throw new Error(`${pageLabel} is indexable but has no canonical link`);
  const canonicalOrigin = httpUrlOrigin(canonical);
  if (!canonicalOrigin) {
    throw new Error(`${pageLabel} canonical link must be an absolute http(s) URL`);
  }
  if (!sitemapOrigins.has(canonicalOrigin)) {
    throw new Error(`${pageLabel} canonical origin must match ${sitemapRepositoryPath}`);
  }
  return { indexable: true, canonical };
}

function sitemapCanonicalOrigins(entries, sitemapRepositoryPath) {
  const origins = new Set();
  for (const entry of entries) {
    const origin = httpUrlOrigin(entry.loc);
    if (!origin) throw new Error(`${sitemapRepositoryPath} contains a non-http(s) loc value`);
    origins.add(origin);
  }
  return origins;
}

function replaceLastmodValues(sitemap, targetUrls, timestamp) {
  const updatedUrls = [];
  const content = sitemap.replace(/<url\b[^>]*>[\s\S]*?<\/url>/gi, (block) => {
    const loc = textFromTag(block, "loc");
    if (!targetUrls.has(loc)) return block;
    if (!/<lastmod\b[^>]*>\s*[^<]+?\s*<\/lastmod>/i.test(block)) {
      throw new Error("matching sitemap entry is missing a lastmod tag");
    }
    updatedUrls.push(loc);
    return block.replace(/(<lastmod\b[^>]*>)\s*[^<]+?\s*(<\/lastmod>)/i, `$1${timestamp}$2`);
  });
  return { content, updatedUrls };
}

function lastmodForUrl(entries, url) {
  return entries.find((entry) => entry.loc === url)?.lastmod ?? "";
}

function normalizeTimestamp(value) {
  if (!isIso8601Timestamp(value)) {
    throw new Error("--timestamp must be an ISO-8601 timestamp with seconds and timezone");
  }
  return new Date(value).toISOString().replace(".000Z", "+00:00");
}

function stripHtmlComments(content) {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function toRepositoryPath(repositoryRoot, fullPath) {
  return path.relative(repositoryRoot, fullPath).split(path.sep).join("/");
}
