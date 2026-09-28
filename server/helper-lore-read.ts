import {
  chatAttachmentKey,
  chatLoreKey,
  chatOverrideHash,
  validateChatLoreSelector,
} from '../core/chat-overrides.js';
import { ChatOverridesStore } from './chat-overrides.js';
import { HttpError, number } from './request-validation.js';
import type { Store } from './store.js';

const MAX_RESULT_CHARS = 24_000;

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

/** Model-facing pages only; the UI and override save service retain their full models. */
export function readHelperChatLore(store: Store, chatId: string, args: Record<string, unknown>) {
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
    if (!lore && !override) throw new HttpError(404, '선택한 채팅 로어가 없어요.');
    const original = lore?.[selector.field] ?? null;
    const offset = number(
      args.textOffset ?? 0,
      'text offset',
      0,
      Math.max(original?.length ?? 0, override?.value.length ?? 0)
    );
    const limit = number(args.textLimit ?? 4000, 'text limit', 1, 10000);
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
      original: original === null ? null : textPage(original, offset, length),
      override: override
        ? {
            id: override.id,
            revision: override.revision,
            ...textPage(override.value, offset, length),
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
      if (JSON.stringify(page(middle)).length <= MAX_RESULT_CHARS) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (!best) throw new HttpError(413, '읽기 결과가 커요. 더 좁은 범위를 지정해 주세요.');
    return page(best);
  }
  const entries = [
    ...current.attachments.flatMap((attachment) =>
      attachment.lore.map((lore) => ({ attachment, lore }))
    ),
    ...current.overrides
      .filter(
        (override) =>
          !current.attachments.some(
            (attachment) =>
              chatAttachmentKey(attachment.scope) === chatAttachmentKey(override.selector) &&
              attachment.lore.some((lore) => lore.id === override.selector.loreId)
          )
      )
      .map((override) => ({ override })),
  ];
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
      });
    }
    if (JSON.stringify(page()).length > MAX_RESULT_CHARS) {
      items.pop();
      if (!items.length) throw new HttpError(413, '로어 목록을 더 좁게 읽어 주세요.');
      break;
    }
  }
  return page();
}
