const normalizeWhitespace = (value: string) => value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function markdownToPlainText(markdown: string): string {
  let text = markdown;
  text = text.replace(/<[^>]*>/g, "");
  text = text.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string, url: string) =>
    label === url ? url : `${label} (${url})`
  );
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s?/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  return normalizeWhitespace(text);
}

export function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

export function renderSmsText(input: {
  senderName: string;
  body: string;
  replySenderName?: string;
  replyBody?: string;
  maxLength: number;
}): string {
  const body = markdownToPlainText(input.body);
  const prefix = input.replyBody
    ? `${input.senderName} → ${input.replySenderName ?? "member"} “${truncateText(markdownToPlainText(input.replyBody), 72)}”: `
    : `${input.senderName}: `;
  return truncateText(`${prefix}${body}`, input.maxLength);
}

export function localDayKey(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
