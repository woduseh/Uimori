import type { RisuContent } from './risu-content.js';
import { nativeRisuLore, nativeRisuRegex, type RisuContentSource } from './risu-native.js';

export type RisuImageHandoff = {
  version: 1;
  ranges: {
    id: string;
    field: string;
    start: number;
    end: number;
    text: string;
    enabled: boolean;
    confidence: 'dedicated' | 'section' | 'candidate';
  }[];
  tagTemplates: string[];
};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const cardFields = ['description', 'mes_example', 'post_history_instructions'] as const;
export function imageHandoffSource(native: RisuContentSource, field: string): string {
  if (
    field.startsWith('card:') &&
    cardFields.includes(field.slice(5) as (typeof cardFields)[number])
  )
    return text(native.card[field.slice(5)]);
  const match = /^lore:lore-(\d+)$/u.exec(field);
  return match ? text(nativeRisuLore(native)[Number(match[1])]?.content) : '';
}
const activeField = (field: string) =>
  !field.startsWith('card:') || cardFields.includes(field.slice(5) as (typeof cardFields)[number]);

/** Runtime text after selected image instructions are handed to image placement. */
export function risuImageHandoffText(pkg: RisuContent, field: string): string {
  if (!activeField(field)) return '';
  const source = imageHandoffSource(pkg.nativeRisu, field);
  return (pkg.imageHandoff?.ranges ?? [])
    .filter(
      (range) =>
        range.enabled &&
        range.field === field &&
        source.slice(range.start, range.end) === range.text
    )
    .sort((a, b) => b.start - a.start)
    .reduce((value, range) => value.slice(0, range.start) + value.slice(range.end), source);
}

