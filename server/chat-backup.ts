import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_MAX_BYTES,
  CHAT_BACKUP_VERSION,
  type ChatBackup,
  type ChatBackupImport,
} from '../core/chat-backup.js';
import {
  BACKUP_COLLECTIONS,
  decodeChatBackup,
  encodeBackupTables,
  type BackupTables,
} from './chat-backup-codec.js';
import { chatBackupTables } from './chat-backup-scope.js';
import { createBackupRemap, type BackupRow } from './chat-backup-remap.js';
import { remapBackupRecords, finishBackupSnapshots } from './chat-backup-records.js';
import { remapBackupContext } from './chat-backup-context.js';
import { remapChatBackupHelper } from './chat-backup-helper.js';
import { remapBackupBehavior } from './chat-backup-behavior.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { Store } from './store.js';

const receiptKind = 'chat.backup-imported';
const GLOBAL = new Set([
  'prompt_workspace',
  'illustration_settings',
  'package_behavior_entropy',
  'library_organization_state',
]);
const SHARED = new Set([
  'versions',
  'provider_settings',
  'library_hidden',
  'library_folders',
  'library_placements',
]);
const archive = (tables: BackupTables) => ({
  format: 'narrative-archive',
  version: 15,
  createdAt: new Date().toISOString(),
  tables,
});

/** Passive evidence of original choices, never applied to destination execution settings. */
function recordedEnvironment(tables: BackupTables): string {
  return JSON.stringify({
    version: 1,
    promptWorkspace: JSON.parse(tables.prompt_workspace[0].body),
    illustrationSettings: tables.illustration_settings.map((row) => {
      const settings = JSON.parse(row.body);
      settings.comfyui.authorizationEnv = '';
      return settings;
    }),
    providerDefinitions: tables.provider_settings.map((row) => {
      const definition = JSON.parse(row.body);
      if (row.kind === 'connection') {
        delete definition.credentialEnv;
        delete definition.catalogCredentialEnv;
      }
      return definition;
    }),
    libraryOrganization: {
      hidden: tables.library_hidden,
      folders: tables.library_folders,
      placements: tables.library_placements,
    },
  });
}

function withTemporaryStores<T>(work: (source: Store, copy: Store) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-chat-backup-'));
  const target = resolve(directory),
    within = relative(resolve(tmpdir()), target);
  if (
    isAbsolute(within) ||
    within.startsWith('..') ||
    !basename(target).startsWith('uimori-chat-backup-')
  )
    throw new Error('Unsafe chat backup temporary directory');
  let source: Store | undefined, copy: Store | undefined;
  try {
    source = new Store(join(directory, 'source.sqlite'));
    copy = new Store(join(directory, 'copy.sqlite'));
    return work(source, copy);
  } finally {
    copy?.close();
    source?.close();
    rmSync(target, { recursive: true, force: true });
  }
}

/** A portable, self-contained chat, all branches and immutable receipts included. */
export function exportChatBackup(store: Store, chatId: string): ChatBackup {
  const tables = store.transaction(() => chatBackupTables(store, chatId));
  // The same validators and secret/unfinished-work normalization apply to files and restored data.
  // A failed export is explicit; there is no fallback to a partial transcript.
  const normalized = withTemporaryStores((source) => {
    source.product.import(archive(tables));
    const environment = recordedEnvironment(tables);
    if (
      !tables.events.some(
        (row) => row.kind === 'chat.backup-environment' && row.entity_id === environment
      )
    )
      source.event(chatId, 'chat.backup-environment', environment);
    return source.product.export().tables;
  });
  const result: ChatBackup = {
    format: CHAT_BACKUP_FORMAT,
    version: CHAT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    chatId,
    records: encodeBackupTables(normalized),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > CHAT_BACKUP_MAX_BYTES)
    throw new HttpError(413, 'CHAT_BACKUP_TOO_LARGE');
  return result;
}

function priorImport(
  store: Store,
  requestKey: string,
  digest: string
): ChatBackupImport | undefined {
  const rows = store.db
    .prepare('SELECT chat_id,entity_id FROM events WHERE kind=?')
    .all(receiptKind) as BackupRow[];
  for (const row of rows) {
    const receipt = JSON.parse(row.entity_id);
    if (receipt.requestKey !== requestKey) continue;
    if (receipt.digest !== digest) throw new HttpError(409, 'CHAT_BACKUP_IMPORT_CONFLICT');
    return {
      chat: store.chat(row.chat_id),
      created: false,
      branches: Number(
        store.db.prepare('SELECT COUNT(*) n FROM branches WHERE chat_id=?').get(row.chat_id)!.n
      ),
      sources: Number(
        store.db.prepare('SELECT COUNT(*) n FROM sources WHERE chat_id=?').get(row.chat_id)!.n
      ),
    };
  }
}

