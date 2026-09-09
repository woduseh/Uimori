import { DatabaseSync } from 'node:sqlite';
import { initHelperTaskTiming, initHelperWorkspace } from './helper-workspace.js';
import { initEditDrafts } from './edit-drafts.js';
import { initChatOverrides, freezeChatOverrides } from './chat-overrides.js';
import { initChatOptions, ChatOptionsStore } from './chat-options.js';
import { initResponseStreams } from './response-stream.js';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Controls } from './controls.js';
import {
  editSource,
  editTranslation,
  requestTranslation,
  requestStatus,
  latestTranslation,
  validateTranslationArtifact,
} from './source-editing.js';
import { ProductStore } from './product-store.js';
import { HttpError, text } from './request-validation.js';
export { HttpError } from './request-validation.js';
import { StoryStore } from './story-store.js';
import { OutlineStore, freezeOutline, initOutline } from './outline-store.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import { consumePackageRequestInTransaction } from './package-requests.js';
import { ChatOrganizationStore } from './chat-organization.js';
import { LibraryOrganizationStore } from './library-organization.js';
import { PackageBehaviorStore } from './package-behavior-store.js';
import {
  initBehaviorHost,
  freezePackageStates,
  completePackageOutputs,
  branchPackageStates,
} from './package-behavior-host.js';
import {
  initRunBehavior,
  prepareRunBehavior,
  copyCandidateBehavior,
} from './package-behavior-run.js';
import { completeAuthoredPackageStartStatesInTransaction } from './package-start.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import { ContextStore } from './context-store.js';
import { freezeLoreContext } from './lore-context.js';
import { splitSource, validateSourceIdentity } from '../core/auxiliary.js';
import {
  imageJobInput,
  mergedReaderAssets,
  imageTargetSource,
  scheduleTranslationImages,
  latestImageJob,
} from './package-images.js';
import {
  initIllustrations,
  recoverIllustrations,
  scheduleAutomaticIllustration,
} from './illustrations.js';
import type {
  Settings,
  Chat as BaseChat,
  Run as BaseRun,
  Source as BaseSource,
  Job as BaseJob,
  RunSnapshot,
  Usage,
  ModelInput,
  ToolEvent,
} from '../core/types.js';

