export function splitsSurrogatePair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/u.test(text[index - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[index]!)
  );
}

export function textPageEnd(text: string, offset: number, limit: number): number {
  const end = Math.min(text.length, offset + limit);
  if (!splitsSurrogatePair(text, end)) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

export function clipText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, textPageEnd(text, 0, maxChars - 1))}…` : text;
}
