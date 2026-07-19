import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  discoverProductLayout,
  isProductSurfacePath,
  productUnitForPath,
} from "../repository/product-roots.mjs";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import {
  readStableRepositoryFile,
  readStableRepositoryText,
} from "../repository/stable-file-snapshot.mjs";
import { formatContextError, sanitizeMultilineForTerminal } from "../context/terminal-output.mjs";

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
const textExtensions = new Set([
  ".astro",
  ".css",
  ".html",
  ".htm",
  ".js",
  ".jsx",
  ".md",
  ".mdx",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const socialPreviewMin = { width: 1200, height: 630 };
const maxRasterBytes = Number(process.env.IMAGE_ASSET_MAX_BYTES ?? 3_000_000);
const maxSvgBytes = Number(process.env.IMAGE_ASSET_MAX_SVG_BYTES ?? 400_000);
const nonDetectionNote = "image-quality risk, not proof that an image was AI-generated";

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .trim();
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasSymlinkAncestor(root, absolutePath) {
  const relativePath = path.relative(root, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return true;
  const parts = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function safeRepositoryPath(root, candidatePath, realRoot = realpathSync(root)) {
  const absolutePath = path.resolve(root, candidatePath);
  if (!isInside(root, absolutePath)) return { unsafe: true, path: null };
  if (existsSync(absolutePath)) {
    if (hasSymlinkAncestor(root, absolutePath)) return { unsafe: true, path: null };
    if (!isInside(realRoot, realpathSync(absolutePath))) return { unsafe: true, path: null };
  }
  return { unsafe: false, path: normalizePath(path.relative(root, absolutePath)) };
}

function safeExplicitPath(root, rawPath) {
  const normalized = normalizePath(rawPath);
  if (!normalized || path.isAbsolute(rawPath) || rawPath.startsWith("~")) {
    throw new Error("image-assets --path values must be repository-relative.");
  }
  const safePath = safeRepositoryPath(root, normalized);
  if (safePath.unsafe) {
    throw new Error("image-assets --path values must stay inside the repository.");
  }
  return safePath.path;
}

export function parseImageAssetArgs(argv, { root = repositoryRoot } = {}) {
  const paths = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value.`);
      paths.push(safeExplicitPath(root, value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--path=")) {
      paths.push(safeExplicitPath(root, arg.slice("--path=".length)));
    } else if (arg !== "--") {
      throw new Error(`Unknown image-assets argument: ${arg}`);
    }
  }
  return paths;
}

function candidateFiles(files, explicitPaths, productLayout) {
  const selected =
    explicitPaths.length === 0
      ? files
      : files.filter((relativePath) =>
          explicitPaths.some(
            (selection) => relativePath === selection || relativePath.startsWith(`${selection}/`),
          ),
        );
  return selected.filter((relativePath) => {
    if (!isProductSurfacePath(relativePath, productLayout)) return false;
    const extension = path.extname(relativePath).toLowerCase();
    if (imageExtensions.has(extension)) return true;
    return textExtensions.has(extension);
  });
}

function readTextFile(root, relativePath) {
  return readStableRepositoryText({ repositoryRoot: root, relativePath }).text;
}

function stripComments(content) {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n\r]*/g, "");
}

function attrValue(attrs, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return pattern.exec(attrs)?.[2] ?? null;
}

function hasAttribute(attrs, name) {
  return new RegExp(`\\b${name}\\b`, "i").test(attrs);
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
}

function cleanReference(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(/[?#]/)[0]
    .trim();
}

function srcsetCandidates(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => cleanReference(entry.trim().split(/\s+/)[0]))
    .filter(Boolean);
}

function hasImageExtension(reference) {
  return imageExtensions.has(path.extname(reference).toLowerCase());
}

function referenceCandidates(reference, sourcePath, productLayout) {
  const cleaned = cleanReference(reference);
  if (!cleaned || isExternalReference(cleaned) || !hasImageExtension(cleaned)) return [];
  const owner = productUnitForPath(sourcePath, productLayout, { surface: true });
  if (!owner) return [];
  if (cleaned.startsWith("/")) {
    const withoutSlash = normalizePath(cleaned.slice(1));
    const publicRoot = owner.root === "." ? `${owner.surfaceRoot}/public` : `${owner.root}/public`;
    return [
      normalizePath(path.posix.join(owner.surfaceRoot, withoutSlash)),
      normalizePath(path.posix.join(publicRoot, withoutSlash)),
    ];
  }
  return [normalizePath(path.join(path.dirname(sourcePath), cleaned))];
}

function resolveReference(root, realRoot, activeFiles, reference, sourcePath, productLayout) {
  const sourceOwner = productUnitForPath(sourcePath, productLayout, { surface: true });
  const candidates = referenceCandidates(reference, sourcePath, productLayout);
  let unsafe = false;
  for (const candidate of candidates) {
    const safePath = safeRepositoryPath(root, candidate, realRoot);
    if (safePath.unsafe) {
      unsafe = true;
      continue;
    }
    const candidateOwner = productUnitForPath(safePath.path, productLayout, { surface: true });
    if (!sourceOwner || candidateOwner?.root !== sourceOwner.root) {
      unsafe = true;
      continue;
    }
    if (activeFiles.has(safePath.path) && existsSync(path.join(root, safePath.path))) {
      return { path: safePath.path, unsafe: false };
    }
  }
  return { path: null, unsafe };
}

function lineLocator(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (index) => {
    const target = Math.max(0, index);
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

function finding(filePath, message, line = null) {
  const suffix = line ? `:${line}` : "";
  return `${filePath}${suffix}: ${message} (${nonDetectionNote}; use targeted visual, accessibility, performance, or provenance review)`;
}

function collectReferences(filePath, content) {
  const references = [];
  const cleaned = stripComments(content);
  const lineAt = lineLocator(cleaned);

  for (const match of cleaned.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const line = lineAt(match.index ?? 0);
    const src = attrValue(attrs, "src");
    const srcset = attrValue(attrs, "srcset");
    const decorative =
      /\baria-hidden\s*=\s*(["'])true\1/i.test(attrs) ||
      /\brole\s*=\s*(["'])(?:presentation|none)\1/i.test(attrs);
    if (!hasAttribute(attrs, "alt") && !decorative) {
      references.push({ type: "missing-alt", value: src ?? "", line });
    }
    if (src) references.push({ type: "image", value: src, line });
    for (const candidate of srcsetCandidates(srcset)) {
      references.push({ type: "image", value: candidate, line });
    }
  }

  for (const match of cleaned.matchAll(/<source\b([^>]*)>/gi)) {
    const srcset = attrValue(match[1] ?? "", "srcset");
    const line = lineAt(match.index ?? 0);
    for (const candidate of srcsetCandidates(srcset)) {
      references.push({ type: "image", value: candidate, line });
    }
  }

  for (const match of cleaned.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    const alt = (match[1] ?? "").trim();
    const value = cleanReference(match[2] ?? "");
    const line = lineAt(match.index ?? 0);
    if (!alt) references.push({ type: "missing-markdown-alt", value, line });
    references.push({ type: "image", value, line });
  }

  for (const match of cleaned.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const property = attrValue(attrs, "property") ?? attrValue(attrs, "name");
    const content = attrValue(attrs, "content");
    if (content && /^(?:og:image|twitter:image)$/i.test(property ?? "")) {
      references.push({
        type: "social",
        value: content,
        line: lineAt(match.index ?? 0),
      });
    }
  }

  for (const match of cleaned.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    references.push({
      type: "image",
      value: match[2],
      line: lineAt(match.index ?? 0),
    });
  }

  for (const match of cleaned.matchAll(
    /["']([^"']+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^"']*)?)["']/gi,
  )) {
    references.push({
      type: "image",
      value: match[1],
      line: lineAt(match.index ?? 0),
    });
  }

  return references.filter((reference) => hasImageExtension(cleanReference(reference.value)));
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gifDimensions(buffer) {
  if (buffer.length < 10 || !["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return null;
  }
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) return null;
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function svgDimensions(content) {
  const tag = /<svg\b([^>]*)>/i.exec(content)?.[1] ?? "";
  const width = Number.parseFloat(attrValue(tag, "width") ?? "");
  const height = Number.parseFloat(attrValue(tag, "height") ?? "");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  const viewBox = attrValue(tag, "viewBox") ?? attrValue(tag, "viewbox");
  const parts = String(viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
    return { width: parts[2], height: parts[3] };
  }
  return null;
}

function imageDimensions(root, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const { buffer } = readStableRepositoryFile({ repositoryRoot: root, relativePath });
  if (extension === ".svg") return svgDimensions(buffer.toString("utf8"));
  if (extension === ".png") return pngDimensions(buffer);
  if (extension === ".jpg" || extension === ".jpeg") return jpegDimensions(buffer);
  if (extension === ".gif") return gifDimensions(buffer);
  if (extension === ".webp") return webpDimensions(buffer);
  if (extension === ".avif") return null;
  return null;
}

function safeImageDimensions(root, realRoot, relativePath) {
  const safePath = safeRepositoryPath(root, relativePath, realRoot);
  if (safePath.unsafe || !safePath.path) return null;
  try {
    return imageDimensions(root, safePath.path);
  } catch {
    return null;
  }
}

function isGenericImageFilename(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath)).toLowerCase();
  return /^(?:img|image|pic|picture|photo|generated|untitled|final)(?:[-_ ]?\d+)?$/.test(base);
}

function isWebAssetSurface(relativePath) {
  return /(^|\/)(?:public|assets|images|img|media|static)\//i.test(relativePath);
}

function analyze(root, realRoot, activeFiles, files, readText, productLayout) {
  const findings = [];
  const imageFiles = files.filter((filePath) =>
    imageExtensions.has(path.extname(filePath).toLowerCase()),
  );
  const textFiles = files.filter((filePath) =>
    textExtensions.has(path.extname(filePath).toLowerCase()),
  );
  const socialImages = new Set();

  for (const filePath of textFiles) {
    const content = readText(filePath);
    if (typeof content !== "string") {
      throw new Error(`Image text reader did not return a string for: ${filePath}`);
    }
    for (const reference of collectReferences(filePath, content)) {
      if (reference.type === "missing-alt") {
        findings.push(
          finding(
            filePath,
            "<img> must include alt text or explicit decorative semantics",
            reference.line,
          ),
        );
        continue;
      }
      if (reference.type === "missing-markdown-alt") {
        findings.push(
          finding(
            filePath,
            'Markdown images need meaningful alt text; use HTML alt="" for decorative images',
            reference.line,
          ),
        );
        continue;
      }
      if (isExternalReference(cleanReference(reference.value))) continue;
      const resolved = resolveReference(
        root,
        realRoot,
        activeFiles,
        reference.value,
        filePath,
        productLayout,
      );
      if (resolved.unsafe) {
        findings.push(
          finding(
            filePath,
            `local image reference must stay inside the repository and avoid symlinks: ${cleanReference(reference.value)}`,
            reference.line,
          ),
        );
        continue;
      }
      if (!resolved.path) {
        findings.push(
          finding(
            filePath,
            `local image reference is missing: ${cleanReference(reference.value)}`,
            reference.line,
          ),
        );
        continue;
      }
      if (reference.type === "social") socialImages.add(resolved.path);
    }
  }

  for (const imagePath of imageFiles) {
    const { bytes } = readStableRepositoryFile({ repositoryRoot: root, relativePath: imagePath });
    const extension = path.extname(imagePath).toLowerCase();
    const byteLimit = extension === ".svg" ? maxSvgBytes : maxRasterBytes;
    if (isGenericImageFilename(imagePath)) {
      findings.push(finding(imagePath, "image filename is too generic for committed assets"));
    }
    if (isWebAssetSurface(imagePath) && bytes > byteLimit) {
      findings.push(finding(imagePath, `image file exceeds byte budget (${bytes} > ${byteLimit})`));
    }
    if (extension !== ".avif") {
      const dimensions = safeImageDimensions(root, realRoot, imagePath);
      if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
        findings.push(finding(imagePath, "image dimensions could not be read from the file"));
      }
    }
  }

  for (const imagePath of socialImages) {
    const dimensions = safeImageDimensions(root, realRoot, imagePath);
    if (!dimensions) {
      findings.push(finding(imagePath, "social preview image dimensions could not be verified"));
      continue;
    }
    if (dimensions.width < socialPreviewMin.width || dimensions.height < socialPreviewMin.height) {
      findings.push(
        finding(
          imagePath,
          `social preview image is smaller than ${socialPreviewMin.width}x${socialPreviewMin.height}`,
        ),
      );
    }
  }

  return findings;
}

function normalizedActiveFiles(files) {
  const normalizedFiles = new Set();
  for (const value of files) {
    if (typeof value !== "string") {
      throw new Error("Active image inventory contains a non-string path.");
    }
    const relativePath = path.posix.normalize(value);
    if (
      !relativePath ||
      relativePath === "." ||
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(value) ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      relativePath.includes("\0") ||
      /[\\\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      relativePath !== value
    ) {
      throw new Error("Active image inventory contains an unsafe or non-canonical path.");
    }
    normalizedFiles.add(relativePath);
  }
  return [...normalizedFiles].sort();
}

export function analyzeImageAssets({
  root = repositoryRoot,
  files = listActiveFiles({ root }),
  explicitPaths = [],
  readText,
  productLayout,
} = {}) {
  const activeFiles = normalizedActiveFiles(files);
  const layout =
    productLayout ?? discoverProductLayout({ repositoryRoot: root, relativePaths: activeFiles });
  const selectedPaths = explicitPaths.map((value) => safeExplicitPath(root, value));
  const textReader = readText ?? ((relativePath) => readTextFile(root, relativePath));
  return analyze(
    root,
    realpathSync(root),
    new Set(activeFiles),
    candidateFiles(activeFiles, selectedPaths, layout),
    textReader,
    layout,
  ).map((item) => sanitizeMultilineForTerminal(item, realpathSync(root)));
}

function main() {
  const explicitPaths = parseImageAssetArgs(process.argv.slice(2));
  const files = listActiveFiles({ root: repositoryRoot });
  const findings = analyzeImageAssets({ root: repositoryRoot, files, explicitPaths });
  if (findings.length > 0) {
    console.error("Image asset verification failed:");
    for (const item of findings) console.error(`- ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log("Image asset verification passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Image asset verification failed: ${formatContextError(error, repositoryRoot)}`);
    process.exitCode = 1;
  }
}
