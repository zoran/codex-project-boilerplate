import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverProductLayout,
  isProductImplementationPath,
  isProductSurfacePath,
  overlappingProductRoots,
  productSourceRootForPath,
} from "./product-roots.mjs";

function write(root, relativePath, content = "") {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("product layout activates only the default, declared workspace, and evidenced Android roots", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "product-roots-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  write(root, "src/.gitkeep");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n  - "!apps/ghost"\n');
  write(root, "apps/web/package.json", '{"name":"web"}\n');
  write(root, "apps/web/src/App.tsx", "export const App = true;\n");
  write(root, "apps/web/public/logo.svg", "<svg/>\n");
  write(root, "apps/ghost/package.json", '{"name":"ghost"}\n');
  write(root, "apps/ghost/src/index.ts", "export const ghost = true;\n");
  write(root, "modules/tool/package.json", '{"name":"tool"}\n');
  write(root, "modules/tool/src/index.ts", "export const tool = true;\n");
  write(root, "settings.gradle.kts", 'include(":app")\n');
  write(root, "app/build.gradle.kts", "plugins {}\n");
  write(root, "app/src/main/AndroidManifest.xml", "<manifest/>\n");
  write(root, "app/src/main/java/MainActivity.kt", "class MainActivity\n");

  const layout = discoverProductLayout({ repositoryRoot: root });
  assert.deepEqual(layout.findings, []);
  assert.deepEqual(layout.sourceRoots, ["app/src/main", "apps/web/src", "src"]);
  assert.equal(isProductImplementationPath("src/index.ts", layout), true);
  assert.equal(isProductImplementationPath("apps/web/src/App.tsx", layout), true);
  assert.equal(isProductImplementationPath("app/src/main/java/MainActivity.kt", layout), true);
  assert.equal(isProductImplementationPath("apps/web/index.html", layout), false);
  assert.equal(isProductImplementationPath("apps/ghost/src/index.ts", layout), false);
  assert.equal(isProductImplementationPath("modules/tool/src/index.ts", layout), false);
  assert.equal(isProductSurfacePath("apps/web/public/logo.svg", layout), true);
  assert.equal(isProductSurfacePath("modules/tool/src/index.ts", layout), false);
  assert.equal(
    productSourceRootForPath("apps/web/public/logo.svg", layout, { surface: true }),
    "apps/web/src",
  );
});

test("logical roots protect missing descendants and nested unit ancestors from index overlap", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "product-roots-overlap-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const missingDefault = discoverProductLayout({ repositoryRoot: root });
  assert.deepEqual(missingDefault.sourceRoots, ["src"]);
  assert.deepEqual(overlappingProductRoots("src/vector-space", missingDefault), ["src"]);

  write(root, "src/.gitkeep");
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
  write(root, "apps/web/package.json", '{"name":"web"}\n');
  write(root, "apps/web/src/index.ts", "export const active = true;\n");
  const layout = discoverProductLayout({ repositoryRoot: root });
  assert.deepEqual(overlappingProductRoots(".context-index", layout), []);
  assert.deepEqual(overlappingProductRoots("apps/web", layout), ["apps/web"]);
  assert.deepEqual(overlappingProductRoots("apps/web/src/vector-space", layout), ["apps/web"]);
});
