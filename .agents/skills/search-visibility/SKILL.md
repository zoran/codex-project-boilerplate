---
name: search-visibility
description:
  Read-only final review of public web surfaces for crawlability, indexing signals, metadata,
  structured data, sitemaps, robots, multilingual alternates, image/search performance, and semantic
  agent access. Use after relevant web implementation stabilizes or for an explicit SEO
  audit/review; use the implementation skill when the request is to change SEO behavior.
---

# Search Visibility

Review the rendered/public behavior, not only source snippets. Report findings; do not edit files.

- Check status/redirects, titles, descriptions, canonical URLs, robots meta, crawlable links,
  robots.txt, sitemap coverage, and webmaster/IndexNow integration when present.
- Check locale URL strategy and reciprocal canonical/hreflang signals.
- Validate JSON-LD type, syntax, visible-claim consistency, stable URLs, and eligibility without
  promising rankings or rich results.
- Check semantic HTML, headings, useful page intent, alt text, social previews, render visibility,
  critical resources, responsive images, and LCP-sensitive assets.
- Treat robots.txt as crawler guidance, not access control. Treat optional `llms.txt` or agent
  protocols as product decisions, not universal requirements.

Use current official search-engine or web-standard sources when a decision depends on changing
guidance. Return material findings with file/URL evidence and the smallest proving check. State
residual risks and stop after one targeted recheck unless new evidence appears.
