import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  failMessage,
  reportResult,
  root,
  stripHtmlComments,
  webSurfaceSummary,
} from "../web/web-quality-scan.mjs";
import { verifyRealDirectory, verifyRealFileInside } from "../web/sitemap-files.mjs";
import {
  canonicalUrlFromHtml,
  hasRobotsNoindex,
  httpUrlOrigin,
  isIso8601Timestamp,
  parseSitemapEntries,
} from "../web/sitemap-metadata.mjs";

export function seoFailures({ htmlLikeFiles, hasWebSurface, sourceRoot = root }) {
  const failures = [];
  const staticWebIndexingCandidates = [];
  const indexableStaticWebPages = [];
  if (!hasWebSurface) return failures;

  for (const file of htmlLikeFiles) {
    const content = stripHtmlComments(file.content);
    const isHtmlOrAstroPage = [".astro", ".html"].includes(file.extension);
    const isLayoutFile = /(?:^|\/)(?:app|pages|routes)\/.*layout\.(?:jsx|tsx|svelte|vue)$/i.test(
      file.relativePath,
    );
    const isDocumentShell = /<html\b/i.test(content) || isHtmlOrAstroPage || isLayoutFile;
    if (!isDocumentShell) continue;

    const robotsNoIndex = hasRobotsNoindex(content);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(content);
    const metadataExport = /export\s+const\s+metadata\s*=|generateMetadata\s*\(/.test(content);

    if (!titleMatch && !metadataExport) {
      failures.push(failMessage(file, "document shell must define a title or framework metadata"));
    } else if (titleMatch) {
      const title = titleMatch[1].replace(/\s+/g, " ").trim();
      if (!title || /^untitled$/i.test(title)) {
        failures.push(failMessage(file, "title must be descriptive", titleMatch.index));
      }
    }

    const hasDescription =
      /<meta\s+[^>]*name=["']description["'][^>]*content=["'][^"']{20,}["']/i.test(content);
    if (!robotsNoIndex && !hasDescription && !metadataExport) {
      failures.push(
        failMessage(file, "indexable pages need a useful meta description or explicit noindex"),
      );
    }

    const canonical = canonicalUrlFromHtml(content);
    if (!robotsNoIndex && !canonical && !metadataExport) {
      failures.push(
        failMessage(file, "indexable pages need a canonical link or framework metadata"),
      );
    }

    if (isStaticWebHtmlPage(file) && !robotsNoIndex && !metadataExport) {
      staticWebIndexingCandidates.push(file);
      if (canonical) {
        const canonicalOrigin = httpUrlOrigin(canonical);
        if (!canonicalOrigin) {
          failures.push(failMessage(file, "canonical link must be an absolute http(s) URL"));
        } else {
          indexableStaticWebPages.push({ file, canonical, canonicalOrigin });
        }
      }
    }

    if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|\.local)\b/i.test(content)) {
      failures.push(failMessage(file, "metadata must not expose local development hosts"));
    }
  }

  failures.push(
    ...collectSitemapFailures({
      sourceRoot,
      indexingCandidateFiles: staticWebIndexingCandidates,
      indexablePages: indexableStaticWebPages,
    }),
  );
  return failures;
}

