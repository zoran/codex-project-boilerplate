import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  failMessage,
  reportResult,
  styleExtensions,
  webSurfaceSummary,
} from "../web/web-quality-scan.mjs";

export function responsiveFailures({ files, hasWebSurface }) {
  const failures = [];
  if (!hasWebSurface) return failures;

  for (const file of files) {
    const content = file.content;

    if (/<html\b/i.test(content)) {
      const viewportMatch = /<meta\s+[^>]*name=["']viewport["'][^>]*>/i.exec(content);
      if (!viewportMatch) {
        failures.push(failMessage(file, "document shell must include a viewport meta tag"));
      } else if (/user-scalable\s*=\s*no/i.test(viewportMatch[0])) {
        failures.push(
          failMessage(file, "viewport meta tag must not disable user zoom", viewportMatch.index),
        );
      }
    }

    if (!styleExtensions.has(file.extension)) continue;

    const layoutWidthPattern =
      /(?:^|[}\n])\s*(?:body|main|#root|#app|\.app|\.page|\.layout|\.container|\.content|\.shell)\b[^{]*\{[^}]*\b(?:width|min-width)\s*:\s*(\d{3,})px/gi;
    for (const match of content.matchAll(layoutWidthPattern)) {
      const width = Number.parseInt(match[1], 10);
      if (Number.isFinite(width) && width > 480) {
        failures.push(
          failMessage(
            file,
            `layout root uses fixed ${width}px width; use responsive constraints instead`,
            match.index ?? 0,
          ),
        );
      }
    }

    const mediaPattern =
      /<(?:img|video|canvas|iframe)\b(?![^>]*\b(?:width|height|style|className|class)=)[^>]*>/gi;
    for (const match of content.matchAll(mediaPattern)) {
      failures.push(
        failMessage(
          file,
          "media elements need responsive sizing through dimensions, class, or style constraints",
          match.index ?? 0,
        ),
      );
    }
  }

  return failures;
}

export function runResponsive(summary = webSurfaceSummary()) {
  const failures = responsiveFailures(summary);
  reportResult(
    "Responsive verification",
    failures,
    summary.hasWebSurface ? undefined : "Responsive verification skipped; no web surface detected.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runResponsive();
}
