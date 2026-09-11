import { randomBytes, randomUUID } from 'node:crypto';
import { BACKUP_COLLECTIONS, type BackupTables } from './chat-backup-codec.js';

export type BackupRow = Record<string, any>;
export type BackupRemap = {
  tables: BackupTables;
  originalTables: BackupTables;
  ids: Map<string, string>;
  oldChatId: string;
  chatId: string;
  id: <T extends string | null | undefined>(value: T) => T;
  key: (value: string) => string;
  structured: <T>(value: T) => T;
  sequences: Record<string, Map<number, number>>;
};

const SHARED = new Set([
  'versions',
  'provider_settings',
  'prompt_workspace',
  'library_hidden',
  'library_organization_state',
  'library_folders',
  'library_placements',
  'package_behavior_entropy',
  'illustration_settings',
]);
const identityFields = new Set([
  'id',
  'chatId',
  'branchId',
  'sourceId',
  'sourceRevision',
  'parentRevision',
  'headRevision',
  'revision',
  'runId',
  'jobId',
  'taskId',
  'conversationId',
  'artifactId',
  'draftId',
  'operationId',
  'requestId',
  'commandId',
  'sceneCommandId',
  'parentId',
  'parentStateId',
  'checkpointId',
  'attemptId',
  'opportunityId',
  'candidateOf',
  'retryOf',
  'lastUsed',
  'atRevision',
  'replacesId',
  'translationJobId',
  'assetRef',
  'folderId',
  'overrideId',
  'delegationId',
  'pendingId',
  'atSource',
  'requestGroupId',
]);
const identityLists = new Set([
  'recentSourceRevisions',
  'sourceRevisions',
  'sourceIds',
  'runIds',
  'taskIds',
  'pendingIds',
  'delegationIds',
  'overrideIds',
]);
// These are authored payloads, not reference containers. Their strings and object keys are immutable.
const payloads = new Set([
  'text',
  'request',
  'description',
  'title',
  'label',
  'summary',
  'state',
  'draws',
  'values',
  'packageValues',
  'program',
  'package',
  'packages',
  'module',
  'controls',
  'definition',
  'expression',
  'template',
  'code',
  'rawUsage',
  'opaqueState',
]);

/** Primary keys are allocated once; public/library identities are deliberately preserved. */
export function createBackupRemap(
  originalTables: BackupTables,
  sequenceOffsets: Record<string, number> = {}
): BackupRemap {
  const tables = structuredClone(originalTables);
  const ids = new Map<string, string>();
  const sequences: BackupRemap['sequences'] = {};
  const oldChatId = String(tables.chats[0].id);
  for (const { table } of BACKUP_COLLECTIONS) {
    if (SHARED.has(table)) continue;
    for (const row of tables[table]) {
      const value = row.id ?? (table.endsWith('_operations') ? row.operation_id : undefined);
      if (typeof value === 'string' && !ids.has(value))
        ids.set(
          value,
          table === 'package_behavior_opportunities'
            ? randomBytes(32).toString('hex')
            : randomUUID()
        );
    }
  }
  // Deleted outline nodes survive only in immutable creation/operation receipts. They still
  // need a new identity so repeated copies cannot claim the same historical creation.
  for (const row of tables.outline_batches)
    for (const entry of JSON.parse(row.created) as { id: string }[])
      if (!ids.has(entry.id)) ids.set(entry.id, randomUUID());
  const chatId = ids.get(oldChatId)!;
  const id: BackupRemap['id'] = (value) =>
    (typeof value === 'string' ? (ids.get(value) ?? value) : value) as typeof value;
  for (const row of tables.branches)
    if (row.id === `main:${oldChatId}`) ids.set(row.id, `main:${chatId}`);
  const key = (value: string) => {
    if (ids.has(value)) return ids.get(value)!;
    // Only delimited host keys are rewritten. This function is never applied to prose.
    let mapped = value;
    for (const [before, after] of [...ids].sort(([a], [b]) => b.length - a.length))
      mapped = mapped.split(before).join(after);
    return mapped;
  };
  const structured = <T>(value: T): T => {
    const visit = (item: any, field = ''): any => {
      if (typeof item === 'string') {
        if (identityFields.has(field) || identityLists.has(field)) return id(item);
        if (['scopeKey', 'editorKey', 'anchor', 'blockAnchor', 'anchors'].includes(field))
          return key(item);
        return item;
      }
      if (Array.isArray(item)) return item.map((entry) => visit(entry, field));
      if (!item || typeof item !== 'object') return item;
      return Object.fromEntries(
        Object.entries(item).map(([name, entry]) => [
          name,
          payloads.has(name) ? structuredClone(entry) : visit(entry, name),
        ])
      );
    };
    return visit(value) as T;
  };
  // SQL references have explicit column names. JSON is owned by the domain adapters below.
  for (const { table, fields } of BACKUP_COLLECTIONS) {
    if (SHARED.has(table)) continue;
    if (fields.some((field) => field.column === 'seq')) {
      let sequence = sequenceOffsets[table] ?? 0;
      sequences[table] = new Map();
      for (const row of tables[table]) {
        sequences[table].set(row.seq, ++sequence);
        row.seq = sequence;
      }
    }
    for (const row of tables[table])
      for (const field of fields) {
        const value = row[field.column];
        if (field.json || field.binary || typeof value !== 'string') continue;
        if (
          field.column === 'id' ||
          field.column.endsWith('_id') ||
          ['parent_revision', 'source_revision', 'head_revision'].includes(field.column)
        )
          row[field.column] = id(value);
        else if (['scope_key', 'editor_key'].includes(field.column)) row[field.column] = key(value);
      }
  }
  return { tables, originalTables, ids, oldChatId, chatId, id, key, structured, sequences };
}
