import type { ChatVariableView } from '#contracts';
import type { ChatVariableState } from '../core/chat-variables.js';
import { HttpError } from './app-errors.js';
import { chatVariableView } from './chat-variable-context.js';
import {
  chatVariablesPending,
  readChatVariables,
  saveChatVariableState,
} from './chat-variables.js';
import type { Chat, Store } from './store.js';
import type { StoryGuideStore } from './story-guide-store.js';
import { assertTx, createTxPort, type Tx, type TxPort } from './tx.js';

export type ReceiptAdapter = 'import' | 'chat-variables';

export type ReceiptLookup = {
  readonly adapter: ReceiptAdapter;
  readonly key: string;
  readonly scope?: string;
  readonly digest: string;
  readonly conflictMessage?: string;
};

export type ReceiptRecord = {
  readonly result?: unknown;
  readonly revision?: number;
};

export type ReceiptPort = {
  readonly read: (tx: Tx | null, lookup: ReceiptLookup) => ReceiptRecord | undefined;
  readonly save: (tx: Tx, lookup: ReceiptLookup, value: ReceiptRecord) => void;
};

export type EventPort = {
  readonly emit: (
    tx: Tx,
    chatId: string,
    kind: string,
    entityId: string,
    options?: { notify?: boolean }
  ) => void;
  readonly publish: (chatId: string) => void;
  readonly publishAll: () => void;
};

export type ChatGuardPort = {
  readonly readChat: (chatId: string) => Chat;
  readonly writableChat: (tx: Tx, chatId: string) => Chat;
  readonly sourceHash: (tx: Tx, chat: Pick<Chat, 'id' | 'headRevision'>) => string | null;
  readonly hasActiveRun: (tx: Tx, chatId: string) => boolean;
};

export type ChatVariablesPort = {
  readonly read: (chatId: string) => ChatVariableState;
  readonly save: (tx: Tx, chatId: string, state: ChatVariableState) => ChatVariableState;
  readonly view: (chatId: string, saved?: ChatVariableState) => ChatVariableView;
};

export type AppPorts = {
  readonly tx: TxPort;
  readonly receipt: ReceiptPort;
  readonly events: EventPort;
  readonly chatGuard: ChatGuardPort;
  readonly chatVariables: ChatVariablesPort;
  readonly storyGuide: Pick<StoryGuideStore, 'get' | 'detail' | 'save'>;
};

export type StorePortOptions = {
  readonly publish?: (chatId: string) => void;
  readonly publishAll?: () => void;
};

function readReceiptRow(store: Store, lookup: ReceiptLookup): ReceiptRecord | undefined {
  if (lookup.adapter === 'chat-variables') {
    const row = store.db
      .prepare(
        'SELECT payload_hash,revision FROM chat_variable_journal WHERE chat_id=? AND request_key=?'
      )
      .get(lookup.scope ?? '', lookup.key);
    if (!row) return undefined;
    if (row.payload_hash !== lookup.digest)
      throw new HttpError(409, lookup.conflictMessage ?? 'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT');
    return { revision: Number(row.revision) };
  }
  const prior = store.db
    .prepare('SELECT digest,result FROM import_operations WHERE key=?')
    .get(lookup.key);
  if (!prior) return undefined;
  if (prior.digest !== lookup.digest)
    throw new HttpError(
      409,
      lookup.conflictMessage ?? 'Idempotency key reused with different command'
    );
  return { result: JSON.parse(String(prior.result)) };
}

function saveReceiptRow(store: Store, tx: Tx, lookup: ReceiptLookup, value: ReceiptRecord): void {
  assertTx(tx, store.db);
  if (lookup.adapter === 'chat-variables') {
    store.db
      .prepare(
        'INSERT INTO chat_variable_journal(chat_id,request_key,payload_hash,revision,created_at) VALUES(?,?,?,?,?)'
      )
      .run(
        lookup.scope ?? '',
        lookup.key,
        lookup.digest,
        value.revision ?? 0,
        new Date().toISOString()
      );
    return;
  }
  store.db
    .prepare('INSERT INTO import_operations VALUES(?,?,?)')
    .run(lookup.key, lookup.digest, JSON.stringify(value.result));
}

export function createStorePorts(store: Store, options: StorePortOptions = {}): AppPorts {
  return {
    tx: createTxPort(store.db, (fn) => store.transaction(fn)),
    receipt: {
      read: (tx, lookup) => {
        if (tx !== null) assertTx(tx, store.db);
        return readReceiptRow(store, lookup);
      },
      save: (tx, lookup, value) => saveReceiptRow(store, tx, lookup, value),
    },
    events: {
      emit: (tx, chatId, kind, entityId, eventOptions) => {
        assertTx(tx, store.db);
        store.event(chatId, kind, entityId, eventOptions);
      },
      publish: (chatId) => options.publish?.(chatId),
      publishAll: () => options.publishAll?.(),
    },
    chatGuard: {
      readChat: (chatId) => store.chat(chatId),
      writableChat: (tx, chatId) => {
        assertTx(tx, store.db);
        return store.writableChat(chatId);
      },
      sourceHash: (tx, chat) => {
        assertTx(tx, store.db);
        if (!chat.headRevision) return null;
        const source = store.source(chat.headRevision);
        if (source.chatId !== chat.id) throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
        return source.hash;
      },
      hasActiveRun: (tx, chatId) => {
        assertTx(tx, store.db);
        return chatVariablesPending(store, chatId);
      },
    },
    chatVariables: {
      read: (chatId) => readChatVariables(store, chatId),
      save: (tx, chatId, state) => saveChatVariableState(store, tx, chatId, state),
      view: (chatId, saved) => chatVariableView(store, chatId, saved),
    },
    storyGuide: store.storyGuide,
  };
}
