import {
  CHAT_BACKUP_FORMAT,
  CHAT_BACKUP_VERSION,
  type BackupRecord,
  type BackupValue,
  type ChatBackup,
} from '../core/chat-backup.js';
import { HttpError, fields, record, text } from './request-validation.js';

type Row = Record<string, any>;
type Field = {
  column: string;
  name: string;
  json: boolean;
  binary: boolean;
  nullableJson: boolean;
};
export type BackupCollection = { name: string; table: string; fields: Field[] };
// A public JSON null is encoded as SQL NULL only for these optional storage fields.
// Required JSON columns (for example a create operation's beforeBody) store the literal "null".
const nullableJson = new Set([
  'runs.usage',
  'jobs.input',
  'attempts.response',
  'attempts.raw_usage',
  'attempts.price_revision',
  'story_jobs.result',
  'context_jobs.checkpoint',
  'chat_folders.default_persona',
  'illustration_jobs.diagnostic',
]);

/**
 * Explicit v1 adapters, not a database dump. Public names, JSON values and column lists stay fixed
 * when database storage changes; that change must update this adapter or add a format reader.
 * @ means a JSON value and ~ means base64 image bytes. Neither is a public field-name prefix.
 */
function collection(name: string, table: string, columns: string): BackupCollection {
  return {
    name,
    table,
    fields: columns.split(' ').map((spec) => {
      const column = spec.replace(/^[@~]/, '');
      return {
        column,
        name: column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        json: spec.startsWith('@'),
        binary: spec.startsWith('~'),
        nullableJson: nullableJson.has(`${table}.${column}`),
      };
    }),
  };
}

