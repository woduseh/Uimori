import { randomUUID } from 'node:crypto';
import type { ChatCopyAuthoring } from '../core/chat-backup.js';
import type { ChatLoreOverride } from '../core/chat-overrides.js';
import type { SourceHistoryItem } from '../core/source-history.js';
import { ChatOverridesStore } from './chat-overrides.js';
import { ChatOptionsStore } from './chat-options.js';
import { OutlineStore } from './outline-store.js';
import { resolvePackageProfile } from './package-features.js';
import type { Store } from './store.js';
import { HttpError } from './request-validation.js';

/** Copy current user-authored plans/settings, not tasks, grants or execution receipts. */
export function captureChatAuthoring(
  store: Store,
  chatId: string,
  branchId: string,
  history: readonly SourceHistoryItem[]
): ChatCopyAuthoring {
  const profile = store.product.profile(chatId);
  const resolved = resolvePackageProfile(store.product, profile);
  const overrides = new ChatOverridesStore(store).freeze(
    { ...profile, ...resolved, models: {} },
    profile.packageAttachments ?? [],
    history.at(-1)?.revision ?? null
  );
  return {
    outline: new OutlineStore(store)
      .nodes(chatId, branchId)
      .map(({ id, parentId, level, position, title, intent, fixed }) => ({
        id,
        parentId,
        level,
        position,
        title,
        intent,
        fixed,
      })),
    options: new ChatOptionsStore(store).get(chatId, branchId).fixedValues,
    lore: overrides.entries
      .filter((entry) => !entry.retired)
      .map(
        ({
          id: _id,
          chatId: _chat,
          revision: _revision,
          atSource,
          atHash: _hash,
          retired: _retired,
          createdAt: _time,
          ...data
        }) => ({
          ...data,
          atIndex:
            atSource === null ? null : history.findIndex((item) => item.revision === atSource),
        })
      ),
  };
}

export function remapChatAuthoring(
  authoring: ChatCopyAuthoring,
  resources: ReadonlyMap<string, string>
): void {
  const remap = (id: string) => {
    const target = resources.get(id);
    if (!target) throw new HttpError(400, '채팅 전용 로어의 원본 자료가 백업에 없어요.');
    return target;
  };
  for (const entry of authoring.lore) {
    entry.selector.id = remap(entry.selector.id);
    entry.selector.modulePath = entry.selector.modulePath.map(remap);
    entry.baseRootRevision = 1;
    entry.basePackageRevision = 1;
    entry.baseModuleRevisions = entry.baseModuleRevisions.map((ref) => ({
      id: remap(ref.id),
      revision: 1,
    }));
  }
}

export function restoreChatAuthoring(
  store: Store,
  chatId: string,
  branchId: string,
  history: readonly SourceHistoryItem[],
  authoring: ChatCopyAuthoring
): void {
  const at = new Date().toISOString();
  const ids = new Map(authoring.outline.map((node) => [node.id, randomUUID()]));
  for (const node of authoring.outline) {
    if (node.parentId && !ids.has(node.parentId))
      throw new HttpError(400, '이야기 구성의 상위 항목이 없어요.');
    store.db
      .prepare(`INSERT INTO outline_nodes(id,chat_id,branch_id,parent_id,level,position,title,intent,fixed,revision,command_id,request_key,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,1,NULL,NULL,?,?)`)
      .run(
        ids.get(node.id)!,
        chatId,
        branchId,
        node.parentId ? ids.get(node.parentId)! : null,
        node.level,
        node.position,
        node.title,
        node.intent,
        Number(node.fixed),
        at,
        at
      );
  }
  const options = new ChatOptionsStore(store).get(chatId, branchId);
  const controls = options.controls ?? [];
  const values = Object.fromEntries(
    Object.entries(authoring.options).filter(([key]) =>
      controls.some((control) => control.id === key)
    )
  );
  if (Object.keys(values).length)
    store.db
      .prepare('INSERT INTO chat_prompt_options VALUES(?,?,?)')
      .run(chatId, 1, JSON.stringify({ binding: options.binding, definitions: controls, values }));
  for (const [index, item] of authoring.lore.entries()) {
    const { atIndex, ...data } = item;
    const source = atIndex === null ? null : history[atIndex];
    if (atIndex !== null && !source)
      throw new HttpError(400, '로어 변경을 적용할 메시지가 없어요.');
    const entry: ChatLoreOverride = {
      ...data,
      id: randomUUID(),
      chatId,
      revision: index + 1,
      retired: false,
      createdAt: at,
      atSource: source?.revision ?? null,
      atHash: source ? store.source(source.revision).hash : null,
    };
    store.db
      .prepare('INSERT INTO chat_lore_overrides VALUES(?,?,?,?)')
      .run(entry.id, chatId, entry.revision, JSON.stringify(entry));
  }
  if (authoring.lore.length)
    store.db
      .prepare('INSERT INTO chat_override_heads VALUES(?,?)')
      .run(chatId, authoring.lore.length);
}