export function runSeo(summary = webSurfaceSummary()) {
  const failures = seoFailures(summary);
  reportResult(
    "SEO verification",
    failures,
    summary.hasWebSurface ? undefined : "SEO verification skipped; no web surface detected.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSeo();
}

function isStaticWebHtmlPage(file) {
  return (
    file.extension === ".html" &&
    Boolean(file.productSourceRoot) &&
    (file.relativePath === file.productSourceRoot ||
      file.relativePath.startsWith(`${file.productSourceRoot}/`))
  );
}

function groupByProductSourceRoot(files) {
  const groups = new Map();
  for (const file of files) {
    if (!file.productSourceRoot) continue;
    if (!groups.has(file.productSourceRoot)) groups.set(file.productSourceRoot, []);
    groups.get(file.productSourceRoot).push(file);
  }
  return groups;
}

function collectSitemapFailures({ sourceRoot, indexingCandidateFiles, indexablePages }) {
  const sitemapFailures = [];
  if (indexingCandidateFiles.length === 0) return sitemapFailures;

  const candidateGroups = groupByProductSourceRoot(indexingCandidateFiles);
  const pageGroups = groupByProductSourceRoot(indexablePages.map((page) => page.file));
  for (const [productSourceRoot, candidateFiles] of candidateGroups) {
    const pageFiles = new Set(pageGroups.get(productSourceRoot) ?? []);
    const pages = indexablePages.filter((page) => pageFiles.has(page.file));
    sitemapFailures.push(
      ...collectProductSitemapFailures({
        sourceRoot,
        productSourceRoot,
        indexingCandidateFiles: candidateFiles,
        indexablePages: pages,
      }),
    );
  }
  return sitemapFailures;
}

function collectProductSitemapFailures({
  sourceRoot,
  productSourceRoot,
  indexingCandidateFiles,
  indexablePages,
}) {
  const sitemapFailures = [];
  if (indexingCandidateFiles.length === 0) return sitemapFailures;
  const productRoot = path.join(sourceRoot, ...productSourceRoot.split("/"));
  const sitemapRelativePath = `${productSourceRoot}/sitemap.xml`;
  const sitemapPath = path.join(sourceRoot, ...sitemapRelativePath.split("/"));

  if (!existsSync(sitemapPath)) {
    sitemapFailures.push(
      `${sitemapRelativePath}: indexable static HTML pages require a committed sitemap.xml in their product source root`,
    );
    return sitemapFailures;
  }

  let realSitemapPath = "";
  try {
    const realProductRoot = verifyRealDirectory(productRoot, productSourceRoot);
    realSitemapPath = verifyRealFileInside({
      filePath: sitemapPath,
      parentPath: productRoot,
      realParentPath: realProductRoot,
      label: sitemapRelativePath,
    });
  } catch (error) {
    sitemapFailures.push(`${sitemapRelativePath}: ${error.message}`);
    return sitemapFailures;
  }
  const sitemap = readFileSync(realSitemapPath, "utf8");
  const sitemapEntries = parseSitemapEntries(sitemap);
  const sitemapLocs = new Set(sitemapEntries.map((entry) => entry.loc));
  const sitemapOrigins = new Set();

  if (sitemapEntries.length === 0) {
    sitemapFailures.push(`${sitemapRelativePath}: sitemap must include at least one <url> entry`);
  }

  for (const entry of sitemapEntries) {
    if (!entry.loc) {
      sitemapFailures.push(`${sitemapRelativePath}: each sitemap entry needs a loc URL`);
    } else {
      const origin = httpUrlOrigin(entry.loc);
      if (!origin) {
        sitemapFailures.push(`${sitemapRelativePath}: loc URLs must be absolute http(s) URLs`);
      } else {
        sitemapOrigins.add(origin);
      }
    }
    if (!entry.lastmod) {
      sitemapFailures.push(`${sitemapRelativePath}: each sitemap entry needs a lastmod timestamp`);
      continue;
    }
    if (!isIso8601Timestamp(entry.lastmod)) {
      sitemapFailures.push(
        `${sitemapRelativePath}: lastmod values must use ISO 8601 timestamps with seconds and timezone`,
      );
    }
  }

  if (sitemapOrigins.size > 1) {
    sitemapFailures.push(`${sitemapRelativePath}: loc URLs must use one canonical origin`);
  }

  for (const page of indexablePages) {
    if (sitemapOrigins.size > 0 && !sitemapOrigins.has(page.canonicalOrigin)) {
      sitemapFailures.push(
        `${page.file.relativePath}: canonical origin must match ${sitemapRelativePath}`,
      );
    }
    if (!sitemapLocs.has(page.canonical)) {
      sitemapFailures.push(
        `${sitemapRelativePath}: missing canonical URL for ${page.file.relativePath}`,
      );
    }
  }

  sitemapFailures.push(
    ...collectCurrentSitemapLastmodFreshnessFailures({
      sourceRoot,
      productSourceRoot,
      sitemapRelativePath,
      currentEntries: sitemapEntries,
      pages: indexablePages,
    }),
  );

  return sitemapFailures;
}

function collectCurrentSitemapLastmodFreshnessFailures({
  sourceRoot,
  productSourceRoot,
  sitemapRelativePath,
  currentEntries,
  pages,
}) {
  const changedHtmlRelativePaths = changedHtmlPathsFromGit(sourceRoot, productSourceRoot);
  if (changedHtmlRelativePaths.size === 0) return [];

  const previousSitemap = readGitFile(sourceRoot, `HEAD:${sitemapRelativePath}`);
  if (!previousSitemap) return [];

  return collectSitemapLastmodFreshnessFailures({
    changedHtmlRelativePaths,
    currentEntries,
    previousEntries: parseSitemapEntries(previousSitemap),
    pages,
  });
}

export function collectSitemapLastmodFreshnessFailures({
  changedHtmlRelativePaths,
  currentEntries,
  previousEntries,
  pages,
}) {
  const freshnessFailures = [];
  const currentByUrl = new Map(currentEntries.map((entry) => [entry.loc, entry]));
  const previousByUrl = new Map(previousEntries.map((entry) => [entry.loc, entry]));
  const changedPathsByCanonical = new Map();

  for (const page of pages) {
    if (!changedHtmlRelativePaths.has(page.file.relativePath)) continue;
    if (!changedPathsByCanonical.has(page.canonical)) {
      changedPathsByCanonical.set(page.canonical, []);
    }
    changedPathsByCanonical.get(page.canonical).push(page.file.relativePath);
  }

  for (const [canonical, pagePaths] of changedPathsByCanonical) {
    const current = currentByUrl.get(canonical);
    const previous = previousByUrl.get(canonical);
    if (!current?.lastmod || !previous?.lastmod) continue;
    if (!isIso8601Timestamp(current.lastmod) || !isIso8601Timestamp(previous.lastmod)) continue;

    if (Date.parse(current.lastmod) <= Date.parse(previous.lastmod)) {
      const sortedPagePaths = pagePaths.sort();
      freshnessFailures.push(
        `${sortedPagePaths.join(
          ", ",
        )}: sitemap lastmod must advance when indexable page content changes; run pnpm web:update-sitemap-lastmod -- --timestamp <ISO> ${sortedPagePaths.join(
          " ",
        )}`,
      );
    }
  }

  return freshnessFailures;
}

function changedHtmlPathsFromGit(sourceRoot, productSourceRoot) {
  const changedPaths = new Set();
  for (const line of gitOutputLines(sourceRoot, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    productSourceRoot,
  ])) {
    if (line.endsWith(".html")) changedPaths.add(line);
  }
  for (const line of gitOutputLines(sourceRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    productSourceRoot,
  ])) {
    if (line.endsWith(".html")) changedPaths.add(line);
  }
  return changedPaths;
}

function gitOutputLines(sourceRoot, args) {
  const result = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readGitFile(sourceRoot, revisionPath) {
  const result = spawnSync("git", ["show", revisionPath], { cwd: sourceRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}
