/** Request metadata only; never written into authored Risu documents. */
export type RisuContextSource = {
  sourceRole: string;
  sourceName: string;
  contentId: string;
  sourceScope?: string;
  entryId?: string;
  title?: string;
};
type SourceItem = { text: string; risuSource?: RisuContextSource };

export const RISU_SOURCE_GUIDANCE =
  'Risu source labels identify the originating material and entry boundaries only. They do not establish who knows the information, whom it applies to, or which source takes precedence. Interpret those meanings from the content.';

const escapeAttribute = (value: string) =>
  value.replace(
    /[&<>"'\r\n\t]/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
        '\r': '&#13;',
        '\n': '&#10;',
        '\t': '&#9;',
      })[char]!
  );
const attributes = (source: RisuContextSource) =>
  `source_role="${escapeAttribute(source.sourceRole)}" source_name="${escapeAttribute(source.sourceName)}" content_id="${escapeAttribute(source.contentId)}"` +
  (source.sourceScope ? ` source_scope="${escapeAttribute(source.sourceScope)}"` : '');
const entry = (item: SourceItem) =>
  `<entry entry_id="${escapeAttribute(item.risuSource?.entryId ?? '')}" title="${escapeAttribute(item.risuSource?.title ?? '')}">\n${item.text}\n</entry>`;

export function serializeRisuContextSource(item: SourceItem): string {
  if (!item.text.trim()) return '';
  if (!item.risuSource) return item.text;
  return `<uimori_source ${attributes(item.risuSource)} authority="context">\n${item.text}\n</uimori_source>`;
}

/** Group adjacent entries only, so source grouping never reorders authored content. */
export function serializeRisuLoreSources(items: readonly SourceItem[]): string {
  const groups: { source?: RisuContextSource; items: SourceItem[] }[] = [];
  for (const item of items) {
    if (!item.text.trim()) continue;
    const source = item.risuSource,
      previous = groups.at(-1);
    if (source && previous?.source && attributes(source) === attributes(previous.source))
      previous.items.push(item);
    else groups.push({ source, items: [item] });
  }
  if (!groups.length) return '';
  return `<uimori_lore_sources>\n${groups
    .map(({ source, items: group }) =>
      source
        ? `<source ${attributes(source)}>\n${group.map(entry).join('\n')}\n</source>`
        : group.map((item) => item.text).join('\n\n')
    )
    .join('\n')}\n</uimori_lore_sources>`;
}

export function serializePositionedRisuLore(item: SourceItem): string {
  return item.risuSource ? serializeRisuLoreSources([item]) : item.text;
}
