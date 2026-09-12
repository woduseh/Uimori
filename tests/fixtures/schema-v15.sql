-- Frozen schema 15, captured before the versioned migration runner. Synthetic data only.
CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, head_revision TEXT, settings_revision INTEGER NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), parent_revision TEXT, status TEXT NOT NULL, request TEXT NOT NULL, snapshot TEXT NOT NULL, request_key TEXT NOT NULL, command TEXT NOT NULL, source_revision TEXT, error TEXT, usage TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, branch_id TEXT REFERENCES branches(id), partial_text TEXT, issue TEXT, UNIQUE(chat_id,request_key));
CREATE UNIQUE INDEX one_active_run_per_branch ON runs(branch_id) WHERE status IN ('queued','running','waiting_for_state');
CREATE INDEX runs_chat_activity ON runs(chat_id,created_at DESC);
CREATE TABLE sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), parent_revision TEXT REFERENCES sources(id), text TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('translation','status','image')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, input TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(source_revision,kind,revision));
CREATE TABLE job_results (job_id TEXT PRIMARY KEY REFERENCES jobs(id), generation INTEGER NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE model_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), input TEXT NOT NULL);
CREATE TABLE tool_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), event TEXT NOT NULL);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL, entity_id TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX chat_events ON events(chat_id,seq);
CREATE TABLE provider_connection_tests (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, model_id TEXT NOT NULL, model_revision INTEGER NOT NULL, status TEXT NOT NULL, sent_at TEXT, body TEXT NOT NULL);
CREATE UNIQUE INDEX one_active_connection_test_per_model ON provider_connection_tests(model_id) WHERE status='running';
CREATE TABLE versions (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
CREATE TABLE provider_settings (kind TEXT NOT NULL CHECK(kind IN ('connection','model')),id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE profiles (chat_id TEXT PRIMARY KEY REFERENCES chats(id),body TEXT NOT NULL);
CREATE TABLE branches (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),title TEXT NOT NULL,head_revision TEXT REFERENCES sources(id),revision INTEGER NOT NULL,is_default INTEGER NOT NULL);
CREATE UNIQUE INDEX default_branch ON branches(chat_id) WHERE is_default=1;
CREATE TABLE prompt_workspace (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
CREATE TABLE library_hidden (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE attempts (id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),run_id TEXT REFERENCES runs(id),job_id TEXT REFERENCES jobs(id),role TEXT NOT NULL,connection_id TEXT NOT NULL,model_id TEXT NOT NULL,status TEXT NOT NULL,request TEXT NOT NULL,response TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,raw_usage TEXT,price_revision TEXT,error TEXT,story_job_id TEXT REFERENCES story_jobs(id));
CREATE TABLE assets (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),body TEXT NOT NULL,bytes BLOB NOT NULL);
CREATE TABLE source_edits(source_id TEXT NOT NULL REFERENCES sources(id),revision INTEGER NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,revision));
CREATE TABLE story_configs(chat_id TEXT PRIMARY KEY REFERENCES chats(id),revision INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE story_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='state'),config_revision INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,status TEXT NOT NULL,snapshot TEXT NOT NULL,result TEXT,error TEXT,mock INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,dependency_key TEXT NOT NULL UNIQUE,inputs TEXT NOT NULL DEFAULT '[]',tool_events TEXT NOT NULL DEFAULT '[]');
CREATE INDEX story_jobs_queue ON story_jobs(status,created_at);
CREATE TABLE story_states(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES story_jobs(id),chat_id TEXT NOT NULL REFERENCES chats(id),source_revision TEXT NOT NULL REFERENCES sources(id),source_hash TEXT NOT NULL,module_revision INTEGER NOT NULL,parent_state_id TEXT,body TEXT NOT NULL);
CREATE INDEX story_states_source ON story_states(chat_id,source_revision,module_revision);
CREATE TABLE scene_commands(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,label TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT REFERENCES runs(id),source_revision TEXT REFERENCES sources(id),UNIQUE(chat_id,request_key));
CREATE TABLE author_notes(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),entry TEXT NOT NULL,retired_at TEXT,replaces_id TEXT REFERENCES author_notes(id));
CREATE TABLE author_note_heads(chat_id TEXT PRIMARY KEY REFERENCES chats(id),revision INTEGER NOT NULL);
CREATE TABLE author_note_commands(chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(chat_id,request_key));
CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,hash TEXT NOT NULL,origin TEXT NOT NULL,plan TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL,activated INTEGER NOT NULL);
CREATE TABLE context_heads(scope_key TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,checkpoint_id TEXT REFERENCES context_checkpoints(id));
CREATE TABLE context_commands(scope_key TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope_key,request_key));
CREATE TABLE context_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,command TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT NOT NULL,checkpoint TEXT,error TEXT,noop INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(chat_id,request_key));
CREATE UNIQUE INDEX one_active_context_job ON context_jobs(branch_id) WHERE status IN ('queued','running');
CREATE TABLE context_job_attempts(job_id TEXT NOT NULL REFERENCES context_jobs(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),PRIMARY KEY(job_id,attempt_id));
CREATE TABLE chat_folders(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,title TEXT NOT NULL,default_persona TEXT,revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE chat_organization(chat_id TEXT PRIMARY KEY REFERENCES chats(id),bot_id TEXT NOT NULL,folder_id TEXT REFERENCES chat_folders(id),revision INTEGER NOT NULL CHECK(revision>0),sort_position INTEGER NOT NULL);
CREATE INDEX chat_folders_bot ON chat_folders(bot_id);
CREATE INDEX chat_organization_folder ON chat_organization(folder_id);
CREATE TABLE library_organization_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE library_folders(id TEXT PRIMARY KEY,category TEXT NOT NULL CHECK(category IN ('bot','persona','module','prompts')),title TEXT NOT NULL,sort_position INTEGER NOT NULL CHECK(sort_position>=0));
CREATE TABLE library_placements(kind TEXT NOT NULL CHECK(kind IN ('content','prompt-preset')),id TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('bot','persona','module','prompts')),folder_id TEXT REFERENCES library_folders(id),PRIMARY KEY(kind,id));
CREATE INDEX library_placements_folder ON library_placements(folder_id);
CREATE TABLE package_behavior_states(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,scope TEXT NOT NULL,definition_hash TEXT NOT NULL,state_revision INTEGER NOT NULL,state TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id));
CREATE TABLE package_behavior_journal(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id,idempotency_key));
CREATE TABLE package_requests(
    id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),
    instance_id TEXT NOT NULL,action_key TEXT NOT NULL,body TEXT NOT NULL,dependencies TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','consumed','cancelled')),consumed_run_id TEXT REFERENCES runs(id),
    UNIQUE(chat_id,branch_id,instance_id,action_key));
