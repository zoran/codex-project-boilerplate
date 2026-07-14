import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateSitemapLastmod } from "./update-sitemap-lastmod.mjs";

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function page(canonical) {
  return `<html><head><link rel="canonical" href="${canonical}"></head></html>\n`;
}

function sitemap(canonical) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `<url><loc>${canonical}</loc><lastmod>2026-07-13T00:00:00+00:00</lastmod></url>`,
    "</urlset>",
  ].join("\n");
}

test("sitemap updates group pages by declared product source root", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sitemap-product-roots-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  write(root, "src/index.html", page("https://root.example/"));
  write(root, "src/sitemap.xml", sitemap("https://root.example/"));
  write(root, "apps/web/package.json", '{"name":"web"}\n');
  write(root, "apps/web/src/index.html", page("https://web.example/"));
  write(root, "apps/web/src/sitemap.xml", sitemap("https://web.example/"));
  write(root, "modules/ignored/index.html", page("https://ignored.example/"));
  const files = [
    "pnpm-workspace.yaml",
    "src/index.html",
    "src/sitemap.xml",
    "apps/web/package.json",
    "apps/web/src/index.html",
    "apps/web/src/sitemap.xml",
    "modules/ignored/index.html",
  ];

  const result = updateSitemapLastmod(
    {
      timestamp: "2026-07-14T12:00:00+00:00",
      changedFrom: "",
      check: false,
      paths: ["src/index.html", "apps/web/src/index.html"],
    },
    { repositoryRoot: root, files },
  );
  assert.deepEqual(result.sitemaps, ["apps/web/src/sitemap.xml", "src/sitemap.xml"]);
  assert.deepEqual(result.updatedUrls, ["https://root.example/", "https://web.example/"]);
  assert.match(
    readFileSync(path.join(root, "src/sitemap.xml"), "utf8"),
    /2026-07-14T12:00:00\+00:00/,
  );
  assert.match(
    readFileSync(path.join(root, "apps/web/src/sitemap.xml"), "utf8"),
    /2026-07-14T12:00:00\+00:00/,
  );

  assert.throws(
    () =>
      updateSitemapLastmod(
        {
          timestamp: "2026-07-14T12:00:00+00:00",
          changedFrom: "",
          check: true,
          paths: ["modules/ignored/index.html"],
        },
        { repositoryRoot: root, files },
      ),
    /outside every declared product source root/,
  );
});