/** Recognize explicit image instruction headings, never narrative mentions of an image. */
export function detectRisuImageHandoff(
  native: RisuContentSource,
  previous?: RisuImageHandoff
): RisuImageHandoff | undefined {
  const patterns = nativeRisuRegex(native)
    .filter((rule) => rule.type === 'editdisplay')
    .map((rule) => rule.in);
  const templates = [
    ...(patterns.some((pattern) => /img.*src=/iu.test(pattern)) ? ['<img src={asset}>'] : []),
    ...(patterns.some(
      (pattern) => /img/iu.test(pattern) && /=/u.test(pattern) && !/src=/u.test(pattern)
    )
      ? ['<img="{asset}">']
      : []),
  ];
  if (!templates.length) return undefined;
  const ranges: RisuImageHandoff['ranges'] = [];
  const add = (
    field: string,
    source: string,
    start: number,
    end: number,
    confidence: RisuImageHandoff['ranges'][number]['confidence']
  ) => {
    const raw = source.slice(start, end);
    if (!raw.trim() || raw.length > 64_000 || ranges.length >= 64) return;
    const prior = Array.isArray(previous?.ranges)
      ? previous.ranges.find(
          (range) =>
            range &&
            range.field === field &&
            range.text === raw &&
            typeof range.enabled === 'boolean'
        )
      : undefined;
    ranges.push({
      id: `image-${ranges.length}`,
      field,
      start,
      end,
      text: raw,
      confidence,
      enabled: prior?.enabled ?? confidence !== 'candidate',
    });
  };
  const imageHeading = /(?:image|이미지|삽화).*(?:tag|insert|output|규칙|출력|삽입|system)/iu;
  for (const [index, entry] of nativeRisuLore(native).entries()) {
    if (entry.enabled === false || entry.mode === 'folder') continue;
    const source = text(entry.content),
      title = text(entry.comment) || text(entry.name);
    if (imageHeading.test(title) && /<img[\s=]/iu.test(source))
      add(`lore:lore-${index}`, source, 0, source.length, 'dedicated');
  }
  for (const name of cardFields) {
    const source = text(native.card[name]);
    const headings = [...source.matchAll(/^(?:[A-Z]\. |#{1,6} )[^\r\n]+/gmu)];
    for (const [index, heading] of headings.entries()) {
      if (!imageHeading.test(heading[0])) continue;
      const start = heading.index,
        end = headings[index + 1]?.index ?? source.length;
      const selected = source.slice(start, end);
      if (!/<img[\s=]/iu.test(selected)) continue;
      // Unbalanced CBS at the boundary cannot be moved automatically.
      const opens = [...selected.matchAll(/\{\{#(?:if|when|each|pure|func)\b/gu)].length;
      const closes = [...selected.matchAll(/\{\{\/(?:if|when|each|pure|func)\}\}/gu)].length;
      add(`card:${name}`, source, start, end, opens === closes ? 'section' : 'candidate');
    }
  }
  return { version: 1, ranges, tagTemplates: templates };
}

export function validateRisuImageHandoff(
  value: unknown,
  native: RisuContentSource
): RisuImageHandoff {
  const policy = value as RisuImageHandoff;
  if (
    !policy ||
    policy.version !== 1 ||
    !Array.isArray(policy.ranges) ||
    policy.ranges.length > 64 ||
    !Array.isArray(policy.tagTemplates) ||
    policy.tagTemplates.length > 8 ||
    Object.keys(policy).some((key) => !['version', 'ranges', 'tagTemplates'].includes(key))
  )
    throw new Error('PACKAGE_IMAGE_HANDOFF_INVALID');
  const ids = new Set<string>();
  const occupied = new Map<string, { start: number; end: number }[]>();
  for (const range of policy.ranges) {
    if (
      !range ||
      Object.keys(range).some(
        (key) => !['id', 'field', 'start', 'end', 'text', 'enabled', 'confidence'].includes(key)
      ) ||
      typeof range.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(range.id) ||
      ids.has(range.id) ||
      typeof range.field !== 'string' ||
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      typeof range.text !== 'string' ||
      range.text.length > 64_000 ||
      typeof range.enabled !== 'boolean' ||
      !['dedicated', 'section', 'candidate'].includes(range.confidence)
    )
      throw new Error('PACKAGE_IMAGE_HANDOFF_RANGE');
    ids.add(range.id);
    if (imageHandoffSource(native, range.field).slice(range.start, range.end) !== range.text)
      throw new Error('PACKAGE_IMAGE_HANDOFF_STALE');
    const sameField = occupied.get(range.field) ?? [];
    if (sameField.some((previous) => range.start < previous.end && previous.start < range.end))
      throw new Error('PACKAGE_IMAGE_HANDOFF_OVERLAP');
    occupied.set(range.field, [...sameField, { start: range.start, end: range.end }]);
  }
  for (const template of policy.tagTemplates)
    if (
      typeof template !== 'string' ||
      template.length > 500 ||
      template.split('{asset}').length !== 2 ||
      /[\r\n]/u.test(template)
    )
      throw new Error('PACKAGE_IMAGE_HANDOFF_TAG');
  return structuredClone(policy);
}

/** Host-owned projection only; original native documents and saved package remain untouched. */
export function projectRisuImageHandoff(pkg: RisuContent, enabled: boolean): RisuContent {
  if (!enabled || !pkg.nativeRisu || !pkg.imageHandoff) return pkg;
  const native = pkg.nativeRisu;
  const ranges = pkg.imageHandoff.ranges.filter(
    (range) =>
      range.enabled &&
      activeField(range.field) &&
      imageHandoffSource(native, range.field).slice(range.start, range.end) === range.text
  );
  if (!ranges.length) return pkg;
  const remove = (field: string, source: string) =>
    ranges
      .filter((range) => range.field === field)
      .sort((a, b) => b.start - a.start)
      .reduce((value, range) => value.slice(0, range.start) + value.slice(range.end), source);
  const body = remove('card:description', text(native.card.description));
  return {
    ...pkg,
    body,
    lore: pkg.lore.map((entry) => {
      const source = imageHandoffSource(native, `lore:${entry.id}`);
      const selected = ranges.filter((range) => range.field === `lore:${entry.id}`);
      if (!selected.length) return entry;
      const next = remove(`lore:${entry.id}`, source).trim();
      return { ...entry, text: next };
    }),
  };
}

export function risuImageGuidance(pkg: RisuContent): string {
  if (!pkg.nativeRisu || !pkg.imageHandoff) return '';
  return pkg.imageHandoff.ranges
    .filter(
      (range) =>
        range.enabled &&
        activeField(range.field) &&
        imageHandoffSource(pkg.nativeRisu!, range.field).slice(range.start, range.end) ===
          range.text
    )
    .map((range) => range.text)
    .join('\n\n');
}