export type Chat = BaseChat & { createdAt: string };
export type Run = BaseRun & { createdAt: string; updatedAt: string };
export type Source = BaseSource & { createdAt: string };
export type Job = BaseJob & {
  generation: number;
  input: unknown;
  createdAt: string;
  updatedAt: string;
};
type Row = Record<string, any>;
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: any) => (value === null ? null : JSON.parse(String(value)));
const now = () => new Date().toISOString();
/** One server owns this file DB. No transaction spans provider or browser I/O. */
export class Store {
  readonly db: DatabaseSync;
  readonly product: ProductStore;
  readonly story: StoryStore;
  readonly outline: OutlineStore;
  readonly context: ContextStore;
  readonly organization: ChatOrganizationStore;
  readonly libraryOrganization: LibraryOrganizationStore;
  readonly behavior: PackageBehaviorStore;
  private readonly ownership: DatabaseSync;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = existsSync(path)
      ? realpathSync(path)
      : join(realpathSync(dirname(path)), basename(path));
    // A separate empty SQLite file is an OS-released lifetime mutex. Story-data
    // writes use the short transactions below; they never wait on provider I/O.
    this.ownership = new DatabaseSync(`${this.path}.owner.sqlite`);
    try {
      this.ownership.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      this.ownership.close();
      throw new Error('Database already has a running server owner');
    }
    try {
      this.db = new DatabaseSync(this.path);
    } catch (error) {
      this.ownership.close();
      throw error;
    }
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (![0, 15].includes(version))
        throw new Error(
          `Unsupported database schema version ${version}; Uimori requires schema 15. For disposable default development data, stop the server and run npm run reset:dev.`
        );
      if (
        version === 0 &&
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
          )
          .get()
      )
        throw new Error(
          'Unversioned database is not empty. For disposable default development data, stop the server and run npm run reset:dev.'
        );
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
      this.product = new ProductStore(this);
      this.story = new StoryStore(this);
      this.outline = new OutlineStore(this);
      this.context = new ContextStore(this);
      this.organization = new ChatOrganizationStore(this);
      this.libraryOrganization = new LibraryOrganizationStore(this);
      this.behavior = new PackageBehaviorStore(this.db, (chatId, branchId) => {
        const branch = this.product.branch(chatId, branchId);
        return branch.headRevision ? this.source(branch.headRevision).hash : null;
      });
      // Keep the retired runs.issue storage column as an unused diagnostic field.
      if (version === 0)
        this.transaction(() => {
          this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, head_revision TEXT, settings_revision INTEGER NOT NULL, settings TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), parent_revision TEXT, status TEXT NOT NULL, request TEXT NOT NULL, snapshot TEXT NOT NULL, request_key TEXT NOT NULL, command TEXT NOT NULL, source_revision TEXT, error TEXT, usage TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, branch_id TEXT REFERENCES branches(id), partial_text TEXT, issue TEXT, UNIQUE(chat_id,request_key));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_branch ON runs(branch_id) WHERE status IN ('queued','running','waiting_for_state');
      CREATE INDEX runs_chat_activity ON runs(chat_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), parent_revision TEXT REFERENCES sources(id), text TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('translation','status','image')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, input TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(source_revision,kind,revision));
      CREATE TABLE IF NOT EXISTS job_results (job_id TEXT PRIMARY KEY REFERENCES jobs(id), generation INTEGER NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_inputs (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), input TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL, entity_id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_events ON events(chat_id,seq);
      CREATE TABLE provider_connection_tests (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, model_id TEXT NOT NULL, model_revision INTEGER NOT NULL, status TEXT NOT NULL, sent_at TEXT, body TEXT NOT NULL);
      CREATE UNIQUE INDEX one_active_connection_test_per_model ON provider_connection_tests(model_id) WHERE status='running';
      `);
          this.product.initFresh();
          this.story.initFresh();
          this.context.initFresh();
          this.organization.init();
          this.libraryOrganization.init();
          this.behavior.init();
          initBehaviorHost(this);
          initRunBehavior(this);
          initHelperWorkspace(this);
          initEditDrafts(this);
          initChatOverrides(this);
          initChatOptions(this);
          initResponseStreams(this.db);
          initIllustrations(this.db);
          initOutline(this.db);
          this.db.exec('PRAGMA user_version=15');
        });
      // Additive illustration and outline tables; a schema 15 database keeps its version and data.
      else {
        initIllustrations(this.db);
        initOutline(this.db);
      }
      initHelperTaskTiming(this);
    } catch (error) {
      this.db.close();
      this.ownership.close();
      throw error;
    }
  }
  close() {
    this.db.close();
    this.ownership.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      const savepoint = `nested_${randomUUID().replaceAll('-', '')}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const value = fn();
        this.db.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  event(chatId: string, kind: string, entityId: string) {
    this.db
      .prepare('INSERT INTO events(chat_id,kind,entity_id,at) VALUES(?,?,?,?)')
      .run(chatId, kind, entityId, now());
  }
  events(chatId: string, after: number) {
    return this.db
      .prepare(
        'SELECT seq,chat_id AS chatId,kind,entity_id AS entityId,at FROM events WHERE chat_id=? AND seq>? ORDER BY seq'
      )
      .all(chatId, after);
  }
  private mapChat(row: Row): Chat {
    const organization = this.organization.metadata(row.id);
    if (!organization) throw new HttpError(409, 'Chat organization missing');
    return {
      id: row.id,
      title: row.title,
      titleRevision: row.title_revision ?? 0,
      headRevision: row.head_revision,
      settingsRevision: row.settings_revision,
      settings: parse(row.settings),
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at ?? row.created_at,
      ...organization,
    };
  }
  chat(id: string): Chat {
    const row = this.db
      .prepare(
        "SELECT c.*, COALESCE((SELECT MAX(seq) FROM events WHERE chat_id=c.id AND kind IN ('chat.title.manual','chat.title.generated')),0) AS title_revision, MAX(c.created_at, COALESCE((SELECT MAX(r.created_at) FROM runs r WHERE r.chat_id=c.id), c.created_at)) AS last_activity_at FROM chats c WHERE id=?"
      )
      .get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Chat not found');
    return this.mapChat(row);
  }
  chats(): Chat[] {
    return (
      this.db
        .prepare(
          "SELECT c.*, COALESCE((SELECT MAX(seq) FROM events WHERE chat_id=c.id AND kind IN ('chat.title.manual','chat.title.generated')),0) AS title_revision, MAX(c.created_at, COALESCE((SELECT MAX(r.created_at) FROM runs r WHERE r.chat_id=c.id), c.created_at)) AS last_activity_at FROM chats c ORDER BY c.created_at,c.id"
        )
        .all() as Row[]
    ).map((row) => this.mapChat(row));
  }
  createChat(
    title: string,
    preset: Settings['preset'] = 'calm',
    organization: { botId?: string; folderId?: string | null } = {}
  ): Chat {
    const id = randomUUID();
    const settings: Settings = {
      preset,
      mode: 'direct',
      translation: true,
      status: false,
      maxCalls: 8,
    };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO chats VALUES(?,?,NULL,1,?,?)')
        .run(id, title, json(settings), now());
      this.db
        .prepare('INSERT INTO branches VALUES(?,?,?,NULL,1,1)')
        .run(`main:${id}`, id, '기본 분기');
      this.organization.create(id, organization);
    });
    return this.chat(id);
  }
  renameChat(id: string, title: string, expectedTitleRevision: number): Chat {
    return this.transaction(() => {
      const prior = this.chat(id);
      if (prior.titleRevision !== expectedTitleRevision)
        throw new HttpError(
          409,
          '채팅 제목이 다른 곳에서 변경됐어요. 취소 후 최신 제목을 확인해 주세요.'
        );
      this.db.prepare('UPDATE chats SET title=? WHERE id=?').run(title, id);
      // Even saving the same text records manual intent and prevents an automatic overwrite.
      this.event(id, 'chat.title.manual', id);
      return this.chat(id);
    });
  }
  history(head: string | null): RunSnapshot['history'] {
    const history: RunSnapshot['history'] = [];
    const seen = new Set<string>();
    // Execution history needs exact text/hash/policy, not Reader blocks or translation jobs.
    // Keep source integrity checks while projecting the latest edit in one read per ancestor.
    const read =
      this.db.prepare(`SELECT s.id,s.chat_id AS chatId,s.parent_revision AS parentRevision,
      s.text,s.hash,e.text AS editedText,e.hash AS editedHash,
      json_extract(r.snapshot,'$.sourceSegments') AS policy
      FROM sources s JOIN runs r ON r.id=s.run_id
      LEFT JOIN source_edits e ON e.source_id=s.id
        AND e.revision=(SELECT MAX(revision) FROM source_edits WHERE source_id=s.id)
      WHERE s.id=?`);
    while (head) {
      if (seen.has(head)) throw new HttpError(400, 'Source ancestry cycle');
      seen.add(head);
      const source = read.get(head) as
        | {
            id: string;
            chatId: string;
            parentRevision: string | null;
            text: string;
            hash: string;
            editedText: string | null;
            editedHash: string | null;
            policy: string | null;
          }
        | undefined;
      if (!source) throw new HttpError(404, 'Source not found');
      validateSourceIdentity(source);
      if (source.editedText !== null)
        validateSourceIdentity({ ...source, text: source.editedText, hash: source.editedHash! });
      const sourceSegments = source.policy ? parse(source.policy) : undefined;
      history.push({
        revision: source.id,
        text: source.editedText ?? source.text,
        ...(source.editedHash !== null && source.editedHash !== source.hash
          ? { contentHash: source.editedHash }
          : {}),
        ...(sourceSegments ? { sourceSegments } : {}),
      });
      head = source.parentRevision;
    }
    return history.reverse();
  }
  settings(id: string, expected: number, settings: Settings): Chat {
    return this.transaction(() => {
      this.chat(id);
      const changed = this.db
        .prepare(
          'UPDATE chats SET settings=?, settings_revision=settings_revision+1 WHERE id=? AND settings_revision=?'
        )
        .run(json(settings), id, expected);
      if (Number(changed.changes) !== 1) throw new HttpError(409, 'Settings revision conflict');
      this.event(id, 'settings.updated', id);
      return this.chat(id);
    });
  }
  createRun(
    chatId: string,
    command: {
      request: string;
      expectedRevision: string | null;
      expectedSettingsRevision: number;
      idempotencyKey: string;
      branchId?: string;
      expectedProfileRevision?: number;
      sceneCommandId?: string;
      packageRequestId?: string;
      loreContextReset?: boolean;
      packageStart?: import('../core/package-start.js').PackageStartRef;
      retryOf?: string;
      requestEdited?: boolean;
    },
    snapshot: (chat: Chat) => RunSnapshot
  ): { run: Run; created: boolean } {
    return this.transaction(() => this.createRunInTransaction(chatId, command, snapshot));
  }
  /** Joins the host's transaction when an authored opening and its source commit together. */
  createRunInTransaction(
    chatId: string,
    command: Parameters<Store['createRun']>[1],
    snapshot: (chat: Chat) => RunSnapshot
  ): { run: Run; created: boolean } {
    if (command.loreContextReset !== undefined && typeof command.loreContextReset !== 'boolean')
      throw new HttpError(400, 'Invalid lore context reset');
    const canonical = json({
      request: command.request,
      expectedRevision: command.expectedRevision,
      expectedSettingsRevision: command.expectedSettingsRevision,
      branchId: command.branchId ?? `main:${chatId}`,
      expectedProfileRevision: command.expectedProfileRevision,
      ...(command.sceneCommandId ? { sceneCommandId: command.sceneCommandId } : {}),
      ...(command.packageRequestId ? { packageRequestId: command.packageRequestId } : {}),
      ...(command.packageStart ? { packageStart: command.packageStart } : {}),
      ...(command.loreContextReset ? { loreContextReset: true } : {}),
      ...(command.retryOf ? { retryOf: command.retryOf } : {}),
      ...(command.requestEdited ? { requestEdited: true } : {}),
    });
    const prior = this.db
      .prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?')
      .get(chatId, command.idempotencyKey) as Row | undefined;
    if (prior) {
      if (prior.command !== canonical)
        throw new HttpError(409, 'Idempotency key reused with different command');
      return { run: this.run(prior.id), created: false };
    }
    const chat = this.chat(chatId);
    const branch = this.product.branch(chatId, command.branchId);
    if (branch.headRevision !== command.expectedRevision)
      throw new HttpError(409, 'Source revision conflict');
    if (chat.settingsRevision !== command.expectedSettingsRevision)
      throw new HttpError(409, 'Settings revision conflict');
    if (
      command.expectedProfileRevision !== undefined &&
      this.product.profile(chatId).revision !== command.expectedProfileRevision
    )
      throw new HttpError(409, 'Profile revision conflict');
    if (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE branch_id=? AND status IN ('queued','running','waiting_for_state')"
        )
        .get(branch.id)
    )
      throw new HttpError(409, 'A run already owns this head');
    const id = randomUUID();
    const time = now();
    const base = {
      ...snapshot({ ...chat, headRevision: branch.headRevision }),
      ...(command.loreContextReset ? { loreContextReset: true } : {}),
      executionClock: { iso: time, unix: Math.floor(Date.parse(time) / 1000) },
      branchId: branch.id,
    };
    if (base.profile) {
      new ChatOptionsStore(this).freeze(base.profile, branch.id, id);
      const roots =
        base.profile.chatOverrides?.roots ?? this.product.profile(chatId).packageAttachments ?? [];
      const overrides = freezeChatOverrides(this, base.profile, roots, branch.headRevision);
      if (overrides) base.profile.chatOverrides = overrides;
      else delete base.profile.chatOverrides;
      if (base.profile.packageAttachments?.length)
        base.resources = [
          ...base.resources.filter((resource) => !resource.id.startsWith('package:')),
          ...this.product
            .resources(chatId, base.profile)
            .filter((resource) => resource.id.startsWith('package:')),
        ];
    }
    const sourceSegments = freezeSourceSegments(base.profile);
    const authored = base.packageStart?.mode === 'authored';
    let frozen = authored
      ? { ...base, ...(sourceSegments ? { sourceSegments } : {}) }
      : this.story.prepareRunInTransaction({
          ...base,
          ...(sourceSegments ? { sourceSegments } : {}),
        });
    if (command.sceneCommandId) frozen = freezeOutline(this, command.sceneCommandId, frozen);
    frozen = freezePackageStates(
      this,
      { ...frozen, logicalHistory: captureLogicalHistory(this, frozen) },
      true
    );
    frozen = freezeLoreContext(this, authored ? frozen : prepareRunBehavior(this, id, frozen));
    frozen = compileSnapshotPrompt(authored ? frozen : this.context.prepareRun(frozen));
    const status = frozen.story?.waiting ? 'waiting_for_state' : 'queued';
    this.db
      .prepare(
        'INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        chatId,
        command.expectedRevision,
        status,
        command.request,
        json(frozen),
        command.idempotencyKey,
        canonical,
        time,
        time,
        branch.id
      );
    if (command.sceneCommandId) this.story.bindCommandInTransaction(command.sceneCommandId, id);
    if (command.packageRequestId)
      consumePackageRequestInTransaction(
        this,
        chatId,
        branch.id,
        command.packageRequestId,
        command.request,
        id
      );
    this.event(chatId, `run.${status}`, id);
    return { run: this.run(id), created: true };
  }
  /** A new request with current settings, branching before the selected response. */
  retryRun(
    runId: string,
    key: string,
    validate?: (snapshot: RunSnapshot) => void,
    editedRequest?: string
  ): { run: Run; created: boolean } {
    return this.transaction(() => {
      const original = this.run(runId);
      const requestEdited = editedRequest !== undefined;
      const nextRequest = requestEdited ? text(editedRequest, 'request') : original.request;
      const prior = this.db
        .prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?')
        .get(original.chatId, key) as Row | undefined;
      if (prior) {
        const command = parse(prior.command);
        if (
          command.retryOf !== runId ||
          (command.requestEdited === true) !== requestEdited ||
          command.request !== nextRequest
        )
          throw new HttpError(409, 'Idempotency key reused with different command');
        return { run: this.run(prior.id), created: false };
      }
      if (['queued', 'running', 'waiting_for_state'].includes(original.status))
        throw new HttpError(409, 'Original run is still active');
      if (original.snapshot.packageStart?.mode === 'authored')
        throw new HttpError(409, 'Authored opening has no model request to repeat');
      const profile = this.product.snapshot(original.chatId);
      const chat = this.chat(original.chatId);
      const originalBranch = this.product.branch(original.chatId, original.snapshot.branchId);
      if (
        !original.sourceRevision &&
        this.db
          .prepare("SELECT id FROM runs WHERE chat_id=? AND json_extract(command,'$.retryOf')=?")
          .get(original.chatId, original.id)
      )
        throw new HttpError(409, 'This request already has a newer attempt');
      // Keep the unchanged failed turn's position and preserve each execution.
      const branch =
        !original.sourceRevision && originalBranch.headRevision === original.parentRevision
          ? originalBranch
          : this.product.createBranch(original.chatId, {
              title: requestEdited ? '요청 수정' : '다시 요청',
              fromRevision: original.parentRevision,
            });
      return this.createRunInTransaction(
        original.chatId,
        {
          request: nextRequest,
          expectedRevision: original.parentRevision,
          expectedSettingsRevision: chat.settingsRevision,
          expectedProfileRevision: profile.revision,
          branchId: branch.id,
          idempotencyKey: key,
          retryOf: runId,
          ...(original.snapshot.loreContextReset ? { loreContextReset: true } : {}),
          ...(requestEdited ? { requestEdited: true } : {}),
        },
        (current) => {
          const snapshot: RunSnapshot = {
            chatId: current.id,
            parentRevision: current.headRevision,
            settingsRevision: current.settingsRevision,
            settings: current.settings,
            request: nextRequest,
            history: this.history(current.headRevision),
            resources: this.product.resources(current.id, profile),
            profile,
            branchId: branch.id,
          };
          validate?.(snapshot);
          return snapshot;
        }
      );
    });
  }
  candidate(
    runId: string,
    key: string,
    title: string,
    validate?: (snapshot: RunSnapshot) => void
  ): { run: Run; created: boolean } {
    return this.transaction(() => {
      const original = this.run(runId);
      if (original.snapshot.packageStart?.mode === 'authored')
        throw new HttpError(409, 'Authored opening cannot be regenerated as a model candidate');
      if (['queued', 'running', 'waiting_for_state'].includes(original.status))
        throw new HttpError(409, 'Original run is still active');
      const canonical = json({ candidateOf: runId, title });
      const prior = this.db
        .prepare('SELECT id,command FROM runs WHERE chat_id=? AND request_key=?')
        .get(original.chatId, key) as Row | undefined;
      if (prior) {
        if (prior.command !== canonical)
          throw new HttpError(409, 'Idempotency key reused with different command');
        return { run: this.run(prior.id), created: false };
      }
      validate?.(original.snapshot);
      const branch = this.product.createBranch(original.chatId, {
        title,
        fromRevision: original.parentRevision,
      });
      const snapshot: RunSnapshot = {
        ...structuredClone(original.snapshot),
        branchId: branch.id,
        candidateOf: original.id,
      };
      if (snapshot.contextPlan?.status === 'ready' && snapshot.promptCompilation) {
        snapshot.contextPlan.summaryCalls = 0;
        snapshot.contextPlan.usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      }
      branchPackageStates(this, original.chatId, branch.id, original.parentRevision, snapshot);
      freezePackageStates(this, snapshot, false);
      const id = randomUUID();
      const time = now();
      copyCandidateBehavior(this, original, id, snapshot);
      this.db
        .prepare(
          "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id) VALUES(?,?,?,'queued',?,?,?,?,?,?,?)"
        )
        .run(
          id,
          original.chatId,
          original.parentRevision,
          original.request,
          json(snapshot),
          key,
          canonical,
          time,
          time,
          branch.id
        );
      this.event(original.chatId, 'run.queued', id);
      return { run: this.run(id), created: true };
    });
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Run not found');
    const calls = this.db
      .prepare('SELECT count(*) AS count FROM model_inputs WHERE run_id=?')
      .get(id) as Row;
    return {
      id: row.id,
      chatId: row.chat_id,
      parentRevision: row.parent_revision,
      settingsRevision: parse(row.snapshot).settingsRevision,
      status: row.status,
      request: row.request,
      snapshot: parse(row.snapshot),
      sourceRevision: row.source_revision,
      error: row.error,
      usage: parse(row.usage) ?? {
        modelCalls: calls.count,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      partialText: row.partial_text ?? '',
      inputs: (
        this.db
          .prepare('SELECT input FROM model_inputs WHERE run_id=? ORDER BY seq')
          .all(id) as Row[]
      ).map((r) => parse(r.input)),
      toolEvents: (
        this.db
          .prepare('SELECT event FROM tool_events WHERE run_id=? ORDER BY seq')
          .all(id) as Row[]
      ).map((r) => parse(r.event)),
    };
  }
  startRun(id: string) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.status !== 'queued') return false;
      this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").run(now(), id);
      this.event(run.chatId, 'run.running', id);
      return true;
    });
  }
  input(id: string, input: ModelInput) {
    this.db.prepare('INSERT INTO model_inputs(run_id,input) VALUES(?,?)').run(id, json(input));
  }
  tool(id: string, event: ToolEvent) {
    this.db.prepare('INSERT INTO tool_events(run_id,event) VALUES(?,?)').run(id, json(event));
  }
  finishRun(
    id: string,
    status: 'failed' | 'cancelled' | 'interrupted' | 'refused' | 'partial',
    error: string,
    partialText = '',
    usage?: Usage
  ) {
    return this.transaction(() => {
      const run = this.run(id);
      if (!['queued', 'running', 'waiting_for_state'].includes(run.status)) return run;
      this.db
        .prepare(
          'UPDATE runs SET status=?,error=?,partial_text=?,usage=COALESCE(?,usage),updated_at=? WHERE id=?'
        )
        .run(status, error, partialText, usage ? json(usage) : null, now(), id);
      this.story.finishCommandInTransaction(id, status === 'cancelled' ? 'cancelled' : 'failed');
      this.event(run.chatId, `run.${status}`, id);
      return this.run(id);
    });
  }
  settleCancelledUsage(id: string, usage: Usage): Run {
    return this.transaction(() => {
      const run = this.run(id);
      // A cancel endpoint may finish the run before the in-flight attempt returns.
      // Fill that missing aggregate once without changing status, source, or prior usage.
      const changed = this.db
        .prepare(
          "UPDATE runs SET usage=?,updated_at=? WHERE id=? AND status='cancelled' AND usage IS NULL"
        )
        .run(json(usage), now(), id);
      if (changed.changes) this.event(run.chatId, 'run.usage', id);
      return this.run(id);
    });
  }
  completeRun(
    id: string,
    text: string,
    usage: Usage,
    settings: Settings,
    controls?: Controls
  ): Source {
    return this.transaction(() =>
      this.completeRunInTransaction(id, text, usage, settings, controls)
    );
  }
  /** Provider completion and authored openings share source/branch CAS and source hashing. */
  completeRunInTransaction(
    id: string,
    text: string,
    usage: Usage,
    settings: Settings,
    controls?: Controls
  ): Source {
    const run = this.run(id);
    if (run.status !== 'running') throw new HttpError(409, 'Run no longer owns completion');
    const branch = this.product.branch(run.chatId, run.snapshot.branchId);
    if (branch.headRevision !== run.parentRevision)
      throw new HttpError(409, 'Source revision changed');
    const source: Source = {
      id: randomUUID(),
      runId: id,
      chatId: run.chatId,
      parentRevision: run.parentRevision,
      text,
      hash: createHash('sha256').update(text).digest('hex'),
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)')
      .run(
        source.id,
        source.chatId,
        id,
        source.parentRevision,
        source.text,
        source.hash,
        source.createdAt
      );
    this.db
      .prepare(
        "UPDATE runs SET status='completed',source_revision=?,usage=?,updated_at=? WHERE id=?"
      )
      .run(source.id, json(usage), now(), id);
    controls?.fail('source-transaction');
    this.db
      .prepare('UPDATE branches SET head_revision=?,revision=revision+1 WHERE id=?')
      .run(source.id, branch.id);
    if (branch.default)
      this.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(source.id, source.chatId);
    for (const kind of ['status', 'image'] as const) {
      if (run.snapshot.packageStart?.mode === 'authored') continue;
      if (!(kind === 'image' ? run.snapshot.profile?.image : settings[kind])) continue;
      if (kind === 'image' && !imageJobInput(this, run.snapshot).imageCatalog.entries.length)
        continue;
      const jobId = randomUUID();
      const time = now();
      this.db
        .prepare(
          "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)"
        )
        .run(
          jobId,
          source.chatId,
          source.id,
          source.hash,
          kind,
          kind === 'image'
            ? json({
                ...imageJobInput(this, run.snapshot),
                imageTarget: { mode: 'original', textHash: source.hash },
              })
            : null,
          time,
          time
        );
      this.event(source.chatId, 'job.queued', jobId);
    }
    if (run.snapshot.packageStart?.mode === 'authored')
      completeAuthoredPackageStartStatesInTransaction(this, run, source);
    else {
      this.story.reserveSourceInTransaction(source, run);
      completePackageOutputs(this, run, source);
      // Illustrations never block the source commit; reservation problems become visible jobs.
      if (!run.snapshot.candidateOf) scheduleAutomaticIllustration(this, source);
    }
    this.event(source.chatId, 'source.ready', source.id);
    this.event(source.chatId, 'run.completed', id);
    return source;
  }
  sourceOriginal(id: string): Source {
    const row = this.db
      .prepare(
        'SELECT id,chat_id AS chatId,run_id AS runId,parent_revision AS parentRevision,text,hash,created_at AS createdAt FROM sources WHERE id=?'
      )
      .get(id) as Source | undefined;
    if (!row) throw new HttpError(404, 'Source not found');
    const translation = this.db
      .prepare(
        "SELECT revision FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1"
      )
      .get(id) as Row | undefined;
    return {
      ...row,
      editRevision: 0,
      translationRevision: translation?.revision ?? 0,
      blocks: splitSource(row),
    };
  }
  source(id: string): Source {
    const original = this.sourceOriginal(id);
    const edit = this.db
      .prepare(
        'SELECT text,hash,revision FROM source_edits WHERE source_id=? ORDER BY revision DESC LIMIT 1'
      )
      .get(id) as Row | undefined;
    if (!edit) return original;
    const source = { ...original, text: edit.text, hash: edit.hash, editRevision: edit.revision };
    return { ...source, blocks: splitSource(source) };
  }
  sourceAtHash(id: string, hash: string): Source {
    const original = this.sourceOriginal(id);
    if (original.hash === hash) return original;
    const edit = this.db
      .prepare(
        'SELECT text,hash,revision FROM source_edits WHERE source_id=? AND hash=? ORDER BY revision DESC LIMIT 1'
      )
      .get(id, hash) as Row | undefined;
    if (!edit) throw new HttpError(400, 'Unknown source content hash');
    const source = { ...original, text: edit.text, hash: edit.hash, editRevision: edit.revision };
    return { ...source, blocks: splitSource(source) };
  }
  validateHistory(history: RunSnapshot['history'], head: string | null): boolean {
    if (!Array.isArray(history)) return false;
    const ids = this.history(head).map((item) => item.revision);
    if (ids.length !== history.length) return false;
    return history.every((item, index) => {
      if (
        !item ||
        item.revision !== ids[index] ||
        Object.keys(item).some(
          (k) => !['revision', 'text', 'contentHash', 'sourceSegments'].includes(k)
        )
      )
        return false;
      const source =
        item.contentHash === undefined
          ? this.sourceOriginal(item.revision)
          : this.sourceAtHash(item.revision, item.contentHash);
      return item.text === source.text;
    });
  }
  editSource(id: string, value: { text: string; expectedRevision: number }): Source {
    return editSource(this, id, value);
  }
  editTranslation(
    id: string,
    value: { text: string; expectedRevision: number; expectedSourceHash: string }
  ): Job {
    return editTranslation(this, id, value);
  }
  requestTranslation(id: string, validate?: (id: string) => void): Job {
    return requestTranslation(this, id, false, validate);
  }
  requestStatus(
    id: string,
    expectedSourceHash: string,
    expectedJobId: string | null,
    validate?: (id: string) => void
  ): Job {
    return requestStatus(this, id, expectedSourceHash, expectedJobId, validate);
  }
  job(id: string): Job {
    const row = this.db
      .prepare(
        'SELECT j.*,r.result FROM jobs j LEFT JOIN job_results r ON r.job_id=j.id WHERE j.id=?'
      )
      .get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Job not found');
    return {
      id: row.id,
      chatId: row.chat_id,
      sourceRevision: row.source_revision,
      sourceHash: row.source_hash,
      kind: row.kind,
      status: row.status,
      attempt: row.generation,
      generation: row.generation,
      input: parse(row.input),
      ...(row.kind === 'image' && parse(row.input)?.imageTarget
        ? { imageTarget: parse(row.input).imageTarget }
        : {}),
      ...(row.kind === 'translation' &&
      row.status === 'completed' &&
      typeof parse(row.result)?.text === 'string'
        ? (() => {
            const body = parse(row.result).text;
            const textHash = createHash('sha256').update(body).digest('hex');
            return {
              translationLayout: {
                textHash,
                blocks: splitSource({
                  id: row.source_revision,
                  chatId: row.chat_id,
                  text: body,
                  hash: textHash,
                }),
              },
            };
          })()
        : {}),
      result: parse(row.result ?? null),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      ...(row.kind === 'translation' && row.status !== 'completed'
        ? (() => {
            const previous = this.db
              .prepare(
                "SELECT j.id,j.revision,r.result FROM jobs j JOIN job_results r ON r.job_id=j.id WHERE j.source_revision=? AND j.source_hash=? AND j.kind='translation' AND j.status='completed' AND j.revision<? ORDER BY j.revision DESC LIMIT 1"
              )
              .get(row.source_revision, row.source_hash, row.revision) as Row | undefined;
            if (!previous) return {};
            const saved = this.job(previous.id);
            try {
              validateTranslationArtifact(this, saved, this.source(row.source_revision));
            } catch {
              return {};
            }
            return {
              previousResult: {
                jobId: previous.id,
                revision: previous.revision,
                result: parse(previous.result),
                translationLayout: saved.translationLayout,
              },
            };
          })()
        : {}),
    };
  }
  queuedJobs(): string[] {
    return (
      this.db
        .prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id")
        .all() as Row[]
    ).map((row) => row.id);
  }
  claimJob(id: string, owner: string, input: unknown): Job | null {
    return this.transaction(() => {
      const pending = this.job(id);
      if (pending.kind === 'image') imageTargetSource(this, pending, true);
      const prior = pending.input;
      const claimedInput =
        input && typeof input === 'object' && !Array.isArray(input)
          ? {
              ...(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}),
              ...input,
            }
          : input;
      const changed = this.db
        .prepare(
          "UPDATE jobs SET status='running',generation=generation+1,owner=?,input=?,error=NULL,updated_at=? WHERE id=? AND status='queued'"
        )
        .run(owner, json(claimedInput), now(), id);
      if (!changed.changes) return null;
      const job = this.job(id);
      this.event(job.chatId, 'job.running', id);
      return job;
    });
  }
  completeJob(
    id: string,
    generation: number,
    owner: string,
    result: unknown,
    controls?: Controls
  ): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
      if (!row || row.status !== 'running' || row.generation !== generation || row.owner !== owner)
        return false;
      const source = this.source(row.source_revision);
      if (source.hash !== row.source_hash || source.chatId !== row.chat_id)
        throw new Error('Job source dependency changed');
      if (row.kind === 'image') imageTargetSource(this, this.job(id), true);
      this.db
        .prepare(
          'INSERT INTO job_results VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,result=excluded.result,created_at=excluded.created_at'
        )
        .run(id, generation, json(result), now());
      controls?.fail('job-transaction');
      this.db.prepare("UPDATE jobs SET status='completed',updated_at=? WHERE id=?").run(now(), id);
      if (row.kind === 'translation') scheduleTranslationImages(this, this.job(id));
      this.event(row.chat_id, 'job.completed', id);
      return true;
    });
  }
  failJob(id: string, generation: number, owner: string, error: string) {
    this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running' AND generation=? AND owner=?"
        )
        .run(error, now(), id, generation, owner);
      if (changed.changes) this.event(this.job(id).chatId, 'job.failed', id);
    });
  }
  failQueuedJob(id: string, expectedGeneration: number, error: string) {
    this.transaction(() => {
      const changed = this.db
        .prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='queued' AND generation=?"
        )
        .run(error, now(), id, expectedGeneration);
      if (changed.changes) this.event(this.job(id).chatId, 'job.failed', id);
    });
  }
  retryJob(id: string, validate?: (id: string) => void): Job {
    const job = this.job(id);
    if (job.kind === 'translation')
      return requestTranslation(this, job.sourceRevision, true, validate);
    return this.transaction(() => {
      const job = this.job(id);
      if (job.kind === 'status') {
        const latest = this.db
          .prepare(
            "SELECT id FROM jobs WHERE source_revision=? AND kind='status' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1"
          )
          .get(job.sourceRevision) as { id: string } | undefined;
        if (latest?.id !== id)
          throw new HttpError(409, 'Status job was replaced; refresh before retrying');
      }
      if (job.kind === 'image') {
        imageTargetSource(this, job, true);
        const mode = job.imageTarget?.mode ?? 'original';
        if (latestImageJob(this, job.sourceRevision, mode)?.id !== id)
          throw new HttpError(409, 'Image job replaced');
      }
      validate?.(id);
      if (['failed', 'partial', 'interrupted', 'cancelled'].includes(job.status)) {
        this.db
          .prepare("UPDATE jobs SET status='queued',error=NULL,updated_at=? WHERE id=?")
          .run(now(), id);
        this.event(job.chatId, 'job.queued', id);
      }
      return this.job(id);
    });
  }
  cancelJob(id: string): Job {
    return this.transaction(() => {
      const job = this.job(id);
      if (['queued', 'running'].includes(job.status)) {
        this.db
          .prepare(
            "UPDATE jobs SET status='cancelled',error='Job cancelled',updated_at=? WHERE id=?"
          )
          .run(now(), id);
        this.event(job.chatId, 'job.cancelled', id);
      }
      return this.job(id);
    });
  }
  retranslate(id: string, validate?: (id: string) => void): Job {
    return requestTranslation(this, id, true, validate);
  }
  finishAuxiliary(
    id: string,
    generation: number,
    owner: string,
    value: {
      status: string;
      result: unknown;
      error: string | null;
      diagnostic?: import('../core/auxiliary-diagnostic.js').AuxiliaryFailureDiagnostic;
    },
    controls?: Controls
  ) {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'")
        .get(id, generation, owner) as Row | undefined;
      if (!row) return false;
      const source = this.source(row.source_revision);
      if (source.hash !== row.source_hash || source.chatId !== row.chat_id)
        throw new Error('Job source dependency changed');
      if (row.kind === 'image') imageTargetSource(this, this.job(id), true);
      if (value.diagnostic) {
        const input = parse(row.input) ?? {};
        this.db
          .prepare('UPDATE jobs SET input=? WHERE id=?')
          .run(json({ ...input, failureDiagnostic: value.diagnostic }), id);
      }
      if (value.result) {
        this.db
          .prepare(
            'INSERT INTO job_results VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET generation=excluded.generation,result=excluded.result,created_at=excluded.created_at'
          )
          .run(id, generation, json(value.result), now());
        controls?.fail('job-transaction');
      }
      this.db
        .prepare('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?')
        .run(value.status, value.error, now(), id);
      if (row.kind === 'translation' && value.status === 'completed')
        scheduleTranslationImages(this, this.job(id));
      this.event(row.chat_id, `job.${value.status}`, id);
      return true;
    });
  }
  ownsJob(id: string, generation: number, owner: string) {
    return !!this.db
      .prepare("SELECT 1 FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'")
      .get(id, generation, owner);
  }
  recover() {
    this.transaction(() => {
      for (const row of this.db
        .prepare("SELECT id FROM runs WHERE status IN ('queued','running')")
        .all() as Row[]) {
        const run = this.run(row.id);
        this.db
          .prepare(
            "UPDATE runs SET status='interrupted',error='Server stopped; generation was not automatically replayed',updated_at=? WHERE id=?"
          )
          .run(now(), run.id);
        this.story.finishCommandInTransaction(run.id, 'failed');
        this.event(run.chatId, 'run.interrupted', run.id);
      }
      for (const row of this.db
        .prepare("SELECT id,source_revision,kind FROM jobs WHERE status='running'")
        .all() as Row[]) {
        const source = this.sourceAtHash(row.source_revision, this.job(row.id).sourceHash);
        const snapshot = this.product.resolveJobPrompt(
          this.run(source.runId).snapshot,
          this.job(row.id).input
        );
        const live = !!snapshot.profile?.models[row.kind as 'translation' | 'status' | 'image'];
        this.db
          .prepare('UPDATE jobs SET status=?,owner=NULL,error=?,updated_at=? WHERE id=?')
          .run(
            live ? 'interrupted' : 'queued',
            live ? 'Provider outcome uncertain; explicit retry required' : null,
            now(),
            row.id
          );
      }
      this.db
        .prepare(
          "UPDATE attempts SET status='interrupted',error='Provider outcome uncertain; not replayed' WHERE status='running'"
        )
        .run();
      recoverIllustrations(this);
    });
  }
  detail(id: string) {
    const chat = this.chat(id);
    return {
      chat,
      runs: (
        this.db
          .prepare('SELECT id FROM runs WHERE chat_id=? ORDER BY created_at,id')
          .all(id) as Row[]
      ).map((row) => this.run(row.id)),
      sources: (
        this.db
          .prepare('SELECT id FROM sources WHERE chat_id=? ORDER BY created_at,id')
          .all(id) as Row[]
      ).map((row) => this.source(row.id)),
      jobs: (
        this.db
          .prepare('SELECT id FROM jobs WHERE chat_id=? ORDER BY created_at,id')
          .all(id) as Row[]
      )
        .map((row) => this.job(row.id))
        .filter((job) => {
          const source = this.source(job.sourceRevision);
          if (job.sourceHash !== source.hash) return false;
          if (job.kind !== 'translation') return true;
          if (latestTranslation(this, source.id)?.id !== job.id) return false;
          if (job.status === 'completed') {
            try {
              validateTranslationArtifact(this, job, source);
            } catch {
              return false;
            }
          }
          return true;
        }),
      profile: this.product.profile(id),
      branches: this.product.branches(id),
      attempts: this.product.attempts(id),
      assets: mergedReaderAssets(this, id),
    };
  }
}
