/** Risu reads `@@name arg` lines at the top of a lore entry as directives, not as prose. */
export type RisuLoreDecorator = { name: string; args: string[] };
export type RisuLoreContent = {
  decorators: RisuLoreDecorator[];
  text: string;
  /** A directive line after the leading block is reported instead of being interpreted. */
  trailing: boolean;
};
const LINE = /^@@([a-z_]+)(?:[ \t]+(.*))?$/u;

export function parseRisuLoreContent(content: string): RisuLoreContent {
  const lines = content.split('\n');
  const decorators: RisuLoreDecorator[] = [];
  // Only a leading block counts, and text without one keeps its own blank lines exactly.
  let consumed = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/u, '').trim();
    if (!line && !decorators.length) continue;
    const match = LINE.exec(line);
    if (!match) break;
    decorators.push({
      name: match[1],
      args: (match[2] ?? '')
        .split(/[ \t]+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    });
    consumed = index + 1;
  }
  const rest = lines.slice(consumed);
  return {
    decorators,
    text: rest.join('\n'),
    trailing: rest.some((line) => LINE.test(line.replace(/\r$/u, '').trim())),
  };
}

/** Entries Risu never activates carry data or code for the material itself, not model context. */
export const risuLoreNeverActivates = (parsed: RisuLoreContent): boolean =>
  parsed.decorators.some((item) => item.name === 'dont_activate');
export const risuLoreAlwaysActivates = (parsed: RisuLoreContent): boolean =>
  parsed.decorators.some((item) => item.name === 'activate');
