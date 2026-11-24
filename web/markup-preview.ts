const SCANNED_LENGTH = 8000;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function withoutTemplates(text: string): string {
  let output = '';
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith('{{', index)) {
      depth++;
      index++;
    } else if (depth && text.startsWith('}}', index)) {
      depth--;
      index++;
      if (!depth) output += ' ';
    } else if (!depth) output += text[index];
  }
  return output;
}

export function markupPreview(text: string, maxLength: number): string {
  return withoutTemplates(text.slice(0, SCANNED_LENGTH))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ')
    .replace(/<\/?[a-z][^>]*>?/giu, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_, name: string) => ENTITIES[name]!)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}
