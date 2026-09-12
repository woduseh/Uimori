// Frozen column contract of the pre-migration schema 15. Do not derive this from
// today's installers: that would silently redefine which old databases we accept.
// Each column is name|declared type|not-null|primary-key position|default (~ = SQL NULL).
export const SCHEMA_15_COLUMNS: Readonly<Record<string, string>> = {
  assets: 'body|TEXT|1|0|~ bytes|BLOB|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~',
  attempts:
    'chat_id|TEXT|0|0|~ connection_id|TEXT|1|0|~ cost_usd|REAL|0|0|~ error|TEXT|0|0|~ id|TEXT|0|1|~ input_tokens|INTEGER|0|0|~ job_id|TEXT|0|0|~ model_id|TEXT|1|0|~ output_tokens|INTEGER|0|0|~ price_revision|TEXT|0|0|~ raw_usage|TEXT|0|0|~ request|TEXT|1|0|~ response|TEXT|0|0|~ role|TEXT|1|0|~ run_id|TEXT|0|0|~ status|TEXT|1|0|~ story_job_id|TEXT|0|0|~',
  author_note_commands:
    'chat_id|TEXT|1|1|~ command|TEXT|1|0|~ request_key|TEXT|1|2|~ result|TEXT|1|0|~',
  author_note_heads: 'chat_id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  author_notes:
    'chat_id|TEXT|1|0|~ entry|TEXT|1|0|~ id|TEXT|0|1|~ replaces_id|TEXT|0|0|~ retired_at|TEXT|0|0|~',
  branches:
    'chat_id|TEXT|1|0|~ head_revision|TEXT|0|0|~ id|TEXT|0|1|~ is_default|INTEGER|1|0|~ revision|INTEGER|1|0|~ title|TEXT|1|0|~',
  chat_folders:
    'bot_id|TEXT|1|0|~ default_persona|TEXT|0|0|~ id|TEXT|0|1|~ revision|INTEGER|1|0|~ title|TEXT|1|0|~',
  chat_lore_overrides: 'body|TEXT|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  chat_option_operations:
    'chat_id|TEXT|1|0|~ command_hash|TEXT|1|0|~ command|TEXT|1|0|~ created_at|TEXT|1|0|~ id|TEXT|0|1|~ intent|TEXT|1|0|~ request_id|TEXT|1|0|~ result|TEXT|1|0|~',
  chat_option_pending: 'body|TEXT|1|0|~ branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~',
  chat_organization:
    'bot_id|TEXT|1|0|~ chat_id|TEXT|0|1|~ folder_id|TEXT|0|0|~ revision|INTEGER|1|0|~ sort_position|INTEGER|1|0|~',
  chat_override_heads: 'chat_id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  chat_override_operations:
    'chat_id|TEXT|1|0|~ command_hash|TEXT|1|0|~ created_at|TEXT|1|0|~ intent|TEXT|1|0|~ operation_id|TEXT|0|1|~ request_id|TEXT|1|0|~ result|TEXT|1|0|~',
  chat_prompt_options: 'body|TEXT|1|0|~ chat_id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  chats:
    'created_at|TEXT|1|0|~ head_revision|TEXT|0|0|~ id|TEXT|0|1|~ settings_revision|INTEGER|1|0|~ settings|TEXT|1|0|~ title|TEXT|1|0|~',
  context_checkpoints:
    'activated|INTEGER|1|0|~ chat_id|TEXT|0|0|~ created_at|TEXT|1|0|~ hash|TEXT|1|0|~ id|TEXT|0|1|~ origin|TEXT|1|0|~ plan|TEXT|1|0|~ revision|INTEGER|1|0|~ scope_key|TEXT|1|0|~ snapshot|TEXT|1|0|~',
  context_commands:
    'chat_id|TEXT|1|0|~ command|TEXT|1|0|~ request_key|TEXT|1|2|~ result|TEXT|1|0|~ scope_key|TEXT|1|1|~',
  context_heads:
    'chat_id|TEXT|0|0|~ checkpoint_id|TEXT|0|0|~ revision|INTEGER|1|0|~ scope_key|TEXT|0|1|~',
  context_job_attempts: 'attempt_id|TEXT|1|2|~ job_id|TEXT|1|1|~',
  context_jobs:
    'branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ checkpoint|TEXT|0|0|~ command|TEXT|1|0|~ created_at|TEXT|1|0|~ error|TEXT|0|0|~ id|TEXT|0|1|~ noop|INTEGER|1|0|0 request_key|TEXT|1|0|~ snapshot|TEXT|1|0|~ status|TEXT|1|0|~ updated_at|TEXT|1|0|~',
  edit_draft_operations:
    'action|TEXT|1|0|~ before_body|TEXT|1|0|~ created_at|TEXT|1|0|~ draft_id|TEXT|1|0|~ intent|TEXT|1|0|~ operation_id|TEXT|0|1|~ request_hash|TEXT|1|0|~ request_id|TEXT|1|0|~ result|TEXT|1|0|~',
  edit_draft_proposals: 'body|TEXT|1|0|~ draft_id|TEXT|1|0|~ id|TEXT|0|1|~',
  edit_drafts:
    'body|TEXT|1|0|~ editor_key|TEXT|1|0|~ id|TEXT|0|1|~ kind|TEXT|1|0|~ revision|INTEGER|1|0|~ status|TEXT|1|0|~ target_id|TEXT|0|0|~',
  events: 'at|TEXT|1|0|~ chat_id|TEXT|1|0|~ entity_id|TEXT|1|0|~ kind|TEXT|1|0|~ seq|INTEGER|0|1|~',
  helper_artifact_jobs:
    'artifact_id|TEXT|0|0|~ artifact_revision|INTEGER|0|0|~ created_at|TEXT|1|0|~ error|TEXT|0|0|~ id|TEXT|0|1|~ operation_id|TEXT|1|0|~ snapshot|TEXT|1|0|~ status|TEXT|1|0|~ task_id|TEXT|1|0|~',
  helper_artifacts:
    'conversation_id|TEXT|1|0|~ created_at|TEXT|1|0|~ id|TEXT|1|1|~ origin|TEXT|1|0|~ request|TEXT|1|0|~ revision|INTEGER|1|2|~ snapshot|TEXT|1|0|~ task_id|TEXT|1|0|~ text|TEXT|1|0|~ usage|TEXT|1|0|~',
  helper_conversations:
    'auto_title|INTEGER|1|0|~ branch_id|TEXT|0|0|~ chat_id|TEXT|0|0|~ created_at|TEXT|1|0|~ creation_hash|TEXT|1|0|~ creation_key|TEXT|1|0|~ id|TEXT|0|1|~ limits|TEXT|1|0|\'{"totalCalls":24,"helperCalls":12,"artifacts":1}\' persona|TEXT|1|0|~ revision|INTEGER|1|0|~ scope_key|TEXT|1|0|~ scope|TEXT|1|0|~ title|TEXT|1|0|~ updated_at|TEXT|1|0|~',
  helper_delegations:
    'body|TEXT|1|0|~ branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ conversation_id|TEXT|0|0|~ created_at|TEXT|1|0|~ id|TEXT|0|1|~ revision|INTEGER|1|0|~ revoked_at|TEXT|0|0|~',
  helper_events:
    'conversation_id|TEXT|1|0|~ data|TEXT|1|0|~ kind|TEXT|1|0|~ seq|INTEGER|0|1|~ task_id|TEXT|0|0|~',
  helper_grants: 'body|TEXT|1|0|~ id|TEXT|0|1|~ task_id|TEXT|1|0|~',
  helper_messages:
    'artifacts|TEXT|1|0|~ conversation_id|TEXT|1|0|~ created_at|TEXT|1|0|~ id|TEXT|0|1|~ role|TEXT|1|0|~ task_id|TEXT|1|0|~ text|TEXT|1|0|~',
  helper_operations:
    'created_at|TEXT|1|0|~ id|TEXT|0|1|~ request_hash|TEXT|1|0|~ result|TEXT|1|0|~ task_id|TEXT|1|0|~',
  helper_task_attempts:
    'artifact_job_id|TEXT|0|0|~ attempt_id|TEXT|0|1|~ purpose|TEXT|1|0|~ segment|INTEGER|1|0|~ task_id|TEXT|1|0|~',
  helper_tasks:
    'conversation_id|TEXT|1|0|~ created_at|TEXT|1|0|~ error|TEXT|0|0|~ generation|INTEGER|1|0|0 id|TEXT|0|1|~ owner|TEXT|0|0|~ request_key|TEXT|1|0|~ request|TEXT|1|0|~ snapshot|TEXT|1|0|~ started_at|TEXT|0|0|~ status|TEXT|1|0|~ updated_at|TEXT|1|0|~ usage|TEXT|1|0|~',
  illustration_images:
    'body|TEXT|1|0|~ bytes|BLOB|1|0|~ chat_id|TEXT|1|0|~ created_at|TEXT|1|0|~ hash|TEXT|1|0|~ id|TEXT|0|1|~ job_id|TEXT|1|0|~ mime|TEXT|1|0|~ position|INTEGER|1|0|~',
  illustration_jobs:
    'attempt|INTEGER|1|0|1 chat_id|TEXT|1|0|~ created_at|TEXT|1|0|~ diagnostic|TEXT|0|0|~ error|TEXT|0|0|~ generation|INTEGER|1|0|0 id|TEXT|0|1|~ input|TEXT|1|0|~ origin|TEXT|1|0|~ owner|TEXT|0|0|~ source_hash|TEXT|1|0|~ source_revision|TEXT|1|0|~ status|TEXT|1|0|~ updated_at|TEXT|1|0|~',
  illustration_references: 'body|TEXT|1|0|~ chat_id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  illustration_settings: 'body|TEXT|1|0|~ id|INTEGER|0|1|~',
  job_results: 'created_at|TEXT|1|0|~ generation|INTEGER|1|0|~ job_id|TEXT|0|1|~ result|TEXT|1|0|~',
  jobs: 'chat_id|TEXT|1|0|~ created_at|TEXT|1|0|~ error|TEXT|0|0|~ generation|INTEGER|1|0|0 id|TEXT|0|1|~ input|TEXT|0|0|~ kind|TEXT|1|0|~ owner|TEXT|0|0|~ revision|INTEGER|1|0|1 source_hash|TEXT|1|0|~ source_revision|TEXT|1|0|~ status|TEXT|1|0|~ updated_at|TEXT|1|0|~',
  library_folders: 'category|TEXT|1|0|~ id|TEXT|0|1|~ sort_position|INTEGER|1|0|~ title|TEXT|1|0|~',
  library_hidden: 'id|TEXT|1|2|~ kind|TEXT|1|1|~',
  library_organization_state: 'id|INTEGER|0|1|~ revision|INTEGER|1|0|~',
  library_placements: 'category|TEXT|1|0|~ folder_id|TEXT|0|0|~ id|TEXT|1|2|~ kind|TEXT|1|1|~',
  model_inputs: 'input|TEXT|1|0|~ run_id|TEXT|1|0|~ seq|INTEGER|0|1|~',
  outline_batches:
    'authority|TEXT|1|0|~ branch_id|TEXT|1|0|~ chat_id|TEXT|1|1|~ created_at|TEXT|1|0|~ created|TEXT|1|0|~ operations|TEXT|1|0|~ request_key|TEXT|1|2|~',
  outline_nodes:
    'branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ command_id|TEXT|0|0|~ created_at|TEXT|1|0|~ fixed|INTEGER|1|0|0 id|TEXT|0|1|~ intent|TEXT|1|0|~ level|TEXT|1|0|~ parent_id|TEXT|0|0|~ position|INTEGER|1|0|~ request_key|TEXT|0|0|~ revision|INTEGER|1|0|~ title|TEXT|1|0|~ updated_at|TEXT|1|0|~',
  package_behavior_entropy: 'id|INTEGER|0|1|~ seed|TEXT|1|0|~',
  package_behavior_heads:
    'branch_id|TEXT|1|2|~ chat_id|TEXT|1|1|~ dependencies|TEXT|1|0|~ draws|TEXT|1|0|~ error|TEXT|0|0|~ instance_id|TEXT|1|3|~ status|TEXT|1|0|~',
  package_behavior_journal:
    'branch_id|TEXT|1|2|~ chat_id|TEXT|1|1|~ created_at|TEXT|1|0|~ idempotency_key|TEXT|1|4|~ instance_id|TEXT|1|3|~ payload_hash|TEXT|1|0|~ payload|TEXT|1|0|~ result|TEXT|1|0|~',
  package_behavior_opportunities:
    'body|TEXT|1|0|~ branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~',
  package_behavior_outputs: 'body|TEXT|1|0|~ instance_id|TEXT|1|2|~ source_id|TEXT|1|1|~',
  package_behavior_runs: 'body|TEXT|1|0|~ run_id|TEXT|0|1|~',
  package_behavior_states:
    'branch_id|TEXT|1|2|~ chat_id|TEXT|1|1|~ definition_hash|TEXT|1|0|~ instance_id|TEXT|1|3|~ scope|TEXT|1|0|~ state_revision|INTEGER|1|0|~ state|TEXT|1|0|~',
  package_requests:
    'action_key|TEXT|1|0|~ body|TEXT|1|0|~ branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ consumed_run_id|TEXT|0|0|~ dependencies|TEXT|1|0|~ id|TEXT|0|1|~ instance_id|TEXT|1|0|~ status|TEXT|1|0|~',
  profiles: 'body|TEXT|1|0|~ chat_id|TEXT|0|1|~',
  prompt_workspace: 'body|TEXT|1|0|~ id|INTEGER|0|1|~',
  provider_connection_tests:
    'body|TEXT|1|0|~ idempotency_key|TEXT|1|0|~ id|TEXT|0|1|~ model_id|TEXT|1|0|~ model_revision|INTEGER|1|0|~ sent_at|TEXT|0|0|~ status|TEXT|1|0|~',
  provider_settings: 'body|TEXT|1|0|~ id|TEXT|1|2|~ kind|TEXT|1|1|~ revision|INTEGER|1|0|~',
  response_stream_chunks:
    'attempt_id|TEXT|1|0|~ offset|INTEGER|1|0|~ segment|INTEGER|1|0|~ seq|INTEGER|0|1|~ task_id|TEXT|1|0|~ task_kind|TEXT|1|0|~ text|TEXT|1|0|~',
  response_stream_tasks:
    'chat_id|TEXT|0|0|~ created_at|TEXT|1|0|~ helper_task_id|TEXT|0|0|~ owner|TEXT|1|0|~ run_id|TEXT|0|0|~ status|TEXT|1|0|~ task_id|TEXT|1|2|~ task_kind|TEXT|1|1|~ updated_at|TEXT|1|0|~',
  runs: 'branch_id|TEXT|0|0|~ chat_id|TEXT|1|0|~ command|TEXT|1|0|~ created_at|TEXT|1|0|~ error|TEXT|0|0|~ id|TEXT|0|1|~ issue|TEXT|0|0|~ parent_revision|TEXT|0|0|~ partial_text|TEXT|0|0|~ request_key|TEXT|1|0|~ request|TEXT|1|0|~ snapshot|TEXT|1|0|~ source_revision|TEXT|0|0|~ status|TEXT|1|0|~ updated_at|TEXT|1|0|~ usage|TEXT|0|0|~',
  scene_commands:
    'branch_id|TEXT|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~ label|TEXT|1|0|~ request_key|TEXT|1|0|~ request|TEXT|1|0|~ run_id|TEXT|0|0|~ source_revision|TEXT|0|0|~ status|TEXT|1|0|~',
  source_edits:
    'created_at|TEXT|1|0|~ hash|TEXT|1|0|~ revision|INTEGER|1|2|~ source_id|TEXT|1|1|~ text|TEXT|1|0|~',
  sources:
    'chat_id|TEXT|1|0|~ created_at|TEXT|1|0|~ hash|TEXT|1|0|~ id|TEXT|0|1|~ parent_revision|TEXT|0|0|~ run_id|TEXT|1|0|~ text|TEXT|1|0|~',
  story_configs: 'body|TEXT|1|0|~ chat_id|TEXT|0|1|~ revision|INTEGER|1|0|~',
  story_jobs:
    "chat_id|TEXT|1|0|~ config_revision|INTEGER|1|0|~ created_at|TEXT|1|0|~ dependency_key|TEXT|1|0|~ error|TEXT|0|0|~ generation|INTEGER|1|0|0 id|TEXT|0|1|~ inputs|TEXT|1|0|'[]' kind|TEXT|1|0|~ mock|INTEGER|1|0|~ owner|TEXT|0|0|~ result|TEXT|0|0|~ snapshot|TEXT|1|0|~ source_hash|TEXT|1|0|~ source_revision|TEXT|1|0|~ status|TEXT|1|0|~ tool_events|TEXT|1|0|'[]' updated_at|TEXT|1|0|~",
  story_states:
    'body|TEXT|1|0|~ chat_id|TEXT|1|0|~ id|TEXT|0|1|~ job_id|TEXT|1|0|~ module_revision|INTEGER|1|0|~ parent_state_id|TEXT|0|0|~ source_hash|TEXT|1|0|~ source_revision|TEXT|1|0|~',
  tool_events: 'event|TEXT|1|0|~ run_id|TEXT|1|0|~ seq|INTEGER|0|1|~',
  versions: 'body|TEXT|1|0|~ id|TEXT|1|2|~ kind|TEXT|1|1|~ revision|INTEGER|1|3|~',
};
