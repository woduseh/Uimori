import type { RunSnapshot, ToolEvent } from './types.js';
import type { ToolAction } from './provider.js';
import { memoryHash } from './memory.js';

export const TRANSLATION_READ_NAMES = ['translation.search', 'translation.read'];
export type TranslationReference = {
  id: string;
  revision: number;
  sourceRevision: string;
  sourceHash: string;
  text: string;
  manual: boolean;
};
/** Detached wording evidence. Current source and author declarations always take precedence. */
export function translationReader(
  snapshot: RunSnapshot,
  references: readonly TranslationReference[]
) {
  const hashes = new Map(
    snapshot.history.map((item) => [item.revision, item.contentHash ?? memoryHash(item.text)])
  );
  const originals = new Map(snapshot.history.map((item) => [item.revision, item.text]));
  const scope = structuredClone(
    references.filter((item) => hashes.get(item.sourceRevision) === item.sourceHash)
  );
  return (action: ToolAction): ToolEvent => {
    const denied = (code: string): ToolEvent => ({
      callId: action.callId,
      name: action.name,
      args: {},
      result: { code },
      denied: true,
    });
    const { args } = action;
    const search = action.name === 'translation.search';
    if (!TRANSLATION_READ_NAMES.includes(action.name)) return denied('TOOL_NOT_ALLOWED');
    if (
      Object.keys(args).some(
        (key) => !(search ? ['query', 'offset', 'limit'] : ['id', 'offset', 'limit']).includes(key)
      )
    )
      return denied('INVALID_ARGUMENTS');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? (search ? 20 : 4096);
    if (
      !Number.isSafeInteger(offset) ||
      Number(offset) < 0 ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > (search ? 50 : 4096)
    )
      return denied('INVALID_ARGUMENTS');
    const metadata = ({ text, ...item }: TranslationReference) => ({
      ...item,
      translationHash: memoryHash(text),
      totalChars: text.length,
      use: 'wording-reference-only',
    });
    if (search) {
      if (typeof args.query !== 'string' || args.query.length > 512)
        return denied('INVALID_ARGUMENTS');
      const terms = args.query.toLocaleLowerCase('en').split(/\s+/u).filter(Boolean);
      const found = scope.filter((item) =>
        terms.every((term) =>
          `${originals.get(item.sourceRevision) ?? ''} ${item.text}`
            .toLocaleLowerCase('en')
            .includes(term)
        )
      );
      const end = Number(offset) + Number(limit);
      return {
        ...action,
        denied: false,
        result: {
          items: found.slice(Number(offset), end).map(metadata),
          total: found.length,
          nextOffset: end < found.length ? end : null,
        },
      };
    }
    if (typeof args.id !== 'string' || args.id.length > 200) return denied('INVALID_ARGUMENTS');
    const item = scope.find((item) => item.id === args.id);
    if (!item || Number(offset) > item.text.length) return denied('RESOURCE_UNAVAILABLE');
    const end = Math.min(item.text.length, Number(offset) + Number(limit));
    return {
      ...action,
      denied: false,
      result: {
        source: metadata(item),
        text: item.text.slice(Number(offset), end),
        range: { start: offset, end, unit: 'utf16-code-unit' },
        nextOffset: end < item.text.length ? end : null,
      },
    };
  };
}
