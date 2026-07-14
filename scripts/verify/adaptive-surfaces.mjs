import { readFileSync } from "node:fs";
import path from "node:path";
import { discoverProductLayout, isProductSurfacePath } from "../repository/product-roots.mjs";
import { root } from "./adaptive-state.mjs";

const imageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const imageReferenceExtensions = new Set([
  ".astro",
  ".css",
  ".html",
  ".htm",
  ".js",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const imageReferencePattern =
  /!\[[^\]]*\]\([^\n)]+\)|<img\b|\b(?:og:image|twitter:image)\b|\b(?:background(?:-image)?|poster|src|srcset)\s*[:=][^\n]*(?:\.avif|\.gif|\.jpe?g|\.png|\.svg|\.webp)\b/i;

export function hasImageSurfaceInFiles(
  relativePaths,
  {
    readText = (relativePath) => readFileSync(path.join(root, relativePath), "utf8"),
    productLayout,
    repositoryRoot = root,
  } = {},
) {
  const layout =
    productLayout ?? discoverProductLayout({ repositoryRoot, relativePaths, readText });
  for (const relativePath of relativePaths) {
    if (!isProductSurfacePath(relativePath, layout)) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (imageExtensions.has(extension)) return true;
    if (!imageReferenceExtensions.has(extension)) continue;
    if (imageReferencePattern.test(readText(relativePath))) return true;
  }
  return false;
}
