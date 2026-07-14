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
