import type { ChatVariableView, OutlineCreatedNode, OutlineOperation } from '#contracts';
import type { NativeTransferReceipt } from '../core/native-transfer.js';
import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { createRisuImportPort, type RisuImportPort } from './risu-import-port.js';
import type { ChatVariableState } from '../core/chat-variables.js';
import { HttpError } from './app-errors.js';
import { chatVariableView } from './chat-variable-context.js';
import {
  chatVariablesPending,
  readChatVariables,
  saveChatVariableState,
} from './chat-variables.js';
import { canonicalPayloadHash } from './json-hash.js';
import type { OutlineAuthority, OutlineStore } from './outline-store.js';
import type { Chat, Store } from './store.js';
import type { StoryGuideStore } from './story-guide-store.js';
import { assertTx, createTxPort, type Tx, type TxPort } from './tx.js';

export type ReceiptLookup = {
  readonly adapter?: 'import';
  readonly scope: string;
  readonly key: string;
  readonly digest: string;
  readonly conflictMessage?: string;
};

export type ReceiptPort<R = unknown> = {
  readonly read: (tx: Tx | null, lookup: ReceiptLookup) => R | undefined;
  readonly save: (tx: Tx, lookup: ReceiptLookup, value: R) => void;
};

export type ImportReceiptRecord = {
  readonly receipt: NativeTransferReceipt;
  readonly chatId?: string;
};
export type ReceiptRecord = { readonly revision: number } | ImportReceiptRecord;

export type OutlineBatchReceipt = {
  readonly authority: OutlineAuthority;
  readonly operations: readonly OutlineOperation[];
  readonly created: readonly OutlineCreatedNode[];
};

export type OutlinePort = Pick<OutlineStore, 'detail' | 'focus' | 'setFocus' | 'applyBatch'>;

export type AppPorts = {
  readonly risuImport: RisuImportPort;
  readonly tx: TxPort;
  readonly receipt: ReceiptPort<ReceiptRecord>;
  readonly outlineReceipt: ReceiptPort<OutlineBatchReceipt>;
  readonly events: {
    readonly publish: (chatId: string) => void;
  };
  readonly chatGuard: {
    readonly writableChat: (tx: Tx, chatId: string) => Chat;
    readonly sourceHash: (tx: Tx, chat: Pick<Chat, 'id' | 'headRevision'>) => string | null;
    readonly hasActiveRun: (tx: Tx, chatId: string) => boolean;
  };
  readonly chatVariables: {
    readonly read: (chatId: string) => ChatVariableState;
    readonly save: (tx: Tx, chatId: string, state: ChatVariableState) => ChatVariableState;
    readonly view: (chatId: string, saved?: ChatVariableState) => ChatVariableView;
  };
  readonly storyGuide: Pick<StoryGuideStore, 'get' | 'detail' | 'save'>;
  readonly outline: OutlinePort;
};

export function createStorePorts(
  store: Store,
  options: {
    readonly readStaged?: (id: string) => Buffer;
    readonly publish?: (chatId: string) => void;
  } = {}
): AppPorts {
  return {
    risuImport: createRisuImportPort(store, options.readStaged),
    tx: createTxPort(store.db, (fn) => store.transaction(fn)),
    receipt: {
      read(tx, lookup) {
        if (tx !== null) assertTx(tx, store.db);
        if (lookup.adapter === 'import')
          return readImportReceipt<ImportReceiptRecord>(
            store,
            lookup.scope + lookup.key,
            lookup.digest
          );
        const row = store.db
          .prepare(
            'SELECT payload_hash,revision FROM chat_variable_journal WHERE chat_id=? AND request_key=?'
          )
          .get(lookup.scope, lookup.key);
        if (!row) return undefined;
        if (row.payload_hash !== lookup.digest)
          throw new HttpError(409, lookup.conflictMessage ?? 'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT');
        return { revision: Number(row.revision) };
      },
      save(tx, lookup, value) {
        assertTx(tx, store.db);
        if (lookup.adapter === 'import') {
          saveImportReceipt(store, lookup.scope + lookup.key, lookup.digest, value);
          return;
        }
        if (!('revision' in value)) throw new Error('Expected a chat variable revision');
        store.db
          .prepare(
            'INSERT INTO chat_variable_journal(chat_id,request_key,payload_hash,revision,created_at) VALUES(?,?,?,?,?)'
          )
          .run(lookup.scope, lookup.key, lookup.digest, value.revision, new Date().toISOString());
      },
    },
    outlineReceipt: {
      read(tx, lookup) {
        if (tx !== null) assertTx(tx, store.db);
        const row = store.db
          .prepare(
            'SELECT authority,operations,created FROM outline_batches WHERE chat_id=? AND request_key=?'
          )
          .get(lookup.scope, lookup.key) as
          | { authority: string; operations: string; created: string }
          | undefined;
        if (!row) return undefined;
        const operations = JSON.parse(row.operations) as OutlineOperation[];
        if (row.authority !== 'user' || canonicalPayloadHash({ operations }) !== lookup.digest)
          throw new HttpError(
            409,
            lookup.conflictMessage ?? 'Outline idempotency key was used for a different batch'
          );
        return {
          authority: row.authority as OutlineAuthority,
          operations,
          created: JSON.parse(row.created) as OutlineCreatedNode[],
        };
      },
      save(tx, lookup, value) {
        assertTx(tx, store.db);
        store.db
          .prepare(
            'INSERT INTO outline_batches(chat_id,request_key,authority,operations,created,created_at) VALUES(?,?,?,?,?,?)'
          )
          .run(
            lookup.scope,
            lookup.key,
            value.authority,
            JSON.stringify(value.operations),
            JSON.stringify(value.created),
            new Date().toISOString()
          );
      },
    },
    events: {
      publish: (chatId) => options.publish?.(chatId),
    },
    chatGuard: {
      writableChat(tx, chatId) {
        assertTx(tx, store.db);
        return store.writableChat(chatId);
      },
      sourceHash(tx, chat) {
        assertTx(tx, store.db);
        if (!chat.headRevision) return null;
        const source = store.source(chat.headRevision);
        if (source.chatId !== chat.id) throw new HttpError(400, 'CHAT_VARIABLE_SOURCE_OWNER');
        return source.hash;
      },
      hasActiveRun(tx, chatId) {
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
    outline: store.outline,
  };
}
