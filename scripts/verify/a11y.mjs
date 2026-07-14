import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  failMessage,
  reportResult,
  stripHtmlComments,
  webSurfaceSummary,
} from "../web/web-quality-scan.mjs";

export function accessibilityFailures({ htmlLikeFiles, files, hasWebSurface }) {
  const failures = [];
  if (!hasWebSurface) return failures;

  for (const file of htmlLikeFiles) {
    const content = stripHtmlComments(file.content);

    const imagePattern = /<img\b(?![^>]*\balt=)[^>]*>/gi;
    for (const match of content.matchAll(imagePattern)) {
      failures.push(
        failMessage(
          file,
          "images must include alt text or an explicit empty alt",
          match.index ?? 0,
        ),
      );
    }

    const buttonPattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    for (const match of content.matchAll(buttonPattern)) {
      const attrs = match[1] ?? "";
      const body = (match[2] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/[{}]/g, "")
        .trim();
      const hasName = /\b(?:aria-label|aria-labelledby|title)=/.test(attrs) || body.length > 0;
      if (!hasName) {
        failures.push(
          failMessage(file, "icon-only buttons need an accessible name", match.index ?? 0),
        );
      }
    }

    const clickableNonControlPattern =
      /<(div|span)\b(?=[^>]*\bon(?:Click|click)=)(?![^>]*\brole=)(?![^>]*\btabIndex=)[^>]*>/g;
    for (const match of content.matchAll(clickableNonControlPattern)) {
      failures.push(
        failMessage(
          file,
          "clickable non-control elements need semantic controls or keyboard/role support",
          match.index ?? 0,
        ),
      );
    }

    const anchorButtonPattern = /<a\b(?=[^>]*\bon(?:Click|click)=)(?![^>]*\bhref=)[^>]*>/g;
    for (const match of content.matchAll(anchorButtonPattern)) {
      failures.push(
        failMessage(
          file,
          "interactive anchors must have href or be real buttons",
          match.index ?? 0,
        ),
      );
    }

    const inputPattern =
      /<input\b(?![^>]*\btype=["']hidden["'])(?![^>]*\b(?:aria-label|aria-labelledby|id)=)[^>]*>/gi;
    for (const match of content.matchAll(inputPattern)) {
      failures.push(
        failMessage(file, "form inputs need labels through id or ARIA", match.index ?? 0),
      );
    }
  }

  for (const file of files) {
    if (
      ![".css", ".scss", ".html", ".astro", ".jsx", ".tsx", ".vue", ".svelte"].includes(
        file.extension,
      )
    ) {
      continue;
    }

    const hasFocusVisible = /:focus-visible\b/.test(file.content);
    const outlineNonePattern = /outline\s*:\s*(?:0|none)\b/gi;
    for (const match of file.content.matchAll(outlineNonePattern)) {
      if (!hasFocusVisible) {
        failures.push(
          failMessage(
            file,
            "focus outlines must not be removed without focus-visible replacement",
            match.index ?? 0,
          ),
        );
      }
    }
  }

  return failures;
}

export function runAccessibility(summary = webSurfaceSummary()) {
  const failures = accessibilityFailures(summary);
  reportResult(
    "Accessibility verification",
    failures,
    summary.hasWebSurface
      ? undefined
      : "Accessibility verification skipped; no web surface detected.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runAccessibility();
}