export const BACKUP_COLLECTIONS = [
  collection('chat', 'chats', 'id title head_revision settings_revision @settings created_at'),
  collection('libraryVersions', 'versions', 'kind id revision @body'),
  collection('providerDefinitions', 'provider_settings', 'kind id revision @body'),
  collection('profiles', 'profiles', 'chat_id @body'),
  collection('branches', 'branches', 'id chat_id title head_revision revision is_default'),
  collection(
    'turns',
    'runs',
    'id chat_id parent_revision status request @snapshot request_key @command source_revision error @usage created_at updated_at branch_id partial_text issue'
  ),
  collection('sources', 'sources', 'id chat_id run_id parent_revision text hash created_at'),
  collection('sourceEdits', 'source_edits', 'source_id revision text hash created_at'),
  collection(
    'auxiliaryJobs',
    'jobs',
    'id chat_id source_revision source_hash kind status generation owner @input error created_at updated_at revision'
  ),
  collection('auxiliaryResults', 'job_results', 'job_id generation @result created_at'),
  collection('modelInputs', 'model_inputs', 'seq run_id @input'),
  collection('toolEvents', 'tool_events', 'seq run_id @event'),
  collection('chatEvents', 'events', 'seq chat_id kind entity_id at'),
  collection('promptEnvironment', 'prompt_workspace', 'id @body'),
  collection('hiddenLibraryItems', 'library_hidden', 'kind id'),
  collection(
    'attempts',
    'attempts',
    'id chat_id run_id job_id role connection_id model_id status @request @response input_tokens output_tokens cost_usd @raw_usage @price_revision error story_job_id'
  ),
  collection('assets', 'assets', 'id chat_id @body ~bytes'),
  collection('storyConfigurations', 'story_configs', 'chat_id revision @body'),
  collection(
    'storyJobs',
    'story_jobs',
    'id chat_id source_revision source_hash kind config_revision generation owner status @snapshot @result error mock created_at updated_at dependency_key @inputs @tool_events'
  ),
  collection(
    'storyStates',
    'story_states',
    'id job_id chat_id source_revision source_hash module_revision parent_state_id @body'
  ),
  collection('notes', 'author_notes', 'id chat_id @entry retired_at replaces_id'),
  collection('noteHeads', 'author_note_heads', 'chat_id revision'),
  collection('noteOperations', 'author_note_commands', 'chat_id request_key @command @result'),
  collection(
    'sceneCommands',
    'scene_commands',
    'id chat_id branch_id request_key label request status run_id source_revision'
  ),
  collection(
    'contextCheckpoints',
    'context_checkpoints',
    'id scope_key chat_id revision hash origin @plan @snapshot created_at activated'
  ),
  collection('contextHeads', 'context_heads', 'scope_key chat_id revision checkpoint_id'),
  collection(
    'contextOperations',
    'context_commands',
    'scope_key chat_id request_key @command @result'
  ),
  collection(
    'contextJobs',
    'context_jobs',
    'id chat_id branch_id request_key @command status @snapshot @checkpoint error noop created_at updated_at'
  ),
  collection('contextAttempts', 'context_job_attempts', 'job_id attempt_id'),
  collection('drafts', 'edit_drafts', 'id editor_key kind target_id revision status @body'),
  collection('draftProposals', 'edit_draft_proposals', 'id draft_id @body'),
  collection(
    'draftOperations',
    'edit_draft_operations',
    'operation_id draft_id action request_id request_hash @intent @result @before_body created_at'
  ),
  collection('loreOverrides', 'chat_lore_overrides', 'id chat_id revision @body'),
  collection('loreHeads', 'chat_override_heads', 'chat_id revision'),
  collection(
    'loreOperations',
    'chat_override_operations',
    'operation_id chat_id request_id command_hash @intent @result created_at'
  ),
  collection('chatOptions', 'chat_prompt_options', 'chat_id revision @body'),
  collection('pendingOptions', 'chat_option_pending', 'id chat_id branch_id @body'),
  collection(
    'optionOperations',
    'chat_option_operations',
    'id chat_id request_id command_hash @command @intent @result created_at'
  ),
  collection(
    'helperConversations',
    'helper_conversations',
    'id scope_key creation_key creation_hash chat_id branch_id @scope title auto_title revision persona created_at updated_at @limits'
  ),
  collection(
    'helperTasks',
    'helper_tasks',
    'id conversation_id request_key request status generation owner @snapshot error @usage created_at started_at updated_at'
  ),
  collection(
    'helperMessages',
    'helper_messages',
    'id conversation_id task_id role text @artifacts created_at'
  ),
  collection('helperEvents', 'helper_events', 'seq conversation_id task_id kind @data'),
  collection('helperGrants', 'helper_grants', 'id task_id @body'),
  collection('helperOperations', 'helper_operations', 'id task_id request_hash @result created_at'),
  collection(
    'helperArtifactJobs',
    'helper_artifact_jobs',
    'id task_id operation_id @snapshot status artifact_id artifact_revision error created_at'
  ),
  collection(
    'helperAttempts',
    'helper_task_attempts',
    'task_id attempt_id purpose segment artifact_job_id'
  ),
  collection(
    'helperArtifacts',
    'helper_artifacts',
    'id revision conversation_id task_id request text @snapshot @usage created_at origin'
  ),
  collection(
    'helperDelegations',
    'helper_delegations',
    'id conversation_id chat_id branch_id revision @body revoked_at created_at'
  ),
  collection(
    'responseStreams',
    'response_stream_tasks',
    'task_kind task_id chat_id run_id helper_task_id owner status created_at updated_at'
  ),
  collection(
    'responseChunks',
    'response_stream_chunks',
    'seq task_kind task_id attempt_id segment offset text'
  ),
  collection(
    'packageRequests',
    'package_requests',
    'id chat_id branch_id instance_id action_key @body @dependencies status consumed_run_id'
  ),
  collection('chatFolders', 'chat_folders', 'id bot_id title @default_persona revision'),
  collection(
    'chatOrganization',
    'chat_organization',
    'chat_id bot_id folder_id revision sort_position'
  ),
  collection('libraryOrganization', 'library_organization_state', 'id revision'),
  collection('libraryFolders', 'library_folders', 'id category title sort_position'),
  collection('libraryPlacements', 'library_placements', 'kind id category folder_id'),
  collection(
    'behaviorStates',
    'package_behavior_states',
    'chat_id branch_id instance_id @scope definition_hash state_revision @state'
  ),
  collection(
    'behaviorJournal',
    'package_behavior_journal',
    'chat_id branch_id instance_id idempotency_key payload_hash @payload @result created_at'
  ),
  collection(
    'behaviorHeads',
    'package_behavior_heads',
    'chat_id branch_id instance_id @dependencies status error @draws'
  ),
  collection('behaviorOutputs', 'package_behavior_outputs', 'source_id instance_id @body'),
  collection('behaviorEntropy', 'package_behavior_entropy', 'id seed'),
  collection(
    'behaviorOpportunities',
    'package_behavior_opportunities',
    'id chat_id branch_id @body'
  ),
  collection('behaviorRuns', 'package_behavior_runs', 'run_id @body'),
  collection('illustrationEnvironment', 'illustration_settings', 'id @body'),
  collection('illustrationReferences', 'illustration_references', 'chat_id revision @body'),
  collection(
    'illustrationJobs',
    'illustration_jobs',
    'id chat_id source_revision source_hash origin status generation owner attempt @input @diagnostic error created_at updated_at'
  ),
  collection(
    'illustrationImages',
    'illustration_images',
    'id job_id chat_id position mime hash @body ~bytes created_at'
  ),
  collection(
    'outlineNodes',
    'outline_nodes',
    'id chat_id branch_id parent_id level position title intent fixed revision command_id request_key created_at updated_at'
  ),
  collection(
    'outlineOperations',
    'outline_batches',
    'chat_id branch_id request_key authority @operations @created created_at'
  ),
] as const;

