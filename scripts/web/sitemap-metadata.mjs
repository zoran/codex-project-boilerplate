export function parseSitemapEntries(sitemap) {
  return [...sitemap.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map((match, index) => {
    const block = match[0];
    return {
      index,
      block,
      loc: textFromTag(block, "loc"),
      lastmod: textFromTag(block, "lastmod"),
    };
  });
}

export function textFromTag(block, tagName) {
  const escapedTagName = escapeRegExp(tagName);
  const match = new RegExp(
    `<${escapedTagName}\\b[^>]*>\\s*([^<]+?)\\s*<\\/${escapedTagName}>`,
    "i",
  ).exec(block);
  return match?.[1].trim() ?? "";
}

export function isIso8601Timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText ?? "0");
  const offsetMinute = Number(offsetMinuteText ?? "0");

  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    Number.isNaN(Date.parse(value))
  ) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function canonicalUrlFromHtml(content) {
  for (const match of content.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const relValues = tagAttribute(tag, "rel").toLowerCase().split(/\s+/).filter(Boolean);
    if (relValues.includes("canonical")) return tagAttribute(tag, "href");
  }
  return "";
}

export function hasRobotsNoindex(content) {
  return [...content.matchAll(/<meta\b[^>]*>/gi)].some((match) => {
    const tag = match[0];
    return (
      tagAttribute(tag, "name").toLowerCase() === "robots" &&
      /\bnoindex\b/i.test(tagAttribute(tag, "content"))
    );
  });
}

export function tagAttribute(tag, name) {
  const match = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag);
  return match?.[2]?.trim() ?? "";
}

export function httpUrlOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
