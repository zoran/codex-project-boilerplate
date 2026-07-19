import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import { analyzeImageAssets, parseImageAssetArgs } from "./image-assets.mjs";

const roots = [];
const onePixelPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082",
  "hex",
);

function fixture(prefix = "image-assets-") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", input: "", stdio: "pipe" });
}

after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

test("image analysis sees tracked bad references but not ignored generated sources", () => {
  const root = fixture();
  write(root, ".gitignore", "dist/\n");
  write(root, "dist/generated.html", '<img src="missing-generated.png" alt="generated">\n');
  write(root, "src/tracked.html", '<img src="missing-tracked.png" alt="tracked">\n');
  assert.equal(git(root, ["init", "-q"]).status, 0);
  const added = git(root, ["add", ".gitignore", "src/tracked.html"]);
  assert.equal(added.status, 0, added.stderr);

  const files = listActiveFiles({ root });
  const findings = analyzeImageAssets({ root, files });
  assert.ok(findings.some((finding) => finding.includes("missing-tracked.png")));
  assert.equal(
    findings.some((finding) => finding.includes("missing-generated.png")),
    false,
  );
  assert.equal(
    findings.some((finding) => finding.startsWith("dist/generated.html")),
    false,
  );
  assert.deepEqual(analyzeImageAssets({ root, files: [] }), []);

  let readCount = 0;
  const cachedFindings = analyzeImageAssets({
    root,
    files: ["src/tracked.html"],
    readText(relativePath) {
      readCount += 1;
      assert.equal(relativePath, "src/tracked.html");
      return '<img src="missing-from-cache.png" alt="cached">\n';
    },
  });
  assert.equal(readCount, 1);
  assert.ok(cachedFindings.some((finding) => finding.includes("missing-from-cache.png")));
});

test("image analysis never treats root Codex plugin and skill caches as project sources", () => {
  const root = fixture("image-runtime-inventory-");
  write(root, ".gitignore", readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"));
  write(root, "src/index.html", '<img src="/assets/brand-mark.png" alt="Brand">\n');
  write(root, "src/assets/brand-mark.png", onePixelPng);
  for (const relativePath of [
    ".tmp/plugins/example/assets/image.png",
    "skills/.system/example/assets/image.png",
    "plugins/example/assets/image.png",
    "sessions/example/assets/image.png",
  ]) {
    write(root, relativePath, Buffer.from("foreign runtime image"));
  }
  assert.equal(git(root, ["init", "-q"]).status, 0);
  assert.equal(git(root, ["add", ".gitignore", "src"]).status, 0);

  const files = listActiveFiles({ root });
  assert.deepEqual(files, [".gitignore", "src/assets/brand-mark.png", "src/index.html"]);
  const reads = [];
  const findings = analyzeImageAssets({
    root,
    files,
    readText(relativePath) {
      reads.push(relativePath);
      return readFileSync(path.join(root, relativePath), "utf8");
    },
  });
  assert.deepEqual(reads, ["src/index.html"]);
  assert.deepEqual(findings, []);
});

test("product images do not make framework verifier fixtures part of the product scan", () => {
  const root = fixture();
  write(root, "src/real.png", onePixelPng);
  write(root, "scripts/check.mjs", 'const fixture = "missing-framework.png";\n');
  const findings = analyzeImageAssets({
    root,
    files: ["src/real.png", "scripts/check.mjs"],
  });
  assert.equal(
    findings.some((finding) => finding.includes("missing-framework.png")),
    false,
  );
});

test("image analysis preserves accessibility, dimension, traversal, and neutral wording checks", () => {
  const root = fixture();
  write(
    root,
    "src/index.html",
    [
      '<img src="/assets/image1.png">',
      '<img src="/assets/brand-mark.png" alt="">',
      '<meta content="/assets/brand-mark.png" property="og:image">',
    ].join("\n"),
  );
  write(root, "src/docs/page.md", "![unsafe](../../../outside.png)\n");
  write(root, "src/assets/image1.png", onePixelPng);
  write(root, "src/assets/brand-mark.png", onePixelPng);
  write(root, "src/assets/truncated.jpg", Buffer.from([0xff, 0xd8, 0xff]));

  const findings = analyzeImageAssets({ root, files: listActiveFiles({ root }) });
  assert.ok(findings.some((finding) => finding.includes("<img> must include alt text")));
  assert.ok(findings.some((finding) => finding.includes("image filename is too generic")));
  assert.ok(findings.some((finding) => finding.includes("social preview image is smaller")));
  assert.ok(
    findings.some((finding) => finding.includes("truncated.jpg") && finding.includes("dimensions")),
  );
  assert.ok(findings.some((finding) => finding.includes("must stay inside the repository")));
  assert.equal(
    findings.some(
      (finding) => finding.includes("brand-mark.png") && finding.includes("missing alt"),
    ),
    false,
  );
  assert.ok(
    findings.every((finding) => finding.includes("not proof that an image was AI-generated")),
  );
});

test("explicit image paths reject traversal and symlink ancestors", () => {
  const root = fixture();
  assert.throws(
    () => parseImageAssetArgs(["--path", "../outside.png"], { root }),
    /inside the repository/,
  );

  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  mkdirSync(realDirectory);
  writeFileSync(path.join(realDirectory, "asset.png"), onePixelPng);
  symlinkSync(realDirectory, linkedDirectory, "dir");
  assert.throws(
    () => parseImageAssetArgs(["--path", "linked/asset.png"], { root }),
    /inside the repository/,
  );
});

test("image analysis refuses hardlinked foreign content without reading it", () => {
  const root = fixture("image-hardlink-");
  const outside = fixture("image-hardlink-outside-");
  const outsideFile = path.join(outside, "foreign.html");
  write(outside, "foreign.html", '<img src="private.png" alt="Private">\n');
  mkdirSync(path.join(root, "src"), { recursive: true });
  linkSync(outsideFile, path.join(root, "src", "index.html"));

  assert.throws(
    () => analyzeImageAssets({ root, files: ["src/index.html"] }),
    /single-link, non-symlink regular repository file/,
  );
  assert.equal(readFileSync(outsideFile, "utf8"), '<img src="private.png" alt="Private">\n');
});

test("active image inventory paths are preserved exactly or rejected without aliasing", () => {
  const root = fixture("image-unusual-path-");
  write(root, "src/space name.html", '<img src="missing.png" alt="missing">\n');
  const findings = analyzeImageAssets({ root, files: ["src/space name.html"] });
  assert.ok(findings.some((finding) => finding.startsWith("src/space name.html:")));
  assert.doesNotThrow(() =>
    analyzeImageAssets({ root, files: [" src/space name.html", "src/space name.html "] }),
  );
  for (const unsafePath of ["src\\space name.html", "src/space name.html\n"]) {
    assert.throws(
      () => analyzeImageAssets({ root, files: [unsafePath] }),
      /unsafe or non-canonical path/,
    );
  }
});

test("image findings redact local paths, secrets, and terminal controls", () => {
  const root = fixture("image-output-redaction-");
  const token = `ghp_${"a".repeat(40)}`;
  write(root, "src/index.html", `<img src="${root}/\u001b[31m${token}.png" alt="private">\n`);
  const findings = analyzeImageAssets({ root, files: ["src/index.html"] });
  assert.ok(findings.length > 0);
  const output = findings.join("\n");
  assert.equal(output.includes(root), false);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /<redacted-secret>|<local-path>|\.\//);
});
