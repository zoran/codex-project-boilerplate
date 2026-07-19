export const secretPatterns = [
  {
    label: "private key block",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    label: "AWS access key",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    label: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    label: "OpenAI-style API key",
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    label: "Slack token",
    regex: /xox[baprs]-[0-9A-Za-z-]{20,}/,
  },
  {
    label: "GitHub token",
    regex: /(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{36,}/,
  },
  {
    label: "GitHub fine-grained token",
    regex: /github_pat_[0-9A-Za-z_]{20,}/,
  },
];

export function redactSecretMatches(
  content,
  replacement = "<redacted-secret>",
  ignoredCharacters = "",
) {
  const source = String(content);
  const ignored = new Set(String(ignoredCharacters));
  const collapsedToSource = [];
  let collapsed = "";
  for (let index = 0; index < source.length; index += 1) {
    if (ignored.has(source[index])) continue;
    collapsedToSource.push(index);
    collapsed += source[index];
  }

  const ranges = [];
  for (const { regex } of secretPatterns) {
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const matcher = new RegExp(regex.source, flags);
    for (let match = matcher.exec(collapsed); match; match = matcher.exec(collapsed)) {
      if (match[0].length === 0) continue;
      ranges.push([
        collapsedToSource[match.index],
        collapsedToSource[match.index + match[0].length - 1] + 1,
      ]);
    }
  }
  if (ranges.length === 0) return source;

  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }

  let redacted = "";
  let offset = 0;
  for (const [start, end] of merged) {
    redacted += source.slice(offset, start) + replacement;
    offset = end;
  }
  return redacted + source.slice(offset);
}

export function findSecretMatches(content) {
  const matches = [];
  const lines = content.split(/\r?\n/);

  for (const [lineIndex, line] of lines.entries()) {
    for (const pattern of secretPatterns) {
      if (pattern.regex.test(line)) {
        matches.push({
          line: lineIndex + 1,
          label: pattern.label,
        });
      }
    }
  }

  return matches;
}