export type BackupTables = Record<string, Row[]>;
export function encodeBackupTables(tables: BackupTables): ChatBackup['records'] {
  return Object.fromEntries(
    BACKUP_COLLECTIONS.map(({ name, table, fields: columns }) => [
      name,
      (tables[table] ?? []).map(
        (row) =>
          Object.fromEntries(
            columns.map((field) => {
              const value = row[field.column];
              if (value === undefined)
                throw new Error(`CHAT_BACKUP_ADAPTER_MISSING:${name}.${field.name}`);
              return [
                field.name,
                value === null
                  ? null
                  : field.json
                    ? JSON.parse(value)
                    : field.binary && typeof value !== 'string'
                      ? Buffer.from(value).toString('base64')
                      : value,
              ];
            })
          ) as BackupRecord
      ),
    ])
  );
}

/** Decode only declared fields. Database column names and SQL never come from a file. */
export function decodeChatBackup(value: unknown): { backup: ChatBackup; tables: BackupTables } {
  const body = record(value);
  fields(body, ['format', 'version', 'createdAt', 'chatId', 'records']);
  if (body.format !== CHAT_BACKUP_FORMAT) throw new HttpError(400, 'CHAT_BACKUP_INVALID_FORMAT');
  if (body.version !== CHAT_BACKUP_VERSION)
    throw new HttpError(400, 'CHAT_BACKUP_UNSUPPORTED_VERSION');
  const createdAt = text(body.createdAt, 'backup time', 40);
  if (!Number.isFinite(Date.parse(createdAt))) throw new HttpError(400, 'CHAT_BACKUP_INVALID_TIME');
  text(body.chatId, 'backup chat', 100);
  const records = record(body.records);
  fields(
    records,
    BACKUP_COLLECTIONS.map((entry) => entry.name)
  );
  const tables: BackupTables = {};
  for (const { name, table, fields: columns } of BACKUP_COLLECTIONS) {
    const values = records[name];
    if (!Array.isArray(values) || values.length > 100_000)
      throw new HttpError(400, 'CHAT_BACKUP_INVALID_COLLECTION');
    tables[table] = values.map((raw) => {
      const row = record(raw);
      fields(
        row,
        columns.map((field) => field.name)
      );
      if (columns.some((field) => !Object.hasOwn(row, field.name)))
        throw new HttpError(400, 'CHAT_BACKUP_MISSING_FIELD');
      return Object.fromEntries(
        columns.map((field) => {
          const item: BackupValue = row[field.name];
          if (
            !field.json &&
            item !== null &&
            typeof item !== 'string' &&
            (typeof item !== 'number' || !Number.isFinite(item))
          )
            throw new HttpError(400, 'CHAT_BACKUP_INVALID_FIELD');
          return [
            field.column,
            field.json ? (item === null && field.nullableJson ? null : JSON.stringify(item)) : item,
          ];
        })
      );
    });
  }
  if (tables.chats.length !== 1 || tables.chats[0].id !== body.chatId)
    throw new HttpError(400, 'CHAT_BACKUP_INVALID_CHAT');
  return { backup: body as ChatBackup, tables };
}
