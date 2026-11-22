import type { HelperReferencePointer } from '../core/helper.js';

export type MentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export function referenceKey(ref: HelperReferencePointer): string {
  return `${ref.kind}:${ref.id}`;
}

export function findMentionTrigger(value: string, cursor: number): MentionTrigger | null {
  if (cursor < 1 || cursor > value.length) return null;
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/u.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 60 || /[\r\n]/u.test(query) || /\s{2}/u.test(query)) return null;
  return { start: at, end: cursor, query };
}

export function applyMentionReplacement(
  value: string,
  trigger: MentionTrigger,
  label: string
): { text: string; cursor: number } {
  const inserted = `@${label}`;
  const after = value.slice(trigger.end);
  const needsSpace = !after || !/^\s/u.test(after);
  const replacement = needsSpace ? `${inserted} ` : inserted;
  const text = `${value.slice(0, trigger.start)}${replacement}${after}`;
  return { text, cursor: trigger.start + replacement.length };
}
