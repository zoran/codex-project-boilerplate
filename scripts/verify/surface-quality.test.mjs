import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readStableRepositoryPrefixText } from "../repository/stable-file-snapshot.mjs";
import { analyzeRepositorySurfaces, createSurfaceSnapshot } from "./surface-quality.mjs";

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("the surface owner inventories once and reuses one content snapshot", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "surface-quality-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  write(
    root,
    "package.json",
    `${JSON.stringify({ name: "surface", packageManager: "pnpm@11.12.0" })}\n`,
  );
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(
    root,
    "src/index.html",
    [
      "<!doctype html>",
      '<html><head><meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>Surface fixture</title>",
      '<meta name="description" content="A complete surface analysis fixture page.">',
      '<link rel="canonical" href="https://example.invalid/fixture">',
      "</head><body><main>Fixture</main></body></html>",
    ].join("\n"),
  );
  write(
    root,
    "src/sitemap.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "<url><loc>https://example.invalid/fixture</loc><lastmod>2026-07-14T00:00:00+00:00</lastmod></url>",
      "</urlset>",
    ].join("\n"),
  );
  const files = ["package.json", "pnpm-lock.yaml", "src/index.html", "src/sitemap.xml"];
  let inventoryCalls = 0;
  const reads = new Map();

  const result = analyzeRepositorySurfaces({
    root,
    listFiles: () => {
      inventoryCalls += 1;
      return files;
    },
    readFile: (absolutePath) => {
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      reads.set(relativePath, (reads.get(relativePath) ?? 0) + 1);
      return readFileSync(absolutePath, "utf8");
    },
  });

  assert.equal(result.webSummary.hasWebSurface, true);
  assert.equal(inventoryCalls, 1);
  assert.equal(reads.get("package.json"), 1);
  assert.equal(reads.get("src/index.html"), 1);
  assert.ok([...reads.values()].every((count) => count === 1));
});

test("stack detection reads a stable bounded prefix instead of the complete active file", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "surface-prefix-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const maximum = 512 * 1024;
  write(root, "src/large.js", Buffer.alloc(maximum + 128 * 1024, 65));

  const prefix = readStableRepositoryPrefixText({
    repositoryRoot: root,
    relativePath: "src/large.js",
    maxBytes: maximum,
  });
  assert.equal(prefix.bytes, maximum);
  assert.equal(prefix.fileBytes, maximum + 128 * 1024);
  assert.equal(prefix.truncated, true);

  const snapshot = createSurfaceSnapshot({ root, files: ["src/large.js"] });
  assert.equal(
    snapshot.readSource(path.join(root, "src", "large.js"), { prefixOnly: true }).length,
    maximum,
  );
  assert.equal(snapshot.cache.get("src/large.js").full, undefined);
});
