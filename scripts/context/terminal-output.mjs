const ansiEscapePattern =
  /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/g;
const formatControlPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;

export function sanitizeForTerminal(value) {
  return String(value)
    .replace(ansiEscapePattern, "")
    .replace(controlPattern, " ")
    .replace(formatControlPattern, "");
}

export function truncateForTerminal(value, maxLength = 180) {
  const sanitized = sanitizeForTerminal(value).trim();
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, maxLength - 3)}...`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatContextError(error, rootPath = process.cwd()) {
  let message = error instanceof Error ? error.message : String(error);
  const normalizedRoot = String(rootPath).replaceAll("\\", "/").replace(/\/$/, "");
  if (normalizedRoot) {
    const rootPattern = new RegExp(escapeRegExp(normalizedRoot), "g");
    message = message.replaceAll("\\", "/").replace(rootPattern, ".");
  }
  message = message
    .replace(/file:\/\/(?:\/[A-Za-z]:)?\/[^\s)]+/gi, "<local-path>")
    .replace(/(?:^|[\s"'(=])(?:[A-Za-z]:\/|\/)[^\s"')<>]*/g, (match) => {
      const prefix = /^[\s"'(=]/.test(match) ? match[0] : "";
      return `${prefix}<local-path>`;
    });
  return truncateForTerminal(message, 500);
}