CREATE UNIQUE INDEX package_request_pending ON package_requests(chat_id,branch_id) WHERE status='pending';
CREATE TABLE package_behavior_heads(chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,instance_id TEXT NOT NULL,dependencies TEXT NOT NULL,status TEXT NOT NULL,error TEXT,draws TEXT NOT NULL,PRIMARY KEY(chat_id,branch_id,instance_id));
CREATE TABLE package_behavior_outputs(source_id TEXT NOT NULL,instance_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source_id,instance_id));
CREATE TABLE package_behavior_entropy(id INTEGER PRIMARY KEY CHECK(id=1),seed TEXT NOT NULL);
CREATE TABLE package_behavior_opportunities(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE package_behavior_runs(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE helper_conversations(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,creation_key TEXT NOT NULL,creation_hash TEXT NOT NULL,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,scope TEXT NOT NULL,title TEXT NOT NULL,auto_title INTEGER NOT NULL,revision INTEGER NOT NULL,persona TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,limits TEXT NOT NULL DEFAULT '{"totalCalls":24,"helperCalls":12,"artifacts":1}',UNIQUE(scope_key,creation_key));
CREATE INDEX helper_conversations_scope ON helper_conversations(chat_id,branch_id,updated_at);
CREATE TABLE helper_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,request_key TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,snapshot TEXT NOT NULL,error TEXT,usage TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,updated_at TEXT NOT NULL,UNIQUE(conversation_id,request_key));
CREATE UNIQUE INDEX helper_one_active_task ON helper_tasks(conversation_id) WHERE status='running';
CREATE TABLE helper_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,artifacts TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,role));
CREATE TABLE helper_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX helper_events_cursor ON helper_events(conversation_id,seq);
CREATE TABLE helper_grants(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,body TEXT NOT NULL);
CREATE TABLE helper_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE helper_artifact_jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,operation_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,status TEXT NOT NULL,artifact_id TEXT,artifact_revision INTEGER,error TEXT,created_at TEXT NOT NULL);
CREATE TABLE helper_task_attempts(task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,purpose TEXT NOT NULL,segment INTEGER NOT NULL,artifact_job_id TEXT REFERENCES helper_artifact_jobs(id) ON DELETE CASCADE);
CREATE TABLE helper_artifacts(id TEXT NOT NULL,revision INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request TEXT NOT NULL,text TEXT NOT NULL,snapshot TEXT NOT NULL,usage TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE helper_delegations(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES helper_conversations(id) ON DELETE SET NULL,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE edit_drafts(
      id TEXT PRIMARY KEY, editor_key TEXT NOT NULL, kind TEXT NOT NULL,
      target_id TEXT, revision INTEGER NOT NULL CHECK(revision>0),
      status TEXT NOT NULL CHECK(status IN ('active','discarded')), body TEXT NOT NULL);
CREATE UNIQUE INDEX edit_drafts_active_editor ON edit_drafts(editor_key) WHERE status='active';
CREATE TABLE edit_draft_proposals(
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES edit_drafts(id), body TEXT NOT NULL);
CREATE TABLE edit_draft_operations(
      operation_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES edit_drafts(id),
      action TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      intent TEXT NOT NULL, result TEXT NOT NULL, before_body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE chat_lore_overrides(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),revision INTEGER NOT NULL,body TEXT NOT NULL,UNIQUE(chat_id,revision));
CREATE TABLE chat_override_heads(chat_id TEXT PRIMARY KEY REFERENCES chats(id),revision INTEGER NOT NULL);
CREATE TABLE chat_override_operations(operation_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),request_id TEXT NOT NULL,command_hash TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE chat_prompt_options(chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL);
CREATE TABLE chat_option_pending(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,body TEXT NOT NULL);
CREATE TABLE chat_option_operations(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,request_id TEXT NOT NULL,command_hash TEXT NOT NULL,command TEXT NOT NULL,intent TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE response_stream_tasks (
      task_kind TEXT NOT NULL, task_id TEXT NOT NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      helper_task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(task_kind, task_id)
    );
CREATE TABLE response_stream_chunks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_kind TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      segment INTEGER NOT NULL, offset INTEGER NOT NULL, text TEXT NOT NULL,
      FOREIGN KEY(task_kind, task_id) REFERENCES response_stream_tasks(task_kind, task_id) ON DELETE CASCADE,
      UNIQUE(task_kind, task_id, attempt_id, segment, offset)
    );
CREATE INDEX response_stream_cursor ON response_stream_chunks(task_kind, task_id, seq);
CREATE TABLE illustration_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
CREATE TABLE illustration_references (chat_id TEXT PRIMARY KEY REFERENCES chats(id), revision INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE illustration_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, attempt INTEGER NOT NULL DEFAULT 1, input TEXT NOT NULL, diagnostic TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX illustration_jobs_source ON illustration_jobs(source_revision,created_at);
CREATE INDEX illustration_jobs_chat ON illustration_jobs(chat_id,created_at);
CREATE TABLE illustration_images (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES illustration_jobs(id), chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX illustration_images_job ON illustration_images(job_id,position);
CREATE TABLE outline_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), parent_id TEXT REFERENCES outline_nodes(id), level TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, command_id TEXT REFERENCES scene_commands(id), request_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,request_key));
CREATE INDEX outline_nodes_branch ON outline_nodes(chat_id,branch_id,parent_id,position);
CREATE TABLE outline_batches (chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), request_key TEXT NOT NULL, authority TEXT NOT NULL, operations TEXT NOT NULL, created TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(chat_id,request_key));
PRAGMA user_version=15;