/** Validate in isolation, then atomically attach a new identity graph to the existing workspace. */
export function importChatBackup(store: Store, value: unknown): ChatBackupImport {
  const body = record(value);
  fields(body, ['backup', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 120);
  const serialized = JSON.stringify(body.backup);
  if (Buffer.byteLength(serialized) > CHAT_BACKUP_MAX_BYTES)
    throw new HttpError(413, 'CHAT_BACKUP_TOO_LARGE');
  const digest = createHash('sha256').update(serialized).digest('hex');
  const prior = priorImport(store, requestKey, digest);
  if (prior) return prior;
  const { tables } = decodeChatBackup(body.backup);
  return withTemporaryStores((source, copy) => {
    source.product.import(archive(tables));
    const normalized = source.product.export().tables;
    const offsets: Record<string, number> = {};
    for (const { table, fields } of BACKUP_COLLECTIONS)
      if (fields.some((field) => field.column === 'seq'))
        offsets[table] = Number(
          store.db.prepare(`SELECT COALESCE(MAX(seq),0) n FROM ${table}`).get()!.n
        );
    const ctx = createBackupRemap(normalized, offsets);
    remapChatBackupHelper(ctx);
    remapBackupRecords(ctx);
    remapBackupBehavior(ctx);
    remapBackupContext(ctx);
    finishBackupSnapshots(ctx);
    copy.product.import(archive(ctx.tables));
    const ready = copy.product.export().tables;
    return store.transaction(() => {
      const duplicate = priorImport(store, requestKey, digest);
      if (duplicate) return duplicate;
      store.db.exec('PRAGMA defer_foreign_keys=ON');
      const reusedItems = new Set(
        (
          store.db
            .prepare('SELECT kind,id FROM versions UNION SELECT kind,id FROM provider_settings')
            .all() as BackupRow[]
        ).map((row) => `${row.kind}:${row.id}`)
      );
      for (const { table, fields: columns } of BACKUP_COLLECTIONS) {
        if (GLOBAL.has(table)) continue;
        const primary = (store.db.prepare(`PRAGMA table_info(${table})`).all() as BackupRow[])
          .filter((field) => field.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((field) => field.name as string);
        for (const row of ready[table]) {
          // Reusing content must not hide or move an existing destination library item.
          if (
            ['library_hidden', 'library_placements'].includes(table) &&
            reusedItems.has(`${row.kind}:${row.id}`)
          )
            continue;
          if (SHARED.has(table)) {
            const existing = store.db
              .prepare(
                `SELECT * FROM ${table} WHERE ${primary.map((column) => `${column}=?`).join(' AND ')}`
              )
              .get(...primary.map((column) => row[column])) as BackupRow | undefined;
            if (existing) {
              // Current role selections and workspace organization remain owned by the destination.
              // Immutable content with the same identity must still be byte-for-byte the same version.
              if (table === 'versions' && !isDeepStrictEqual({ ...existing }, { ...row }))
                throw new HttpError(409, 'CHAT_BACKUP_LIBRARY_CONFLICT');
              continue;
            }
          }
          store.db
            .prepare(
              `INSERT INTO ${table}(${columns.map((field) => field.column).join(',')}) VALUES(${columns.map(() => '?').join(',')})`
            )
            .run(
              ...columns.map((field) =>
                field.binary ? Buffer.from(row[field.column], 'base64') : row[field.column]
              )
            );
        }
      }
      if (store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new HttpError(400, 'CHAT_BACKUP_INVALID_GRAPH');
      const environment = recordedEnvironment(normalized);
      if (
        !ready.events.some(
          (row) => row.kind === 'chat.backup-environment' && row.entity_id === environment
        )
      )
        store.event(ctx.chatId, 'chat.backup-environment', environment);
      store.event(
        ctx.chatId,
        receiptKind,
        JSON.stringify({ requestKey, digest, originChatId: tables.chats[0].id })
      );
      return {
        chat: store.chat(ctx.chatId),
        created: true,
        branches: ready.branches.length,
        sources: ready.sources.length,
      };
    });
  });
}
