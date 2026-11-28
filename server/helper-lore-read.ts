import { DEFAULT_READ_FIT, type HelperReadFit } from './helper-read-fit.js';
import { textTokenExcerpt } from '../core/text-tokens.js';
import {
  CHAT_LORE_FIELDS,
  chatAttachmentKey,
  chatLoreKey,
  chatOverrideHash,
  validateChatLoreSelector,
} from '../core/chat-overrides.js';
import { ChatOverridesStore } from './chat-overrides.js';
import { HelperToolError } from './app-errors.js';
import { number, text } from './request-validation.js';
import type { Store } from './store.js';

function textPage(value: string, offset: number, limit: number) {
  let start = Math.min(offset, value.length);
  if (start && /[\uDC00-\uDFFF]/u.test(value[start] ?? '')) start--;
  let end = Math.min(value.length, start + limit);
  if (end < value.length && /[\uDC00-\uDFFF]/u.test(value[end] ?? '')) end--;
  if (end === start && start < value.length) end = Math.min(value.length, start + 2);
  return {
    text: value.slice(start, end),
    offset: start,
    totalChars: value.length,
    nextOffset: end < value.length ? end : null,
  };
}

export function readHelperChatLore(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  fits: HelperReadFit = DEFAULT_READ_FIT
) {
  const current = new ChatOverridesStore(store).get(chatId);
  const head = {
    chatId,
    revision: current.revision,
    headRevision: current.headRevision,
    profileRevision: current.profileRevision,
  };
  if (args.selector !== undefined) {
    const selector = validateChatLoreSelector(args.selector);
    const attachment = current.attachments.find(
      (item) => chatAttachmentKey(item.scope) === chatAttachmentKey(selector)
    );
    const lore = attachment?.lore.find((item) => item.id === selector.loreId);
    const override = current.overrides.find(
      (item) => chatLoreKey(item.selector) === chatLoreKey(selector)
    );
    if (!lore && !override) throw new HelperToolError(404, 'CHAT_LORE_NOT_FOUND');
    const original = lore?.[selector.field] ?? null;
    const offset = number(
      args.textOffset ?? 0,
      'text offset',
      0,
      Math.max(original?.length ?? 0, override?.value.length ?? 0)
    );
    const defaultLength = (value: string | null | undefined) => {
      if (value == null || args.textLimit !== undefined) return 0;
      let start = Math.min(offset, value.length);
      if (start && /[\uDC00-\uDFFF]/u.test(value[start] ?? '')) start--;
      return textTokenExcerpt(value.slice(start), 2_000).text.length;
    };
    const originalLimit = defaultLength(original);
    const overrideLimit = defaultLength(override?.value);
    const limit =
      args.textLimit === undefined
        ? Math.max(1, originalLimit, overrideLimit)
        : number(args.textLimit, 'text limit', 1, 10000);
    const patchGuards =
      attachment && original !== null
        ? {
            expectedProfileRevision: current.profileRevision,
            expectedPackageRevision: attachment.packageRevision,
            expectedFieldHash: chatOverrideHash(original),
          }
        : {};
    const page = (length: number) => ({
      ...head,
      selector,
      expectedRevision: current.revision,
      expectedHeadRevision: current.headRevision,
      ...patchGuards,
      original:
        original === null
          ? null
          : textPage(
              original,
              offset,
              args.textLimit === undefined ? Math.min(length, originalLimit) : length
            ),
      override: override
        ? {
            id: override.id,
            revision: override.revision,
            ...textPage(
              override.value,
              offset,
              args.textLimit === undefined ? Math.min(length, overrideLimit) : length
            ),
            conflicts: current.conflicts
              .filter((item) => item.overrideId === override.id)
              .map((item) => item.kind),
          }
        : null,
    });
    let low = 1,
      high = limit,
      best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(page(middle))) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (!best) throw new HelperToolError(413, 'HELPER_READ_TOO_LARGE', 'Read a narrower range');
    return page(best);
  }
  const query =
    args.query === undefined
      ? undefined
      : text(args.query, 'lore query', 200, true).trim().toLowerCase() || undefined;
  const bySelector = new Map(
    current.overrides.map((override) => [chatLoreKey(override.selector), override])
  );
  const attached = current.attachments.flatMap((attachment) =>
    attachment.lore.map((lore) => {
      const overrides = CHAT_LORE_FIELDS.flatMap((field) => {
        const key = chatLoreKey({ ...attachment.scope, loreId: lore.id, field });
        const override = bySelector.get(key);
        if (!override) return [];
        bySelector.delete(key);
        return [override];
      });
      return { attachment, lore, overrides };
    })
  );
  const entries = [
    ...attached,
    ...Array.from(bySelector.values(), (override) => ({ override })),
  ].filter((entry) => {
    if (query === undefined) return true;
    const texts =
      'override' in entry
        ? [entry.override.baseEntry.title, entry.override.value]
        : [
            entry.lore.title,
            entry.lore.description,
            entry.lore.text,
            ...entry.overrides.map((override) => override.value),
          ];
    return texts.some((value) => value.toLowerCase().includes(query));
  });
  const offset = number(args.offset ?? 0, 'lore offset', 0, entries.length);
  const limit = number(args.limit ?? 20, 'lore limit', 1, 50);
  const items: Record<string, unknown>[] = [];
  const page = () => ({
    ...head,
    items,
    total: entries.length,
    nextOffset: offset + items.length < entries.length ? offset + items.length : null,
  });
  for (const entry of entries.slice(offset, offset + limit)) {
    if ('override' in entry) {
      const { override } = entry;
      const { id, role, modulePath, loreId } = override.selector;
      items.push({
        scope: { id, role, modulePath },
        id: loreId,
        selector: override.selector,
        title: override.baseEntry.title,
        originalMissing: true,
        overrideId: override.id,
        conflicts: current.conflicts
          .filter((item) => item.overrideId === override.id)
          .map((item) => item.kind),
      });
    } else {
      const { attachment, lore } = entry;
      const overrides = entry.overrides.map((override) => ({
        field: override.selector.field,
        id: override.id,
        conflicts: current.conflicts
          .filter((item) => item.overrideId === override.id)
          .map((item) => item.kind),
      }));
      items.push({
        scope: attachment.scope,
        packageId: attachment.packageId,
        packageRevision: attachment.packageRevision,
        id: lore.id,
        title: lore.title,
        description: textPage(lore.description, 0, 200),
        textLength: lore.text.length,
        fieldHashes: {
          title: chatOverrideHash(lore.title),
          description: chatOverrideHash(lore.description),
          text: chatOverrideHash(lore.text),
        },
        ...(overrides.length ? { overrides } : {}),
      });
    }
    if (!fits(page())) {
      items.pop();
      if (!items.length)
        throw new HelperToolError(413, 'HELPER_READ_TOO_LARGE', 'Read fewer lore items');
      break;
    }
  }
  return page();
}
