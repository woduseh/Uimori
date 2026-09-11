import { BACKUP_COLLECTIONS, type BackupTables } from './chat-backup-codec.js';
import { exportOpportunityEntropy } from './package-behavior-run.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
const GLOBAL = new Set([
  'prompt_workspace',
  'illustration_settings',
  'package_behavior_entropy',
  'library_organization_state',
]);

/** Select the complete chat graph and referenced shared definitions, never another chat's history. */
export function chatBackupTables(store: Store, chatId: string): BackupTables {
  store.chat(chatId);
  const db = store.db;
  const tables: BackupTables = {};
  const indirect: Record<string, string> = {
    source_edits: 'source_id IN (SELECT id FROM sources WHERE chat_id=?)',
    job_results: 'job_id IN (SELECT id FROM jobs WHERE chat_id=?)',
    model_inputs: 'run_id IN (SELECT id FROM runs WHERE chat_id=?)',
    tool_events: 'run_id IN (SELECT id FROM runs WHERE chat_id=?)',
    package_behavior_outputs: 'source_id IN (SELECT id FROM sources WHERE chat_id=?)',
    package_behavior_runs: 'run_id IN (SELECT id FROM runs WHERE chat_id=?)',
    context_job_attempts: 'job_id IN (SELECT id FROM context_jobs WHERE chat_id=?)',
    helper_tasks: 'conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)',
    helper_messages: 'conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)',
    helper_events: 'conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)',
    helper_grants:
      'task_id IN (SELECT t.id FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?)',
    helper_operations:
      'task_id IN (SELECT t.id FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?)',
    helper_artifact_jobs:
      'task_id IN (SELECT t.id FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?)',
    helper_task_attempts:
      'task_id IN (SELECT t.id FROM helper_tasks t JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?)',
    helper_artifacts: 'conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)',
    helper_delegations: 'conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)',
    response_stream_chunks:
      '(task_kind,task_id) IN (SELECT task_kind,task_id FROM response_stream_tasks WHERE chat_id=?)',
    chat_folders: 'id IN (SELECT folder_id FROM chat_organization WHERE chat_id=?)',
  };
  for (const { table, fields } of BACKUP_COLLECTIONS) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (
      actual.length !== fields.length ||
      actual.some((field) => !fields.some((entry) => entry.column === field.name))
    )
      throw new Error(`CHAT_BACKUP_ADAPTER_SCHEMA_MISMATCH:${table}`);
    const where =
      table === 'chats'
        ? 'id=?'
        : (indirect[table] ??
          (fields.some((field) => field.column === 'chat_id') ? 'chat_id=?' : undefined));
    tables[table] = where
      ? (db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(chatId) as Row[])
      : GLOBAL.has(table)
        ? (db.prepare(`SELECT * FROM ${table}`).all() as Row[])
        : [];
    for (const row of tables[table])
      for (const field of fields)
        if (field.binary) row[field.column] = Buffer.from(row[field.column]).toString('base64');
  }
  // Drafts referred to by this chat's helper work retain unsaved content and their full operations.
  const referenced = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && ['draftId', 'editorKey', 'targetId'].includes(key))
        referenced.add(item);
      else if (!['text', 'request', 'state', 'values', 'program', 'package'].includes(key))
        collect(item);
    }
  };
  for (const { table, fields } of BACKUP_COLLECTIONS)
    for (const row of tables[table])
      for (const field of fields)
        if (field.json && row[field.column] !== null) collect(JSON.parse(row[field.column]));
  tables.edit_drafts = (db.prepare('SELECT * FROM edit_drafts').all() as Row[]).filter(
    (row) => row.target_id === chatId || referenced.has(row.id) || referenced.has(row.editor_key)
  );
  const draftIds = new Set(tables.edit_drafts.map((row) => row.id));
  for (const table of ['edit_draft_proposals', 'edit_draft_operations'])
    tables[table] = (db.prepare(`SELECT * FROM ${table}`).all() as Row[]).filter((row) =>
      draftIds.has(row.draft_id)
    );

  const candidates = [
    ...(db.prepare('SELECT * FROM versions').all() as Row[]).map((row) => ({
      table: 'versions',
      row,
    })),
    ...(db.prepare('SELECT * FROM provider_settings').all() as Row[]).map((row) => ({
      table: 'provider_settings',
      row,
    })),
  ];
  const knownIds = new Set(candidates.map(({ row }) => row.id));
  const needed = new Set<string>();
  // All shared references remain in their original immutable ID space. Scalar prose is not inspected.
  const refs = (value: unknown, field = '') => {
    if (typeof value === 'string') {
      if (
        knownIds.has(value) &&
        /^(?:id|.*Id|.*Ids|blobHash|relatedIds|ref|refs|attachments|models|routes)$/u.test(field)
      )
        needed.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) refs(entry, field);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          'text',
          'request',
          'state',
          'values',
          'description',
          'title',
          'summary',
          'code',
          'expression',
          'template',
        ].includes(key)
      )
        continue;
      if (knownIds.has(key)) needed.add(key);
      refs(item, key);
    }
  };
  for (const { table, fields } of BACKUP_COLLECTIONS)
    for (const row of tables[table])
      for (const field of fields) {
        if (field.json && row[field.column] !== null) refs(JSON.parse(row[field.column]));
        else if (
          typeof row[field.column] === 'string' &&
          field.column.endsWith('_id') &&
          knownIds.has(row[field.column])
        )
          needed.add(row[field.column]);
      }
  for (const event of tables.events)
    if (event.kind === 'chat.backup-environment') refs(JSON.parse(event.entity_id));
  const selected = new Set<Row>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { table, row } of candidates) {
      if (!needed.has(row.id) || selected.has(row)) continue;
      selected.add(row);
      tables[table].push(row);
      refs(JSON.parse(row.body));
      changed = true;
    }
  }
  for (const table of ['library_hidden', 'library_placements'])
    tables[table] = (db.prepare(`SELECT * FROM ${table}`).all() as Row[]).filter((row) =>
      needed.has(row.id)
    );
  const folders = new Set(tables.library_placements.map((row) => row.folder_id));
  tables.library_folders = (db.prepare('SELECT * FROM library_folders').all() as Row[]).filter(
    (row) => folders.has(row.id)
  );
  for (const row of tables.package_behavior_opportunities) {
    const value = JSON.parse(row.body);
    value.originEntropy = exportOpportunityEntropy(store, row.id);
    row.body = JSON.stringify(value);
  }
  return tables;
}
