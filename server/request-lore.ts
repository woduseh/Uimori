import type { RequestLore } from '../core/request-lore.js';
import type { Json, ProviderRequest, WireRecord } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';
import { serializeRisuLoreSources, type RisuContextSource } from '../core/risu-context-source.js';
import {
  loreSelectionKey,
  loreSelectionLore,
  projectLoreSelectionReceipt,
} from '../core/lore-selection.js';

type LoreIdentity = {
  id: string;
  text?: string;
  title?: string;
  kind?: string;
  sourceKind?: string;
  risuSource?: RisuContextSource;
};
type PinnedSource = LoreIdentity & { text: string };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const escaped = (text: string) => JSON.stringify(text).slice(1, -1);

/** Inspect string leaves only: HTTP/RPC encoders already own parsing and serialization. */
function wireText(value: Json, result: string[] = []): string[] {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const item of value) wireText(item, result);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) wireText(item, result);
  return result;
}

/** Match the entry inside its own source block, not an equal/short body elsewhere in the request. */
function hasLoreEntry(texts: readonly string[], item: PinnedSource): boolean {
  if (!item.risuSource?.entryId || !item.text.trim()) return false;
  const xml = serializeRisuLoreSources([item]);
  const start = xml.indexOf('<source ');
  const header = xml.slice(start, xml.indexOf('\n', start));
  const entry = xml.slice(xml.indexOf('<entry '), xml.lastIndexOf('</entry>') + '</entry>'.length);
  for (const encode of [(value: string) => value, escaped]) {
    const opening = encode(header),
      closing = encode('</source>'),
      body = encode(entry);
    for (const text of texts) {
      let at = text.indexOf(opening);
      while (at >= 0) {
        const end = text.indexOf(closing, at + opening.length);
        if (end >= 0 && text.slice(at, end).includes(body)) return true;
        at = text.indexOf(opening, at + opening.length);
      }
    }
  }
  return false;
}

/** Final wire evidence supplements known host paths; selection/catalog metadata alone proves nothing. */
export function requestLore(
  snapshot: RunSnapshot,
  request: ProviderRequest,
  wire: WireRecord,
  options: {
    pinned: readonly PinnedSource[];
    catalog?: readonly LoreIdentity[];
    sourceOnly?: boolean;
  }
): RequestLore {
  if (options.sourceOnly) return { status: 'complete', entries: [] };
  // Labels do not require another package compilation or token-budget calculation.
  const resources = new Map<string, LoreIdentity>();
  for (const item of [
    ...snapshot.resources.filter((entry) => entry.chatId === snapshot.chatId),
    ...(options.catalog ?? []),
    ...options.pinned,
  ])
    resources.set(item.id, { ...resources.get(item.id), ...item });
  let texts: string[] | undefined;
  // Only lore evidence needs this scan. Gemini uses objects; other adapters embed them in text.
  const evidence = () => (texts ??= [...wireText(wire.body), JSON.stringify(wire.body)]);
  const contains = (value: unknown) => {
    const text = JSON.stringify(value);
    if (text === undefined) return false;
    const encoded = escaped(text);
    return evidence().some((part) => part.includes(text) || part.includes(encoded));
  };
  const entries: RequestLore['entries'] = [];
  // Both always-pinned and JEV-selected bodies share the delivery list. Keep their
  // origin distinct using this run's frozen receipt, without recompiling packages.
  const selected = new Set<string>();
  const sourceKey = (contentId: string, role: string, entryId: string) =>
    JSON.stringify([contentId, role, entryId]);
  for (const attachment of snapshot.profile?.packageAttachments ?? []) {
    const pkg = snapshot.profile?.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    const chosen =
      snapshot.loreSelection &&
      projectLoreSelectionReceipt(snapshot.loreSelection, loreSelectionKey(attachment));
    if (!pkg || !chosen) continue;
    for (const lore of loreSelectionLore(pkg))
      if (chosen.has(lore.id)) selected.add(sourceKey(pkg.id, attachment.role, lore.id));
  }
  const add = (
    identity: LoreIdentity,
    via: RequestLore['entries'][number]['via'],
    delivery: () => RequestLore['entries'][number]['delivery']
  ) => {
    const resource = { ...resources.get(identity.id), ...identity };
    if (resource.kind !== 'lore' || (resource.sourceKind && resource.sourceKind !== 'lore')) return;
    const source = resource.risuSource;
    const id = resource.id;
    const entry: RequestLore['entries'][number] = {
      id,
      title: source?.title ?? resource.title ?? id,
      ...(source
        ? {
            source: {
              contentId: source.contentId,
              ...(source.entryId ? { entryId: source.entryId } : {}),
              sourceName: source.sourceName,
            },
          }
        : {}),
      via,
      delivery: delivery(),
    };
    if (
      !entries.some(
        (item) => item.id === id && item.via === via && item.delivery === entry.delivery
      )
    )
      entries.push(entry);
  };
  for (const item of options.pinned) {
    if (!item.text.trim()) continue;
    const source = item.risuSource;
    const via =
      source?.entryId &&
      selected.has(sourceKey(source.contentId, source.sourceRole, source.entryId))
        ? 'selected'
        : 'pinned';
    add(item, via, () =>
      contains(item) || hasLoreEntry(evidence(), item) ? 'full' : 'unverified'
    );
  }
  if (request.role === 'main')
    for (const retained of snapshot.loreContext?.entries ?? []) {
      const { lastUsed: _lastUsed, ...sent } = retained;
      add({ id: retained.id, title: retained.title, kind: 'lore' }, 'retained', () => {
        if (!contains(sent)) return 'unverified';
        return retained.start === 0 && retained.text === resources.get(retained.id)?.text
          ? 'full'
          : 'excerpt';
      });
    }
  const source = object(request.input.source);
  const events = [
    ...array(request.input.results),
    ...array(object(source?.completedToolHistory)?.events),
  ];
  for (const raw of events) {
    const event = object(raw),
      result = object(event?.result);
    if (!event || event.denied || !result) continue;
    if (result.kind === 'host-compacted-reads') {
      let delivery: 'summary' | 'unverified' | undefined;
      for (const rawReference of array(result.references)) {
        const reference = object(rawReference);
        if (reference?.name !== 'knowledge.read') continue;
        for (const item of array(object(reference.returned)?.items)) {
          const identity = object(object(item)?.source);
          if (typeof identity?.id !== 'string') continue;
          add(
            identity as LoreIdentity,
            'tool-result',
            () => (delivery ??= contains(result) ? 'summary' : 'unverified')
          );
        }
      }
      continue;
    }
    if (event.name !== 'knowledge.read' && event.name !== 'knowledge.search') continue;
    for (const rawItem of array(result.items)) {
      const item = object(rawItem);
      if (item?.denied) continue;
      const read = object(event.name === 'knowledge.read' ? item?.read : item?.match);
      const identity = object(read?.source);
      if (!read || typeof identity?.id !== 'string' || typeof read.text !== 'string' || !read.text)
        continue;
      const range = object(read.range);
      add(identity as LoreIdentity, 'tool-result', () =>
        contains(read)
          ? range?.start === 0 && range.end === read.totalChars
            ? 'full'
            : 'excerpt'
          : 'unverified'
      );
    }
  }
  return {
    status: entries.some((item) => item.delivery === 'unverified') ? 'partial' : 'complete',
    entries,
  };
}
