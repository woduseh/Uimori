import {
  HttpError,
  archiveId,
  archiveList,
  archiveVersionBody,
  boolean,
  choice,
  fields,
  number,
  parse,
  record,
  text,
} from './request-validation.js';
import { resolveModelPricing, validatePricingSnapshot } from '../core/model-pricing.js';
import { estimateCost } from '../core/pricing-estimate.js';
import { translationPolicy } from '../core/translation-settings.js';
import {
  defaultPromptWorkspace,
  emptyModelRoutes,
  promptWorkspace,
  chatPromptWorkspace,
  freezeCurrentPrompts,
  validateCurrentPrompt,
  validatePromptWorkspace,
  validateCombinationOwner,
} from './prompt-workspace.js';
import { combinationOwner } from '../core/prompt-combinations.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  isVertexFileReference,
  validVertexFileReference,
  validCredentialEnv,
} from '../core/credential-reference.js';
import { validateEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isSourceOnlyTranscript } from '../core/authored-history.js';
import type { Store } from './store.js';
export { fields, number, record, text } from './request-validation.js';
import {
  defaultProfile,
  workspaceModelRef,
  PROVIDER_PROTOCOLS,
  VERTEX_GEMINI_DEFAULT_TIMEOUT_MS,
  type Content,
  type ContentRef,
  type ModelRef,
  type ModelSnapshot,
  type PromptPreset,
  type ChatProfile,
  type ProfileSnapshot,
  type Connection,
  type ModelPreset,
  type Library,
  type Branch,
  type Asset,
  type Attempt,
} from '../core/product.js';
import type { RunSnapshot, Resource } from '../core/types.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { validateDisplayAnnotation, validatePresentation } from '../core/auxiliary.js';
import { validateTranslationArtifact } from './source-editing.js';
import { storyTables } from './story-store.js';
import {
  catalogTimestamp,
  connectionEndpoint,
  isProviderSetting,
  modelOptionKeys,
  modelPricing,
  validateModelGeneration,
  validateModelSnapshot,
  validateProviderSettingVersion,
} from './provider-archive.js';
import {
  ILLUSTRATION_TABLES,
  illustrationSettings,
  validateIllustrationSettings,
} from './illustrations.js';
import { defaultIllustrationSettings } from '../core/illustration.js';
import { validateIllustrationArchive } from './illustration-archive.js';
import { OUTLINE_TABLES, validateOutlineArchive } from './outline-store.js';
import { normalizeStoryArchiveRow, validateStoryArchive } from './story-archive.js';

import {
  validatePromptProgram,
  validateChatPromptControls,
  resolvePromptValues,
  resolveEditablePromptValues,
  validateEditablePromptProgram,
  reconcilePromptValues,
} from '../core/prompt-program.js';
import { validateRunSnapshot } from './snapshot-archive.js';
import { validatePackageRequests } from './package-requests.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import { assertModelSelection } from './provider-selection.js';
import { measureMainContext } from './context-planning.js';
import { CONTEXT_TABLES } from './context-store.js';
import { editDraftTables, validateEditDraftArchive } from './edit-drafts.js';
import {
  chatOverrideTables,
  freezeChatOverrides,
  validateChatOverrideArchive,
  validateChatOverrideSnapshot,
} from './chat-overrides.js';
import { projectChatPackageCompilation } from '../core/chat-overrides.js';
import {
  chatOptionTables,
  validateChatOptionArchive,
  validateChatOptionSnapshot,
} from './chat-options.js';
import { HELPER_TABLES } from './helper-workspace.js';
import { normalizeHelperArchiveRow, validateHelperArchive } from './helper-archive.js';
import {
  normalizeResponseStreamArchiveRow,
  validateResponseStreamArchive,
} from './response-stream.js';
import { organizationTables } from './chat-organization.js';
import { libraryOrganizationTables } from './library-organization.js';
import {
  validateContentPackage,
  validatePackageAttachment,
  type PackageAttachment,
  packageControlKey,
} from '../core/content-package.js';
import { compilePackageAttachment } from '../core/package-runtime.js';
import {
  packageBehaviorTables,
  validatePackageBehaviorArchive,
  validatePackageBehaviorRunSnapshot,
} from './package-behavior-archive.js';
import { branchPackageStates } from './package-behavior-host.js';
import {
  assertPackageReferences,
  resolvePackageModules,
  resolvePackageProfile,
} from './package-features.js';
import {
  decodeImage,
  validateImageBlob,
  validateImageCatalog,
  imageCatalog,
  imageTargetSource,
} from './package-images.js';
import { validateArchivedPackageStart } from './package-start.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';
import { validateArchivedLoreContext } from './lore-context-archive.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const ref = (v: unknown): ContentRef => {
  const b = record(v);
  fields(b, ['id', 'revision']);
  return { id: text(b.id, 'reference', 100), revision: number(b.revision, 'revision') };
};
export const modelRef = (v: unknown): ModelRef => {
  const b = record(v);
  fields(b, ['id']);
  return { id: text(b.id, 'model', 100) };
};
function validatePinnedProfile(value: unknown): NonNullable<ChatProfile['pinned']> {
  const pinned = record(value);
  fields(pinned, ['mainPromptPresetId', 'mainModel']);
  return {
    ...(pinned.mainPromptPresetId !== undefined
      ? { mainPromptPresetId: text(pinned.mainPromptPresetId, 'pinned main prompt', 100) }
      : {}),
    ...(pinned.mainModel !== undefined ? { mainModel: modelRef(pinned.mainModel) } : {}),
  };
}

export class ProductStore {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.db;
  }
  /** Joins Store's single transaction for a new, empty database. */
  initFresh() {
    this.db.exec(`
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
      `);
    this.db.prepare('INSERT INTO prompt_workspace VALUES(1,?)').run(json(defaultPromptWorkspace()));
  }
  all(kind: string): any[] {
    return (
      this.db
        .prepare(
          isProviderSetting(kind)
            ? 'SELECT body FROM provider_settings v WHERE kind=? AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY id'
            : 'SELECT v.body FROM versions v WHERE kind=? AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id) AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY id'
        )
        .all(kind) as Row[]
    ).map((r) => parse(r.body));
  }
  libraryMetadata(): {
    contents: Pick<Content, 'id' | 'revision' | 'title' | 'kind'>[];
    prompts: Pick<PromptPreset, 'id' | 'revision' | 'title' | 'role'>[];
  } {
    // Keep large package bodies and prompt programs inside SQLite for metadata-only reads.
    const statement = this.db.prepare(`
      SELECT json_extract(v.body,'$.id') AS id,
        json_extract(v.body,'$.revision') AS revision,
        json_extract(v.body,'$.title') AS title,
        json_extract(v.body,'$.kind') AS kind,
        json_extract(v.body,'$.role') AS role
      FROM versions v WHERE v.kind=?
        AND v.revision=(SELECT MAX(n.revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id)
        AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)
      ORDER BY v.id
    `);
    return {
      contents: (statement.all('content') as Row[]).map(({ id, revision, title, kind }) => ({
        id,
        revision,
        title,
        kind,
      })),
      prompts: (statement.all('prompt-preset') as Row[]).map(({ id, revision, title, role }) => ({
        id,
        revision,
        title,
        role,
      })),
    };
  }
  searchLibrary(value: unknown) {
    const body = record(value);
    fields(body, ['query', 'kind', 'offset', 'limit']);
    const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en');
    const terms = fold(text(body.query, 'library query', 200, true))
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const kind =
      body.kind === undefined
        ? undefined
        : choice(body.kind, ['content', 'prompt-preset'], 'library kind');
    const offset =
      body.offset === undefined
        ? 0
        : number(body.offset, 'library offset', 0, Number.MAX_SAFE_INTEGER);
    const limit = body.limit === undefined ? 20 : number(body.limit, 'library limit', 1, 50);
    const metadata = this.libraryMetadata();
    const found = [
      ...metadata.contents.map(({ kind, ...item }) => ({
        ...item,
        kind: 'content' as const,
        category: kind,
      })),
      ...metadata.prompts.map(({ role, ...item }) => ({
        ...item,
        kind: 'prompt-preset' as const,
        category: role,
      })),
    ].filter((item) => {
      if (kind !== undefined && item.kind !== kind) return false;
      const searchable = fold(`${item.title} ${item.id} ${item.category}`);
      return terms.every((term) => searchable.includes(term));
    });
    const items = found.slice(offset, offset + limit);
    return {
      items,
      total: found.length,
      offset,
      nextOffset: offset + items.length < found.length ? offset + items.length : null,
    };
  }
  isHidden(kind: string, id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM library_hidden WHERE kind=? AND id=?').get(kind, id);
  }
  assertAvailable(kind: string, id: string) {
    if (this.isHidden(kind, id)) throw new HttpError(404, 'Library item deleted');
  }
  get<T>(kind: string, id: string, revision?: number): T {
    if (isProviderSetting(kind)) {
      const row = this.db
        .prepare('SELECT revision,body FROM provider_settings WHERE kind=? AND id=?')
        .get(kind, id) as Row | undefined;
      if (!row || (revision !== undefined && revision !== row.revision))
        throw new HttpError(404, 'Setting not found');
      return parse(row.body);
    }
    const r = (
      revision === undefined
        ? this.db
            .prepare(
              'SELECT body FROM versions WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1'
            )
            .get(kind, id)
        : this.db
            .prepare('SELECT body FROM versions WHERE kind=? AND id=? AND revision=?')
            .get(kind, id, revision)
    ) as Row | undefined;
    if (!r) throw new HttpError(404, `${kind} revision not found`);
    return parse(r.body);
  }
  save(kind: string, value: Row, id?: string, expected?: number) {
    return this.store.transaction(() => this.saveInTransaction(kind, value, id, expected));
  }
  /** Caller owns the transaction. */
  saveInTransaction(kind: string, value: Row, id?: string, expected?: number) {
    if (id) this.assertAvailable(kind, id);
    const prior = id ? this.get<Row & ContentRef>(kind, id) : null;
    if (prior && prior.revision !== expected) throw new HttpError(409, 'Revision conflict');
    if (prior && (kind === 'content' || kind === 'prompt-preset')) {
      const profiles = (this.db.prepare('SELECT body FROM profiles').all() as Row[]).map(
        (row) => parse(row.body) as ChatProfile
      );
      if (
        kind === 'content' &&
        !!prior.package !== !!value.package &&
        (profiles.some((p) =>
          [...p.attachments, ...(p.packageAttachments ?? [])].some((r) => r.id === id)
        ) ||
          this.all('content').some((content: Content) =>
            content.package?.modules?.some((r) => r.id === id)
          ))
      )
        throw new HttpError(409, 'Referenced content must keep its package structure');
    }
    const result: Row & ContentRef = {
      ...value,
      id: id ?? randomUUID(),
      revision: (prior?.revision ?? 0) + 1,
    };
    if (kind === 'content' && result.package)
      result.package = validateContentPackage({
        ...result.package,
        id: result.id,
        revision: result.revision,
        title: result.title,
        description: result.description,
        body: result.text,
      });
    if (kind === 'content' && result.package) assertPackageReferences(this, result.package);
    if (isProviderSetting(kind))
      this.db
        .prepare(
          'INSERT INTO provider_settings VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body'
        )
        .run(kind, result.id, result.revision, json(result));
    else
      this.db
        .prepare('INSERT INTO versions VALUES(?,?,?,?)')
        .run(kind, result.id, result.revision, json(result));
    if (kind === 'content' && result.package)
      resolvePackageModules(this, [{ id: result.id, revision: result.revision, role: 'module' }], {
        latest: true,
      });
    if (!prior) this.store.libraryOrganization.register(kind, result.id, result.kind);
    if (kind === 'content' || kind === 'prompt-preset')
      for (const chat of this.store.chats()) this.store.event(chat.id, 'profile.updated', chat.id);
    return result;
  }
  content(value: unknown, id?: string, inTransaction = false) {
    const b = record(value);
    fields(b, [
      'kind',
      'title',
      'description',
      'text',
      'loading',
      'relatedIds',
      'expectedRevision',
      'package',
    ]);
    if (!Array.isArray(b.relatedIds) || b.relatedIds.length > 100)
      throw new HttpError(400, 'Invalid related IDs');
    if (
      id &&
      b.kind !== 'bot' &&
      !b.package &&
      this.db.prepare('SELECT 1 FROM chat_organization WHERE bot_id=? LIMIT 1').get(id)
    )
      throw new HttpError(400, 'A chat owner must remain available as a bot or package');
    return (inTransaction ? this.saveInTransaction : this.save).call(
      this,
      'content',
      {
        kind: choice(b.kind, ['bot', 'persona', 'module'], 'content kind'),
        title: text(b.title, 'title', 200),
        description: text(b.description, 'description', b.package ? 4000 : 2000, true),
        text: text(b.text, 'text', b.package ? 1_000_000 : 100000, !!b.package),
        loading: choice(b.loading, ['pinned', 'discoverable'], 'loading'),
        relatedIds: [...new Set(b.relatedIds.map((x: unknown) => text(x, 'related ID', 100)))],
        ...(b.package !== undefined ? { package: validateContentPackage(b.package) } : {}),
      },
      id,
      id ? number(b.expectedRevision, 'revision') : undefined
    );
  }
  promptCombination(value: unknown) {
    const b = record(value);
    fields(b, ['title', 'role', 'values', 'owner', 'expectedRevision', 'workspaceRevision']);
    const role = choice(b.role, ['main', 'translation'], 'prompt role');
    return this.store.transaction(() => {
      const workspace = promptWorkspace(this.store);
      const current = workspace[role];
      const fromWorkspace = Object.hasOwn(b, 'workspaceRevision');
      if (fromWorkspace && (Object.hasOwn(b, 'owner') || Object.hasOwn(b, 'expectedRevision')))
        throw new HttpError(400, 'Choose one prompt combination source');
      const owner = fromWorkspace
        ? combinationOwner(current, role)
        : validateCombinationOwner(b.owner);
      let program = current.program;
      if (fromWorkspace || owner.kind === 'workspace') {
        if (owner.kind === 'workspace' && owner.role !== role)
          throw new HttpError(400, 'Prompt role mismatch');
        if (!fromWorkspace && current.presetId)
          throw new HttpError(400, 'Current prompt belongs to a preset');
        if (
          workspace.revision !==
          number(
            fromWorkspace ? b.workspaceRevision : b.expectedRevision,
            'prompt workspace revision'
          )
        )
          throw new HttpError(409, 'Current prompts changed; refresh before saving');
      } else {
        this.assertAvailable('prompt-preset', owner.id);
        const preset = this.get<PromptPreset>('prompt-preset', owner.id);
        if (preset.role !== role) throw new HttpError(400, 'Prompt role mismatch');
        if (preset.revision !== number(b.expectedRevision, 'prompt revision'))
          throw new HttpError(409, 'Prompt preset changed; refresh before saving');
        program = preset.program;
      }
      const values = resolveEditablePromptValues(program, record(b.values));
      return this.saveInTransaction('prompt-combination', {
        title: text(b.title, 'title', 200),
        role,
        values,
        owner,
        controls: structuredClone(program.controls),
      });
    });
  }
  promptPreset(value: unknown, id?: string, inTransaction = false) {
    const b = record(value);
    fields(b, ['title', 'role', 'text', 'program', 'values', 'expectedRevision']);
    const role = choice(b.role, ['main', 'translation'], 'prompt role');
    const program =
      b.program !== undefined
        ? validateEditablePromptProgram(b.program)
        : validateEditablePromptProgram(
            createDefaultPromptProgram(text(b.text, 'prompt text', 200000, true), role)
          );
    if (program.collaboration) {
      if (role !== 'main') throw new HttpError(400, '협업은 작문 프롬프트에만 설정할 수 있어요.');
      const previous = id
        ? this.get<PromptPreset>('prompt-preset', id).program.collaboration
        : undefined;
      for (const agent of program.collaboration.agents) {
        if (agent.model) this.get<ModelPreset>('model', agent.model.id);
        assertModelSelection(
          this,
          agent.model,
          previous?.agents.find((item) => item.id === agent.id)?.model
        );
      }
    }
    return (inTransaction ? this.saveInTransaction : this.save).call(
      this,
      'prompt-preset',
      {
        title: text(b.title, 'title', 200),
        role,
        program,
        values: resolveEditablePromptValues(
          program,
          b.values === undefined ? {} : record(b.values)
        ),
      },
      id,
      id ? number(b.expectedRevision, 'revision') : undefined
    );
  }
  prepareConnection(value: unknown, id?: string) {
    const b = record(value);
    fields(b, [
      'title',
      'protocol',
      'endpoint',
      'credentialEnv',
      'catalogCredentialEnv',
      'enabled',
      'expectedRevision',
    ]);
    const protocol = choice(b.protocol, [...PROVIDER_PROTOCOLS], 'protocol');
    const endpoint = connectionEndpoint(b.endpoint, protocol);
    const catalogCredentialEnv =
      b.catalogCredentialEnv === undefined || b.catalogCredentialEnv === ''
        ? undefined
        : text(b.catalogCredentialEnv, 'catalog credential reference', 200);
    if (catalogCredentialEnv !== undefined) {
      if (protocol !== 'vertex-gemini-v1')
        throw new HttpError(400, 'Catalog credential applies to Gemini connections only');
      if (!validCredentialEnv(catalogCredentialEnv) || isVertexFileReference(catalogCredentialEnv))
        throw new HttpError(400, 'Invalid catalog credential reference');
    }
    if (protocol === 'codex-app-server-v1' && b.credentialEnv !== undefined)
      throw new HttpError(400, 'Codex uses official local login');
    const credentialEnv =
      b.credentialEnv === undefined || b.credentialEnv === ''
        ? undefined
        : text(b.credentialEnv, 'credential reference', 200);
    if (credentialEnv && !validCredentialEnv(credentialEnv))
      throw new HttpError(400, 'Invalid credential reference');
    if (
      credentialEnv &&
      isVertexFileReference(credentialEnv) &&
      (protocol !== 'vertex-gemini-v1' || !validVertexFileReference(credentialEnv))
    )
      throw new HttpError(400, 'Invalid service account reference');
    const prior = id ? this.get<Connection>('connection', id) : undefined;
    const expectedRevision = id ? number(b.expectedRevision, 'revision') : undefined;
    if (prior && prior.revision !== expectedRevision) throw new HttpError(409, 'Revision conflict');
    const sameAuthority =
      prior?.protocol === protocol &&
      prior.endpoint === endpoint &&
      prior.credentialEnv === credentialEnv;
    const prepared: Omit<Connection, 'id' | 'revision'> = {
      title: text(b.title, 'title', 200),
      protocol,
      endpoint,
      ...(credentialEnv ? { credentialEnv } : {}),
      ...(catalogCredentialEnv ? { catalogCredentialEnv } : {}),
      enabled: boolean(b.enabled),
      catalog: sameAuthority ? structuredClone(prior.catalog) : [],
      catalogError: sameAuthority ? prior.catalogError : null,
      catalogUpdatedAt: sameAuthority ? (prior.catalogUpdatedAt ?? null) : null,
    };
    return { value: prepared, expectedRevision };
  }
  connection(value: unknown, id?: string) {
    const prepared = this.prepareConnection(value, id);
    return this.save('connection', prepared.value, id, prepared.expectedRevision);
  }
  prepareModel(value: unknown, id?: string, validationConnection?: Connection) {
    const b = record(value);
    fields(b, [
      'title',
      'connectionId',
      'modelId',
      'maxOutputTokens',
      'temperature',
      ...modelOptionKeys,
      'enabled',
      'pricing',
      'expectedRevision',
    ]);
    const expectedRevision = id ? number(b.expectedRevision, 'revision') : undefined;
    if (id && this.get<ModelPreset>('model', id).revision !== expectedRevision)
      throw new HttpError(409, 'Revision conflict');
    const connectionId = text(b.connectionId, 'connection ID', 100);
    if (validationConnection && validationConnection.id !== connectionId)
      throw new HttpError(400, 'Validation connection mismatch');
    const connection = validationConnection ?? this.get<Connection>('connection', connectionId);
    const modelId = text(b.modelId, 'model ID', 300);
    validateModelGeneration(b, connection.protocol);
    const vertex = connection.protocol === 'vertex-gemini-v1';
    const prepared: Omit<ModelPreset, 'id' | 'revision'> = {
      title: text(b.title, 'title', 200),
      connectionId,
      modelId,
      ...generationFromModel(b as ModelPreset),
      capabilityProtocol: connection.protocol,
      ...(b.inputTokenLimit !== undefined ? { inputTokenLimit: b.inputTokenLimit } : {}),
      ...(vertex || b.timeoutMs !== undefined
        ? { timeoutMs: b.timeoutMs ?? VERTEX_GEMINI_DEFAULT_TIMEOUT_MS }
        : {}),
      ...(b.evaluationTools !== undefined
        ? { evaluationTools: validateEvaluationToolOptions(b.evaluationTools) }
        : {}),
      ...(b.contextTools === true ? { contextTools: true } : {}),
      ...(b.enabled !== undefined ? { enabled: boolean(b.enabled) } : {}),
      ...(b.pricing !== undefined ? { pricing: modelPricing(b.pricing) } : {}),
      source: {
        kind: connection.catalog.some((item) => item.id === modelId) ? 'catalog' : 'manual',
        catalogUpdatedAt: connection.catalogUpdatedAt ?? null,
      },
    };
    return { value: prepared, expectedRevision };
  }
  model(value: unknown, id?: string) {
    const prepared = this.prepareModel(value, id);
    return this.save('model', prepared.value, id, prepared.expectedRevision);
  }
  modelSnapshot(id: string, role?: string, authorize = true): ModelSnapshot {
    try {
      this.assertAvailable('model', id);
      // New executions use the current contract; stored settings and historical snapshots stay intact.
      const { capabilityRevision: _retiredRevision, ...model } = this.get<
        ModelPreset & { capabilityRevision?: unknown }
      >('model', id);
      if (authorize && model.enabled === false) throw new HttpError(403, 'Model disabled');
      this.assertAvailable('connection', model.connectionId);
      const connection = this.get<Connection>('connection', model.connectionId);
      if (authorize) this.authorize(connection);
      if (
        authorize &&
        model.capabilityProtocol !== undefined &&
        model.capabilityProtocol !== connection.protocol
      )
        throw new HttpError(400, 'Connection protocol changed; review and save the model settings');
      if (authorize) validateModelGeneration(model, connection.protocol);
      const pricingSnapshot = resolveModelPricing(model, connection);
      return structuredClone({
        ...model,
        connection,
        ...(pricingSnapshot ? { pricingSnapshot } : {}),
      });
    } catch (error) {
      if (role && error instanceof HttpError)
        throw new HttpError(error.statusCode, `MODEL_UNAVAILABLE:${role}:${error.message}`);
      throw error;
    }
  }
  profile(chatId: string): ChatProfile {
    this.store.chat(chatId);
    const r = this.db.prepare('SELECT body FROM profiles WHERE chat_id=?').get(chatId) as
      | Row
      | undefined;
    return currentProfile(this, r ? parse(r.body) : defaultProfile(chatId));
  }
  updateProfile(chatId: string, value: unknown): ChatProfile {
    const b = record(value);
    fields(b, [
      'expectedRevision',
      'attachments',
      'image',
      'imageTranslation',
      'packageAttachments',
      'packageValues',
      'loreContext',
      'pinned',
    ]);
    if (!Array.isArray(b.attachments) || b.attachments.length > 300)
      throw new HttpError(400, 'Invalid attachments');
    const attachments = b.attachments.map((r) => currentRef(this, 'content', ref(r)));
    if (new Set(attachments.map((r) => r.id)).size !== attachments.length)
      throw new HttpError(400, 'Duplicate attachment');
    for (const r of attachments) this.get('content', r.id, r.revision);
    const image = boolean(b.image);
    let requestedLore: ReturnType<typeof validateLoreContextPolicy> | undefined;
    try {
      requestedLore =
        b.loreContext === undefined ? undefined : validateLoreContextPolicy(b.loreContext);
    } catch {
      throw new HttpError(400, 'Invalid lore context policy');
    }
    return this.store.transaction(() => {
      const prior = this.profile(chatId);
      if (prior.revision !== number(b.expectedRevision, 'profile revision'))
        throw new HttpError(409, 'Profile revision conflict');
      const pinned = b.pinned === undefined ? prior.pinned : validatePinnedProfile(b.pinned);
      if (
        pinned?.mainPromptPresetId &&
        pinned.mainPromptPresetId !== prior.pinned?.mainPromptPresetId
      ) {
        this.assertAvailable('prompt-preset', pinned.mainPromptPresetId);
        const preset = this.get<PromptPreset>('prompt-preset', pinned.mainPromptPresetId);
        if (preset.role !== 'main')
          throw new HttpError(400, '이 채팅에는 작문 프롬프트만 고정할 수 있어요.');
      }
      if (pinned?.mainModel?.id !== prior.pinned?.mainModel?.id)
        assertModelSelection(this, pinned?.mainModel ?? null);
      const packageAttachments =
        b.packageAttachments === undefined
          ? prior.packageAttachments
          : packageRefs(this, b.packageAttachments).map((r) => ({
              ...r,
              ...currentRef(this, 'content', r),
            }));
      validateAttachmentRoles(this, attachments, packageAttachments);
      const resolvedPackages = resolvePackageModules(this, packageAttachments ?? [], {
        latest: true,
      });
      const allowedPackageKeys = new Set(resolvedPackages.attachments.map(packageControlKey));
      const inheritedPackageValues =
        prior.packageValues === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(prior.packageValues).filter(([key]) => allowedPackageKeys.has(key))
            );
      const requestedPackageValues =
        b.packageValues === undefined ? inheritedPackageValues : b.packageValues;
      const packageValues =
        requestedPackageValues === undefined
          ? undefined
          : currentPackageValues(this, resolvedPackages.attachments, requestedPackageValues).values;
      this.store.organization.assertBotAttachments(chatId, attachments, packageAttachments);
      const result: ChatProfile = {
        ...((requestedLore ?? prior.loreContext)
          ? { loreContext: requestedLore ?? prior.loreContext }
          : {}),
        chatId,
        revision: prior.revision + 1,
        ...(pinned && Object.keys(pinned).length ? { pinned } : {}),
        attachments,
        routes: {
          ...promptWorkspace(this.store).modelRoutes,
          ...(pinned?.mainModel ? { main: structuredClone(pinned.mainModel) } : {}),
        },
        image,
        imageTranslation:
          b.imageTranslation === undefined
            ? (prior.imageTranslation ?? true)
            : boolean(b.imageTranslation),
        ...(packageAttachments !== undefined ? { packageAttachments } : {}),
        ...(packageValues !== undefined ? { packageValues } : {}),
      };
      freezeSourceSegments({
        ...result,
        contents: [],
        models: {},
        packageAttachments: resolvedPackages.attachments,
        packages: resolvedPackages.packages,
      });
      this.db
        .prepare(
          'INSERT INTO profiles VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET body=excluded.body'
        )
        .run(
          chatId,
          json(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'routes')))
        );
      this.store.event(chatId, 'profile.updated', chatId);
      return result;
    });
  }
  snapshot(
    chatId: string,
    requiredRole: 'main' | 'translation' | 'image' | 'inspect' = 'main',
    headRevision: string | null = this.store.chat(chatId).headRevision
  ): ProfileSnapshot {
    const { optionAdjustments: _notices, ...p } = this.profile(chatId);
    const contents = p.attachments.map((r) => this.get<Content>('content', r.id, r.revision));
    // Auxiliary jobs keep their global prompt; an unavailable main pin must not prevent translation.
    const workspace =
      requiredRole === 'main' || requiredRole === 'inspect'
        ? chatPromptWorkspace(this.store, p.pinned)
        : chatPromptWorkspace(this.store, { mainModel: p.pinned?.mainModel });
    const models: ProfileSnapshot['models'] = {};
    const routes = { ...p.routes };
    for (const role of ['main', 'translation', 'status', 'image'] as const) {
      const r = workspaceModelRef(workspace, role);
      if (!r) continue;
      try {
        models[role] = this.modelSnapshot(r.id, role, requiredRole !== 'inspect');
      } catch (error) {
        if (role === requiredRole) throw error;
        routes[role] = null;
      }
    }
    const frozen = freezeCurrentPrompts(workspace);
    const contextRef = workspaceModelRef(workspace, 'context');
    const contextModel = contextRef
      ? this.modelSnapshot(contextRef.id, undefined, false)
      : undefined;
    const collaboration = frozen.promptPresets?.main?.program.collaboration;
    const collaborationModels: Record<string, ModelSnapshot> = {};
    if (collaboration?.enabled && (requiredRole === 'main' || requiredRole === 'inspect'))
      for (const agent of collaboration.agents) {
        const model = agent.model
          ? this.modelSnapshot(agent.model.id, undefined, requiredRole !== 'inspect')
          : models.main;
        if (!model) throw new HttpError(400, '협업을 사용하려면 작문 모델을 선택해 주세요.');
        collaborationModels[agent.id] = structuredClone(model);
      }
    const profile: ProfileSnapshot = {
      ...p,
      routes,
      contents,
      models,
      ...resolvePackageProfile(this, p),
      ...frozen,
      ...(contextModel ? { contextModel } : {}),
      ...(collaboration?.enabled && (requiredRole === 'main' || requiredRole === 'inspect')
        ? { collaborationModels }
        : {}),
    };
    const overrides = freezeChatOverrides(
      this.store,
      profile,
      p.packageAttachments ?? [],
      headRevision
    );
    if (overrides) profile.chatOverrides = overrides;
    return structuredClone(profile);
  }
  resolveJobPrompt(snapshot: RunSnapshot, input: unknown): RunSnapshot {
    const resolved = structuredClone(snapshot);
    for (const role of ['translation', 'status', 'image'] as const) {
      const key = `${role}ModelSelection`;
      if (
        input &&
        typeof input === 'object' &&
        Object.hasOwn(input, `${role}ModelSnapshot`) &&
        !Object.hasOwn(input, key)
      )
        throw new HttpError(400, `${role} model snapshot requires selection`);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, key))
        continue;
      const selected = record(input)[key];
      resolved.profile ??= { ...defaultProfile(resolved.chatId), contents: [], models: {} };
      if (selected === null) {
        if (record(input)[`${role}ModelSnapshot`] != null)
          throw new HttpError(400, `${role} model snapshot requires selection`);
        delete resolved.profile.models[role];
        resolved.profile.routes[role] = null;
      } else {
        const reference = modelRef(selected);
        const model = validateModelSnapshot(record(input)[`${role}ModelSnapshot`]);
        if (model.id !== reference.id) throw new HttpError(400, `${role} model snapshot mismatch`);
        resolved.profile.models[role] = model;
        resolved.profile.routes[role] = reference;
      }
    }
    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.hasOwn(input, 'translationPrompt')
    ) {
      const data = record(input);
      const current = validateCurrentPrompt(data.translationPrompt, 'translation');
      const revision = number(data.promptWorkspaceRevision, 'prompt workspace revision');
      const preset = {
        ...current,
        id: 'current-translation',
        revision,
        role: 'translation' as const,
      };
      resolved.profile ??= { ...defaultProfile(resolved.chatId), contents: [], models: {} };
      resolved.profile.prompts = {
        ...resolved.profile.prompts,
        translation: { id: preset.id, revision },
      };
      resolved.profile.promptPresets = { ...resolved.profile.promptPresets, translation: preset };
      resolved.profile.promptControls = {
        ...resolved.profile.promptControls,
        [`${preset.id}@${revision}`]: { values: current.values, combinations: [] },
      };
      if (data.translationPolicy) {
        const policy = translationPolicy(data.translationPolicy);
        if (policy.refusalModel) validateModelSnapshot(policy.refusalModel);
        resolved.settings.maxCalls = policy.maxCalls;
      }
    }
    return resolved;
  }
  resources(chatId: string, p: ProfileSnapshot): Resource[] {
    return [
      ...p.contents
        .filter((c) => c.kind === 'module')
        .map((c) => ({
          ...c,
          chatId,
          kind: 'lore' as const,
          sourceKind: c.kind,
        })),
      ...(p.packageAttachments ?? []).flatMap((ref) => {
        const pkg = p.packages!.find(
          (item) => item.id === ref.id && item.revision === ref.revision
        )!;
        const compiled = compilePackageAttachment(pkg, ref, {
          chatId,
          target: 'main',
          resourcesOnly: true,
          values: p.packageValues?.[packageControlKey(ref)],
        });
        return projectChatPackageCompilation(p, ref, pkg, compiled).compiled.resources;
      }),
    ];
  }
  authorize(connection: Connection) {
    const current = this.get<Connection>('connection', connection.id);
    if (
      !current.enabled ||
      current.endpoint !== connection.endpoint ||
      current.protocol !== connection.protocol ||
      current.credentialEnv !== connection.credentialEnv
    )
      throw new HttpError(403, 'Connection disabled or authority changed');
    return structuredClone(connection);
  }
  branches(chatId: string): Branch[] {
    return (
      this.db
        .prepare('SELECT * FROM branches WHERE chat_id=? ORDER BY is_default DESC,id')
        .all(chatId) as Row[]
    ).map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      title: r.title,
      headRevision: r.head_revision,
      revision: r.revision,
      default: !!r.is_default,
    }));
  }
  branch(chatId: string, id = `main:${chatId}`): Branch {
    const b = this.branches(chatId).find((x) => x.id === id);
    if (!b) throw new HttpError(404, 'Branch not found');
    return b;
  }
  createBranch(chatId: string, value: unknown) {
    const b = record(value);
    fields(b, ['title', 'fromRevision']);
    const title = text(b.title, 'title', 200);
    const head = b.fromRevision === null ? null : text(b.fromRevision, 'source revision', 100);
    if (head && this.store.source(head).chatId !== chatId)
      throw new HttpError(400, 'Source outside chat');
    this.store.chat(chatId);
    this.db.exec('SAVEPOINT create_branch');
    try {
      const id = randomUUID();
      this.db.prepare('INSERT INTO branches VALUES(?,?,?,?,1,0)').run(id, chatId, title, head);
      branchPackageStates(this.store, chatId, id, head);
      this.store.event(chatId, 'branch.created', id);
      this.db.exec('RELEASE create_branch');
      return this.branch(chatId, id);
    } catch (error) {
      this.db.exec('ROLLBACK TO create_branch; RELEASE create_branch');
      throw error;
    }
  }
  startAttempt(
    chatId: string | null,
    runId: string | null,
    jobId: string | null,
    request: WireRecord
  ) {
    const id = randomUUID();
    const safe = structuredClone(request);
    if (
      safe.body &&
      typeof safe.body === 'object' &&
      !Array.isArray(safe.body) &&
      'opaqueState' in safe.body
    )
      safe.body.opaqueState = '[provider continuation withheld]';
    this.db
      .prepare(
        "INSERT INTO attempts(id,chat_id,run_id,job_id,role,connection_id,model_id,status,request) VALUES(?,?,?,?,?,?,?,'running',?)"
      )
      .run(
        id,
        chatId,
        runId,
        jobId,
        request.role,
        request.connectionId,
        request.modelId,
        json(safe)
      );
    return id;
  }
  finishAttempt(id: string, result: ProviderResult) {
    const row = this.db.prepare('SELECT request FROM attempts WHERE id=?').get(id) as
      | Row
      | undefined;
    const request = row ? parse(row.request) : null;
    const estimatedCost = estimateCost(
      request?.pricingSnapshot,
      result.usage,
      request?.pricingStartedAt ?? '',
      typeof result.usage.raw === 'object' &&
        result.usage.raw !== null &&
        !Array.isArray(result.usage.raw)
        ? typeof result.usage.raw.service_tier === 'string'
          ? result.usage.raw.service_tier
          : undefined
        : undefined
    );
    const safe = {
      ...structuredClone(result),
      estimatedCost,
      opaqueState: result.opaqueState === null ? null : '[provider continuation withheld]',
    };
    this.db
      .prepare(
        "UPDATE attempts SET status=?,response=?,input_tokens=?,output_tokens=?,cost_usd=?,raw_usage=?,price_revision=?,error=? WHERE id=? AND status='running'"
      )
      .run(
        result.status,
        json(safe),
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.costUsd,
        json(result.usage.raw),
        result.usage.priceRevision,
        result.error?.code ?? null,
        id
      );
  }
  mockAttempt(
    chatId: string,
    runId: string | null,
    jobId: string | null,
    role: string,
    input: unknown
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO attempts(id,chat_id,run_id,job_id,role,connection_id,model_id,status,request) VALUES(?,?,?,?,?,'local-scripted','deterministic-fixture','mock',?)"
      )
      .run(id, chatId, runId, jobId, role, json({ mock: true, input }));
    return id;
  }
  attempts(chatId: string): Attempt[] {
    return (
      this.db.prepare('SELECT * FROM attempts WHERE chat_id=? ORDER BY rowid').all(chatId) as Row[]
    ).map((r) => ({
      id: r.id,
      runId: r.run_id,
      jobId: r.job_id,
      storyJobId: r.story_job_id ?? null,
      role: r.role,
      connectionId: r.connection_id,
      modelId: r.model_id,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      estimatedCost: parse(r.response)?.estimatedCost,
      pricingSnapshot: parse(r.request)?.pricingSnapshot,
      pricingStartedAt: parse(r.request)?.pricingStartedAt,
      rawUsage: parse(r.raw_usage),
      priceRevision: r.price_revision,
      error: r.error,
      request: parse(r.request),
      response: parse(r.response),
    }));
  }
  assets(chatId?: string, includeHidden = false): Asset[] {
    const visible = includeHidden
      ? ''
      : " AND NOT EXISTS (SELECT 1 FROM library_hidden WHERE kind='asset' AND id=assets.id)";
    return (
      (chatId
        ? this.db.prepare(`SELECT body FROM assets WHERE chat_id=?${visible}`).all(chatId)
        : this.db.prepare(`SELECT body FROM assets WHERE 1=1${visible}`).all()) as Row[]
    ).map((r) => parse(r.body));
  }
  asset(id: string) {
    const r = this.db.prepare('SELECT body,bytes FROM assets WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!r) throw new HttpError(404, 'Asset not found');
    return { asset: parse(r.body) as Asset, bytes: Buffer.from(r.bytes) };
  }
  createAsset(chatId: string, value: unknown) {
    this.store.chat(chatId);
    const b = record(value);
    fields(b, [
      'title',
      'mime',
      'base64',
      'description',
      'actor',
      'outfit',
      'location',
      'allowedUse',
    ]);
    const { mime, bytes } = decodeImage(b.mime, b.base64);
    const id = randomUUID();
    const result: Asset = {
      id,
      chatId,
      revision: 1,
      title: text(b.title, 'title', 200),
      mime,
      hash: createHash('sha256').update(bytes).digest('hex'),
      description: text(b.description, 'description', 2000, true),
      actor: text(b.actor, 'actor', 200, true),
      outfit: text(b.outfit, 'outfit', 200, true),
      location: text(b.location, 'location', 200, true),
      allowedUse: choice(b.allowedUse, ['profile', 'inline', 'both'], 'asset use'),
      url: `/api/assets/${id}`,
    };
    this.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(id, chatId, json(result), bytes);
    return result;
  }
  library(summary = false): Library {
    // Project inside SQLite so large bodies never cross into JS for list requests.
    const contents = summary
      ? (
          this.db
            .prepare(
              "SELECT json_set(json_remove(v.body,'$.package'),'$.text','') AS body, json_type(v.body,'$.package') AS packaged, (SELECT image.value FROM json_each(v.body,'$.package.images') image WHERE json_extract(image.value,'$.id')=json_extract(v.body,'$.package.portraitImageId') LIMIT 1) AS portrait FROM versions v WHERE kind='content' AND revision=(SELECT MAX(revision) FROM versions n WHERE n.kind=v.kind AND n.id=v.id) AND NOT EXISTS(SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id) ORDER BY id"
            )
            .all() as Row[]
        ).map((r) => ({
          ...parse(r.body),
          ...(r.packaged ? { hasPackage: true } : {}),
          ...(r.portrait
            ? {
                coverImage: {
                  url: `/api/package-image-blobs/${parse(r.portrait).blobHash}`,
                  title: parse(r.portrait).title,
                },
              }
            : {}),
        }))
      : this.all('content');
    return {
      ...(summary ? { contentBodiesOmitted: true, assetsOmitted: true } : {}),
      organization: this.store.libraryOrganization.snapshot(),
      promptPresets: this.all('prompt-preset'),
      promptCombinations: this.all('prompt-combination'),
      contents,
      connections: this.all('connection'),
      models: this.all('model'),
      assets: summary ? [] : this.assets(),
    };
  }
  export() {
    const tables = Object.fromEntries(
      archiveTables.map((t) => [
        t,
        (this.db.prepare(`SELECT * FROM ${t}`).all() as Row[]).map((r) =>
          t === 'assets' || t === 'illustration_images'
            ? { ...r, bytes: Buffer.from(r.bytes).toString('base64') }
            : r
        ),
      ])
    );
    return {
      format: 'narrative-archive',
      version: 15,
      createdAt: new Date().toISOString(),
      tables,
    };
  }
  backup(): Buffer {
    const path = `${this.store.path}.backup-${randomUUID()}.sqlite`;
    if (existsSync(path)) throw new Error('Backup destination exists');
    try {
      this.db.prepare('VACUUM INTO ?').run(path);
      return readFileSync(path);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  }
  importStatus() {
    const { revision: _currentRevision, ...current } = promptWorkspace(this.store);
    const { revision: _defaultRevision, ...defaults } = defaultPromptWorkspace();
    return {
      canImport:
        isDeepStrictEqual(current, defaults) &&
        !archiveTables.some(
          (table) =>
            ![
              'package_behavior_entropy',
              'library_organization_state',
              'prompt_workspace',
              'illustration_settings',
            ].includes(table) && this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
        ),
    };
  }
  import(value: unknown) {
    // Validation and normalization must never mutate the caller's archive, even
    // when a later row fails and the database transaction rolls back.
    let copy: unknown;
    try {
      copy = structuredClone(value);
    } catch {
      throw new HttpError(400, 'Invalid archive');
    }
    const a = record(copy);
    fields(a, ['format', 'version', 'createdAt', 'tables']);
    if (a.format !== 'narrative-archive' || a.version !== 15)
      throw new HttpError(400, 'Unsupported archive');
    const tables = record(a.tables);
    // Illustration and outline tables were added to schema 15 later; older archives restore normally.
    for (const table of [...ILLUSTRATION_TABLES, ...OUTLINE_TABLES]) tables[table] ??= [];
    fields(tables, archiveTables);
    if (archiveTables.some((t) => !Array.isArray(tables[t]) || tables[t].length > 100000))
      throw new HttpError(400, 'Missing or oversized archive table');
    if (tables.illustration_settings.length > 1)
      throw new HttpError(400, 'Archive requires at most one illustration settings row');
    if (tables.prompt_workspace.length !== 1)
      throw new HttpError(400, 'Archive requires exactly one prompt workspace');
    try {
      this.store.transaction(() => {
        if (!this.importStatus().canImport)
          throw new HttpError(409, 'Restore requires an empty database');
        this.db.exec('PRAGMA defer_foreign_keys=ON');
        this.db.exec(
          'DELETE FROM package_behavior_entropy; DELETE FROM library_organization_state; DELETE FROM prompt_workspace; DELETE FROM illustration_settings'
        );
        for (const table of archiveTables) {
          const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(
            (r) => r.name as string
          );
          for (const entry of tables[table]) {
            const row = record(entry);
            fields(row, columns);
            if (columns.some((k) => !(k in row)))
              throw new HttpError(400, 'Missing archive column');
            if (
              Object.values(row).some(
                (v) =>
                  v !== null &&
                  ((typeof v !== 'string' && typeof v !== 'number') ||
                    (typeof v === 'number' && !Number.isFinite(v)))
              )
            )
              throw new HttpError(400, 'Invalid archive column');
            if (table === 'versions') {
              validateArchiveVersion(row);
            }
            if (table === 'provider_settings') {
              if (!isProviderSetting(row.kind))
                throw new HttpError(400, 'Invalid provider setting kind');
              validateArchiveVersion(row, true);
              if (row.kind === 'connection') {
                const body = record(parse(row.body));
                delete body.credentialEnv;
                body.enabled = false;
                row.body = json(body);
              }
            }
            if (table === 'prompt_workspace') {
              if (row.id !== 1) throw new HttpError(400, 'Invalid prompt workspace row');
              validatePromptWorkspace(parse(row.body));
            }
            if (table === 'assets') validateArchiveAsset(row);
            if (table === 'illustration_settings') {
              if (row.id !== 1) throw new HttpError(400, 'Invalid illustration settings row');
              const body = record(parse(row.body));
              const { revision, ...rest } = body;
              row.body = json(
                validateIllustrationSettings(rest, {
                  revision: number(revision, 'illustration settings revision'),
                  testMode: true,
                })
              );
              const restored = parse(row.body);
              restored.automatic = false;
              restored.generator = 'none';
              restored.comfyui.authorizationEnv = '';
              row.body = json(restored);
            }
            if (table === 'illustration_images') {
              archiveId(row.id);
              archiveId(row.job_id);
              archiveId(row.chat_id);
              const bytes = Buffer.from(text(row.bytes, 'illustration bytes', 24e6), 'base64');
              if (createHash('sha256').update(bytes).digest('hex') !== row.hash)
                throw new HttpError(400, 'Illustration image hash mismatch');
              record(parse(row.body));
            }
            if (table === 'illustration_jobs') {
              archiveId(row.id);
              archiveId(row.chat_id);
              archiveId(row.source_revision);
              if (['queued', 'running'].includes(row.status)) {
                row.status = 'interrupted';
                row.owner = null;
                row.error = 'ILLUSTRATION_INTERRUPTED';
              }
              const input = record(parse(row.input));
              for (const snapshot of [
                record(input.codex ?? {}).model,
                record(input.comfyui ?? {}).promptModel,
              ]) {
                if (!snapshot) continue;
                validateModelSnapshot(snapshot);
                const connection = record(record(snapshot).connection);
                delete connection.credentialEnv;
                connection.enabled = false;
              }
              if (input.comfyui) {
                input.comfyui.authorizationEnv = '';
                input.comfyui.disabled = true;
              }
              row.input = json(input);
            }
            if (table === 'runs') {
              const snapshot = record(parse(row.snapshot));
              for (const group of [snapshot.profile?.models, snapshot.profile?.collaborationModels])
                if (group)
                  for (const model of Object.values(record(group))) {
                    const connection = record(record(model).connection);
                    delete connection.credentialEnv;
                    connection.enabled = false;
                  }
              row.snapshot = json(snapshot);
            }
            if (table === 'runs' && ['queued', 'running'].includes(row.status)) {
              row.status = 'interrupted';
              row.error = 'Restored unfinished run; explicit retry required';
            }
            if (table === 'jobs' && ['queued', 'running'].includes(row.status)) {
              row.status = 'interrupted';
              row.owner = null;
              row.error = 'Restored unfinished job; explicit retry required';
            }
            if (table === 'jobs' && row.input) {
              const input = parse(row.input);
              if (input && typeof input === 'object' && !Array.isArray(input)) {
                for (const key of ['translationModelSnapshot', 'statusModelSnapshot']) {
                  if (!input[key]) continue;
                  const connection = record(input[key].connection);
                  delete connection.credentialEnv;
                  connection.enabled = false;
                }
                if (input.translationPolicy?.refusalModel) {
                  const connection = record(input.translationPolicy.refusalModel.connection);
                  delete connection.credentialEnv;
                  connection.enabled = false;
                }
                row.input = json(input);
              }
            }
            if (table === 'attempts' && row.status === 'running') {
              row.status = 'interrupted';
              row.error = 'Restored uncertain request';
            }
            if (table === 'attempts') {
              const request = record(parse(row.request));
              if (request.body && typeof request.body === 'object' && 'opaqueState' in request.body)
                request.body.opaqueState = '[provider continuation withheld]';
              row.request = json(scrubArchiveSecrets(request));
              if (row.response !== null) {
                const response = record(parse(row.response));
                if (response.opaqueState !== undefined && response.opaqueState !== null)
                  response.opaqueState = '[provider continuation withheld]';
                row.response = json(scrubArchiveSecrets(response));
              }
              if (row.raw_usage !== null)
                row.raw_usage = json(scrubArchiveSecrets(parse(row.raw_usage)));
            }
            normalizeStoryArchiveRow(table, row);
            normalizeHelperArchiveRow(table, row);
            normalizeResponseStreamArchiveRow(table, row);
            this.db
              .prepare(
                `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`
              )
              .run(
                ...columns.map((k) =>
                  table === 'assets' && k === 'bytes'
                    ? Buffer.from(text(row[k], 'asset bytes', 3e6), 'base64')
                    : table === 'illustration_images' && k === 'bytes'
                      ? Buffer.from(text(row[k], 'illustration bytes', 24e6), 'base64')
                      : row[k]
                )
              );
          }
        }
        if (!tables.illustration_settings.length)
          this.db
            .prepare('INSERT INTO illustration_settings(id,body) VALUES(1,?)')
            .run(json(defaultIllustrationSettings()));
        illustrationSettings(this.store);
        if (this.db.prepare('PRAGMA foreign_key_check').all().length)
          throw new HttpError(400, 'Archive references invalid');
        validateArchiveGraph(this);
        const validateStorySnapshot = validateStoryArchive(this.store);
        this.store.context.validateArchive();
        validateEditDraftArchive(this.store);
        validateHelperArchive(this.store, validateStorySnapshot);
        validateResponseStreamArchive(this.store);
        validateChatOverrideArchive(this.store);
        validateChatOptionArchive(this.store);
        validatePackageRequests(this.store);
        validatePackageBehaviorArchive(this.store);
        validateOutlineArchive(this.store);
        this.store.organization.validateArchive();
        this.store.libraryOrganization.validateArchive();
      });
    } catch (error) {
      if (error instanceof HttpError && [400, 409].includes(error.statusCode)) throw error;
      throw new HttpError(400, 'Archive data or references invalid');
    }
    return { restored: true, chats: this.store.chats().length };
  }
}
const archiveTables = [
  'chats',
  'versions',
  'provider_settings',
  'profiles',
  'branches',
  'runs',
  'sources',
  'source_edits',
  'jobs',
  'job_results',
  'model_inputs',
  'tool_events',
  'events',
  'prompt_workspace',
  'library_hidden',
  'attempts',
  'assets',
  ...storyTables,
  ...CONTEXT_TABLES,
  ...editDraftTables,
  ...chatOverrideTables,
  ...chatOptionTables,
  ...HELPER_TABLES,
  'response_stream_tasks',
  'response_stream_chunks',
  'package_requests',
  ...organizationTables,
  ...libraryOrganizationTables,
  ...packageBehaviorTables,
  ...ILLUSTRATION_TABLES,
  ...OUTLINE_TABLES,
];

function currentRef(product: ProductStore, kind: string, reference: ContentRef): ContentRef {
  const current = product.get<ContentRef>(kind, reference.id);
  return { id: current.id, revision: current.revision };
}
function currentPackageValues(
  product: ProductStore,
  attachments: PackageAttachment[],
  raw: unknown,
  inherited = false
) {
  const values: NonNullable<ChatProfile['packageValues']> = {};
  const notices: string[] = [];
  for (const [key, saved] of Object.entries(record(raw)).sort(
    ([a], [b]) => Number(a.split('@')[1]?.split(':')[0]) - Number(b.split('@')[1]?.split(':')[0])
  )) {
    const match = /^([^@]+)@([1-9][0-9]*):(bot|persona|module)$/u.exec(key);
    if (!match) throw new HttpError(400, 'Invalid package control key');
    const current = attachments.find((r) => r.id === match[1] && r.role === match[3]);
    if (!current) {
      if (inherited) continue;
      throw new HttpError(400, 'Package controls outside attachment scope');
    }
    const original = { ...current, revision: Number(match[2]) };
    packageControlValues(product, [original], { [key]: saved });
    const pkg = product.get<Content>('content', current.id, current.revision).package!;
    const adjusted = reconcilePromptValues(
      { version: 1, controls: pkg.controls, blocks: [] },
      record(saved)
    );
    values[packageControlKey(current)] = adjusted.values;
    if (adjusted.resetKeys.length) notices.push(`${pkg.title}: ${adjusted.resetKeys.join(', ')}`);
  }
  return { values, notices };
}
/** Pure current-settings projection. Frozen Run/source profiles never pass through this path. */
function currentProfile(product: ProductStore, saved: ChatProfile): ChatProfile {
  // Ignore the retired setting without rewriting persisted profiles or historical snapshots.
  const { personaReference: _historicalScope, ...current } = saved as ChatProfile & {
    personaReference?: boolean;
  };
  const result = {
    ...current,
    imageTranslation: current.imageTranslation ?? true,
    routes: {
      ...structuredClone(promptWorkspace(product.store).modelRoutes),
      ...(saved.pinned?.mainModel ? { main: structuredClone(saved.pinned.mainModel) } : {}),
    },
    attachments: saved.attachments.map((r) => currentRef(product, 'content', r)),
  };
  const notices: string[] = [];
  if (saved.packageAttachments)
    result.packageAttachments = saved.packageAttachments.map((r) => ({
      ...r,
      ...currentRef(product, 'content', r),
    }));
  if (saved.packageValues) {
    const resolved = resolvePackageModules(product, result.packageAttachments ?? [], {
      latest: true,
    });
    const adjusted = currentPackageValues(product, resolved.attachments, saved.packageValues, true);
    result.packageValues = adjusted.values;
    notices.push(...adjusted.notices);
  }
  if (notices.length) result.optionAdjustments = notices;
  return result;
}
function packageRefs(product: ProductStore, value: unknown): PackageAttachment[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new HttpError(400, 'Invalid package attachments');
  const refs = value.map(validatePackageAttachment);
  if (
    new Set(refs.map((r) => `${r.id}:${r.role}`)).size !== refs.length ||
    refs.filter((r) => r.role === 'bot').length > 1 ||
    refs.filter((r) => r.role === 'persona').length > 1
  )
    throw new HttpError(400, 'Duplicate package or primary role');
  for (const r of refs)
    if (!product.get<Content>('content', r.id, r.revision).package)
      throw new HttpError(400, 'Content is not a package');
  return refs;
}
function packageControlValues(
  product: ProductStore,
  attachments: PackageAttachment[],
  value: unknown
) {
  const b = record(value);
  const allowed = new Map(attachments.map((r) => [packageControlKey(r), r]));
  return Object.fromEntries(
    Object.entries(b).map(([key, values]) => {
      const r = allowed.get(key);
      if (!r) throw new HttpError(400, 'Package controls outside attachment scope');
      const pkg = product.get<Content>('content', r.id, r.revision).package!;
      return [
        key,
        resolvePromptValues({ version: 1, controls: pkg.controls, blocks: [] }, record(values)),
      ];
    })
  );
}
function validateAttachmentRoles(
  product: ProductStore,
  attachments: ContentRef[],
  packages: PackageAttachment[] | undefined
) {
  if (packages?.some((r) => attachments.some((a) => a.id === r.id)))
    throw new HttpError(400, 'Package is also attached as legacy content');
  if (attachments.some((r) => product.get<Content>('content', r.id, r.revision).package))
    throw new HttpError(400, 'Package requires an explicit attachment role');
  // Preserve historical multi-content profiles; new primary package roles cannot coexist
  // with a second legacy primary role that would make the selected persona/bot ambiguous.
  for (const role of ['bot', 'persona'] as const)
    if (
      packages?.some((r) => r.role === role) &&
      attachments.some((r) => product.get<Content>('content', r.id, r.revision).kind === role)
    )
      throw new HttpError(400, 'Duplicate legacy and package primary role');
}

function scrubArchiveSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubArchiveSecrets);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(key)
          ? '[REDACTED]'
          : scrubArchiveSecrets(item),
      ])
    );
  return value;
}
function archiveSettings(value: unknown) {
  const b = record(value);
  fields(b, ['preset', 'mode', 'translation', 'status', 'maxCalls']);
  choice(b.preset, ['calm', 'vivid'], 'preset');
  choice(b.mode, ['direct', 'research'], 'mode');
  boolean(b.translation);
  boolean(b.status);
  number(b.maxCalls, 'call limit', 1, 32);
}
function validateArchiveVersion(row: Row, providerSetting = false) {
  if (isProviderSetting(row.kind)) {
    if (!providerSetting)
      throw new HttpError(400, 'Provider settings do not have archived revisions');
    validateProviderSettingVersion(row);
    return;
  }
  const body = archiveVersionBody(row);
  if (row.kind === 'package-image') {
    validateImageBlob(body);
    return;
  }
  text(body.title, 'title', 200);
  if (row.kind === 'content') {
    fields(body, [
      'id',
      'revision',
      'kind',
      'title',
      'description',
      'text',
      'loading',
      'relatedIds',
      'package',
    ]);
    choice(body.kind, ['bot', 'persona', 'module'], 'content kind');
    text(body.description, 'description', body.package ? 4000 : 2000, true);
    text(body.text, 'content text', body.package ? 1_000_000 : 100000, !!body.package);
    choice(body.loading, ['pinned', 'discoverable'], 'loading');
    archiveList(body.relatedIds, 100).forEach(archiveId);
    if (body.package !== undefined) {
      const pkg = validateContentPackage(body.package);
      if (
        pkg.id !== body.id ||
        pkg.revision !== body.revision ||
        pkg.title !== body.title ||
        pkg.description !== body.description ||
        pkg.body !== body.text
      )
        throw new HttpError(400, 'Package identity mismatch');
    }
  } else if (row.kind === 'prompt-preset') {
    fields(body, ['id', 'revision', 'title', 'role', 'program', 'values']);
    choice(body.role, ['main', 'translation'], 'prompt role');
    const program = validatePromptProgram(body.program);
    resolvePromptValues(program, body.values === undefined ? {} : record(body.values));
    if (program.collaboration && body.role !== 'main')
      throw new HttpError(400, 'Collaboration requires the main prompt role');
  } else if (row.kind === 'prompt-combination') {
    fields(body, ['id', 'revision', 'title', 'role', 'values', 'owner', 'controls']);
    choice(body.role, ['main', 'translation'], 'prompt role');
    validateChatPromptControls({ values: body.values, combinations: [] });
    if (body.owner !== undefined || body.controls !== undefined) {
      const owner = validateCombinationOwner(body.owner);
      if (owner.kind === 'workspace' && owner.role !== body.role)
        throw new HttpError(400, 'Prompt role mismatch');
      const program = validatePromptProgram({
        ...createDefaultPromptProgram(''),
        controls: body.controls,
      });
      resolvePromptValues(program, record(body.values));
    }
  } else throw new HttpError(400, 'Invalid archive version kind');
}
/** Execution snapshots are self-contained evidence, independent of later setting edits. */
function validateArchiveAsset(row: Row) {
  const body = record(parse(row.body));
  fields(body, [
    'id',
    'chatId',
    'revision',
    'title',
    'mime',
    'hash',
    'description',
    'actor',
    'outfit',
    'location',
    'allowedUse',
    'url',
  ]);
  archiveId(row.id);
  archiveId(row.chat_id);
  if (body.id !== row.id || body.chatId !== row.chat_id)
    throw new HttpError(400, 'Asset identity mismatch');
  number(body.revision, 'asset revision');
  text(body.title, 'asset title', 200);
  text(body.description, 'asset description', 2000, true);
  for (const key of ['actor', 'outfit', 'location']) text(body[key], key, 200, true);
  choice(body.allowedUse, ['profile', 'inline', 'both'], 'asset use');
  const { bytes } = decodeImage(body.mime, row.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== body.hash)
    throw new HttpError(400, 'Asset hash mismatch');
  body.url = `/api/assets/${encodeURIComponent(row.id)}`;
  row.body = json(body);
}
function validateArchiveProfile(
  product: ProductStore,
  value: unknown,
  chatId: string,
  frozen = false
): ProfileSnapshot | ChatProfile {
  const p = record(value);
  fields(p, [
    'chatId',
    'revision',
    'attachments',
    'personaReference',
    'routes',
    'image',
    'imageTranslation',
    'packageAttachments',
    'packageValues',
    'loreContext',
    'pinned',
    ...(frozen
      ? [
          'contents',
          'models',
          'promptPresets',
          'prompts',
          'promptControls',
          'promptWorkspaceRevision',
          'packages',
          'collaborationModels',
          'contextModel',
          'chatOverrides',
          'chatOptions',
          'promptOptionOwner',
        ]
      : []),
  ]);
  if (p.pinned !== undefined) {
    const pinned = validatePinnedProfile(p.pinned);
    // Frozen profiles carry their own execution evidence and never resolve live selections.
    if (!frozen) {
      if (pinned.mainPromptPresetId)
        product.get<PromptPreset>('prompt-preset', pinned.mainPromptPresetId);
      if (pinned.mainModel) product.get<ModelPreset>('model', pinned.mainModel.id);
    }
  }
  if (p.loreContext !== undefined) validateLoreContextPolicy(p.loreContext);
  if (p.chatId !== chatId) throw new HttpError(400, 'Profile chat mismatch');
  number(p.revision, 'profile revision');
  if (p.personaReference !== undefined) boolean(p.personaReference);
  boolean(p.image);
  if (p.imageTranslation !== undefined) boolean(p.imageTranslation);
  const attachments = archiveList(p.attachments).map(ref);
  if (new Set(attachments.map((r) => r.id)).size !== attachments.length)
    throw new HttpError(400, 'Duplicate attachment');
  const contents = attachments.map((r) => product.get<Content>('content', r.id, r.revision));
  const routes = record(!frozen && !Object.hasOwn(p, 'routes') ? emptyModelRoutes() : p.routes);
  fields(routes, ['main', 'translation', 'status', 'image']);
  const models: ProfileSnapshot['models'] = {};
  if (frozen) fields(record(p.models), ['main', 'translation', 'status', 'image']);
  for (const role of ['main', 'translation', 'status', 'image'] as const) {
    if (routes[role] === null) {
      if (frozen && p.models[role] !== undefined)
        throw new HttpError(400, 'Unexpected frozen model');
      continue;
    }
    const r = modelRef(routes[role]);
    if (frozen) {
      const model = validateModelSnapshot(p.models[role]);
      if (model.id !== r.id) throw new HttpError(400, 'Frozen model selection mismatch');
      models[role] = model;
    } else product.get<ModelPreset>('model', r.id);
  }
  const promptPresets = frozen ? (p.promptPresets as ProfileSnapshot['promptPresets']) : undefined;
  if (frozen && promptPresets) {
    fields(record(promptPresets), ['main', 'translation']);
    const allowedKeys: string[] = [];
    for (const role of ['main', 'translation'] as const) {
      const preset = promptPresets[role];
      if (!preset) continue;
      const program = validatePromptProgram(preset.program);
      if (preset.role !== role) throw new HttpError(400, 'Frozen prompt role mismatch');
      number(preset.revision, 'prompt revision');
      text(preset.id, 'prompt ID', 100);
      const key = `${preset.id}@${preset.revision}`;
      allowedKeys.push(key);
      if (
        p.prompts?.[role] &&
        !isDeepStrictEqual(p.prompts[role], { id: preset.id, revision: preset.revision })
      )
        throw new HttpError(400, 'Frozen prompt selection mismatch');
      const controls = p.promptControls?.[key];
      if (controls) {
        const checked = validateChatPromptControls(controls);
        resolvePromptValues(program, checked.values);
        for (const combination of checked.combinations)
          resolvePromptValues(program, combination.values);
      }
    }
    if (p.promptControls) fields(record(p.promptControls), allowedKeys);
    if (p.promptWorkspaceRevision !== undefined)
      number(p.promptWorkspaceRevision, 'prompt workspace revision');
  }
  if (frozen) {
    if (p.contextModel !== undefined) validateModelSnapshot(p.contextModel);
    const collaboration = promptPresets?.main?.program.collaboration;
    if (collaboration?.enabled) {
      const agentModels = record(p.collaborationModels);
      fields(
        agentModels,
        collaboration.agents.map((agent) => agent.id)
      );
      for (const agent of collaboration.agents) {
        const model = validateModelSnapshot(agentModels[agent.id]);
        if (agent.model ? model.id !== agent.model.id : !isDeepStrictEqual(model, models.main))
          throw new HttpError(400, 'Frozen collaboration model mismatch');
      }
    } else if (p.collaborationModels !== undefined)
      throw new HttpError(400, 'Unexpected collaboration models');
  }
  const packageAttachments =
    p.packageAttachments === undefined ? undefined : packageRefs(product, p.packageAttachments);
  const resolvedPackages = resolvePackageModules(
    product,
    packageAttachments ?? [],
    frozen ? { frozen: packageAttachments ?? [] } : { latest: true }
  );
  if (p.packageValues !== undefined) {
    if (frozen) packageControlValues(product, resolvedPackages.attachments, p.packageValues);
    else {
      // An unsaved live profile can still contain options for its previous dependency graph.
      const previous = resolvePackageModules(product, packageAttachments ?? []);
      currentPackageValues(
        product,
        [...resolvedPackages.attachments, ...previous.attachments],
        p.packageValues
      );
    }
  }
  validateAttachmentRoles(product, attachments, packageAttachments);
  const packages = packageAttachments === undefined ? undefined : resolvedPackages.packages;
  if (
    frozen &&
    packageAttachments !== undefined &&
    !isDeepStrictEqual(packageAttachments, resolvedPackages.attachments)
  )
    throw new HttpError(400, 'Frozen module dependency mismatch');
  if (frozen && !isDeepStrictEqual(p.packages, packages))
    throw new HttpError(400, 'Frozen package revision mismatch');
  if (frozen && !isDeepStrictEqual(p.promptPresets, promptPresets))
    throw new HttpError(400, 'Frozen prompt revision mismatch');
  if (frozen && (!isDeepStrictEqual(p.contents, contents) || !isDeepStrictEqual(p.models, models)))
    throw new HttpError(400, 'Frozen profile revision mismatch');
  if (frozen) validateChatOverrideSnapshot(product.store, p as ProfileSnapshot);
  if (frozen) validateChatOptionSnapshot(p as ProfileSnapshot);
  return p as ProfileSnapshot | ChatProfile;
}
function validateArchiveGraph(product: ProductStore) {
  for (const preset of product.all('prompt-preset') as PromptPreset[])
    for (const agent of preset.program.collaboration?.agents ?? [])
      if (agent.model) product.get<ModelPreset>('model', agent.model.id);
  for (const row of product.db
    .prepare("SELECT body FROM versions WHERE kind='content'")
    .all() as Row[]) {
    const content = JSON.parse(row.body);
    if (content.package) assertPackageReferences(product, content.package);
  }
  // Option presets were validated as independent role/value copies by validateArchiveVersion.
  const workspace = promptWorkspace(product.store);
  for (const selected of [
    ...Object.values(workspace.modelRoutes),
    workspace.titleModel,
    workspace.helperModel,
    workspace.contextModel,
    workspace.translationPolicy.refusalModel,
    ...(workspace.main.program.collaboration?.agents ?? []).map((agent) => agent.model),
  ])
    if (selected) product.get<ModelPreset>('model', selected.id);
  for (const hidden of product.db.prepare('SELECT kind,id FROM library_hidden').all() as Row[]) {
    const kind = choice(
      hidden.kind,
      ['content', 'prompt-preset', 'prompt-combination', 'connection', 'model', 'asset'],
      'hidden library kind'
    );
    const id = archiveId(hidden.id);
    if (kind === 'asset') {
      if (!product.db.prepare('SELECT 1 FROM assets WHERE id=?').get(id))
        throw new HttpError(400, 'Hidden asset missing');
    } else product.get(kind, id);
  }
  const db = product.db;
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const chats = new Map(rows('chats').map((row) => [archiveId(row.id), row]));
  const sources = new Map(rows('sources').map((row) => [archiveId(row.id), row]));
  const runs = new Map(rows('runs').map((row) => [archiveId(row.id), row]));
  const branches = new Map(rows('branches').map((row) => [archiveId(row.id), row]));
  const jobs = new Map(rows('jobs').map((row) => [archiveId(row.id), row]));
  const sameChat = (id: unknown, chat: string, collection: Map<string, Row>) => {
    if (id !== null && (typeof id !== 'string' || collection.get(id)?.chat_id !== chat))
      throw new HttpError(400, 'Archive cross-chat or missing reference');
  };
  const visited = new Set<string>();
  for (const source of sources.values()) {
    text(source.text, 'source', 2e6);
    if (createHash('sha256').update(source.text).digest('hex') !== source.hash)
      throw new HttpError(400, 'Source hash mismatch');
    sameChat(source.parent_revision, source.chat_id, sources);
    sameChat(source.run_id, source.chat_id, runs);
    const run = runs.get(source.run_id)!;
    if (
      run.source_revision !== source.id ||
      run.parent_revision !== source.parent_revision ||
      run.status !== 'completed'
    )
      throw new HttpError(400, 'Source run mismatch');
    const path = new Set<string>();
    let cursor: string | null = source.id;
    while (cursor && !visited.has(cursor)) {
      if (path.has(cursor)) throw new HttpError(400, 'Source ancestry cycle');
      path.add(cursor);
      cursor = sources.get(cursor)!.parent_revision;
    }
    for (const id of path) visited.add(id);
  }
  for (const source of sources.values()) {
    const edits = db
      .prepare('SELECT * FROM source_edits WHERE source_id=? ORDER BY revision')
      .all(source.id) as Row[];
    for (const [index, edit] of edits.entries()) {
      number(edit.revision, 'source edit revision');
      text(edit.text, 'source edit', 2e6);
      text(edit.created_at, 'edit timestamp', 100);
      if (
        edit.revision !== index + 1 ||
        createHash('sha256').update(edit.text).digest('hex') !== edit.hash
      )
        throw new HttpError(400, 'Invalid source edit history');
    }
  }
  for (const chat of chats.values()) {
    text(chat.title, 'chat title', 200);
    number(chat.settings_revision, 'settings revision');
    archiveSettings(parse(chat.settings));
    sameChat(chat.head_revision, chat.id, sources);
    const defaults = [...branches.values()].filter(
      (b) => b.chat_id === chat.id && b.is_default === 1
    );
    if (defaults.length !== 1 || defaults[0].head_revision !== chat.head_revision)
      throw new HttpError(400, 'Default branch mismatch');
  }
  for (const branch of branches.values()) {
    sameChat(branch.head_revision, branch.chat_id, sources);
    text(branch.title, 'branch title', 200);
    number(branch.revision, 'branch revision');
    if (![0, 1].includes(branch.is_default)) throw new HttpError(400, 'Invalid branch type');
  }
  for (const row of rows('provider_settings'))
    if (row.kind === 'model') {
      const model = record(parse(row.body));
      product.get<Connection>('connection', model.connectionId);
      validateModelGeneration(
        model,
        choice(model.capabilityProtocol, [...PROVIDER_PROTOCOLS], 'model protocol')
      );
    }
  for (const row of rows('profiles')) validateArchiveProfile(product, parse(row.body), row.chat_id);
  for (const run of runs.values()) {
    sameChat(run.parent_revision, run.chat_id, sources);
    sameChat(run.branch_id, run.chat_id, branches);
    sameChat(run.source_revision, run.chat_id, sources);
    choice(
      run.status,
      ['completed', 'failed', 'cancelled', 'interrupted', 'refused', 'partial'],
      'run status'
    );
    if ((run.status === 'completed') !== (run.source_revision !== null))
      throw new HttpError(400, 'Run completion mismatch');
    const snapshot = record(parse(run.snapshot));
    if (
      snapshot.chatId !== run.chat_id ||
      snapshot.parentRevision !== run.parent_revision ||
      snapshot.request !== run.request ||
      (snapshot.branchId !== undefined && snapshot.branchId !== run.branch_id)
    )
      throw new HttpError(400, 'Run snapshot identity mismatch');
    if (snapshot.forkedFrom !== undefined) {
      const origin = record(snapshot.forkedFrom);
      fields(origin, ['chatId', 'runId', 'sourceRevision']);
      archiveId(origin.chatId);
      archiveId(origin.runId);
      archiveId(origin.sourceRevision);
    }
    archiveSettings(snapshot.settings);
    number(snapshot.settingsRevision, 'snapshot settings revision');
    if (
      !isSourceOnlyTranscript(snapshot as RunSnapshot) &&
      !product.store.validateHistory(snapshot.history, run.parent_revision)
    )
      throw new HttpError(400, 'Snapshot history differs from source ancestry');
    const resources = archiveList(snapshot.resources, 10000);
    const ids = new Set<string>();
    for (const raw of resources) {
      const resource = record(raw);
      if (resource.chatId !== run.chat_id || ids.has(resource.id))
        throw new HttpError(400, 'Snapshot resource scope mismatch');
      ids.add(archiveId(resource.id));
      number(resource.revision, 'resource revision');
      choice(resource.kind, ['lore', 'skill'], 'resource kind');
      text(
        resource.text,
        'resource text',
        String(resource.id).startsWith('package:') ? 1_000_000 : 100000,
        String(resource.id).startsWith('package:')
      );
    }
    if (snapshot.executionPurpose !== undefined)
      throw new HttpError(400, 'Artifact snapshot cannot own a main Run');
    validateRunSnapshot(product.store, snapshot as RunSnapshot, run.id);
    const context = (snapshot as RunSnapshot).contextPlan;
    if (context?.status === 'ready') {
      if (
        measureMainContext(snapshot as RunSnapshot).estimatedInputTokens !==
        context.estimatedInputTokens
      )
        throw new HttpError(400, 'Context estimate mismatch');
      if (!snapshot.forkedFrom) {
        const summaries = db
          .prepare(
            "SELECT status,response FROM attempts WHERE run_id=? AND role='context' ORDER BY rowid"
          )
          .all(run.id) as Row[];
        if (summaries.length !== context.summaryCalls)
          throw new HttpError(400, 'Context attempt count mismatch');
        if (context.summaryCalls) {
          const last = summaries.at(-1)!;
          if (last.status !== 'completed' || parse(last.response)?.text.trim() !== context.summary)
            throw new HttpError(400, 'Context summary receipt mismatch');
        }
        product.store.context.assertSnapshot(snapshot as RunSnapshot);
      }
    }
    validatePackageBehaviorRunSnapshot(product.store, snapshot as RunSnapshot);
    if (snapshot.profile) {
      const profile = validateArchiveProfile(
        product,
        snapshot.profile,
        run.chat_id,
        true
      ) as ProfileSnapshot;
      validateChatOverrideSnapshot(product.store, profile, (snapshot as RunSnapshot).history);
      if (!isDeepStrictEqual(resources, product.resources(run.chat_id, profile)))
        throw new HttpError(400, 'Snapshot resource revision mismatch');
    }
    validateArchivedPackageStart(product.store, product.store.run(run.id), snapshot as RunSnapshot);
    validateArchivedLoreContext(product.store, snapshot as RunSnapshot);
  }
  for (const job of jobs.values()) {
    sameChat(job.source_revision, job.chat_id, sources);
    const source = product.store.sourceAtHash(job.source_revision, job.source_hash);
    const jobInput = parse(job.input);
    if (jobInput && typeof jobInput === 'object' && !Array.isArray(jobInput)) {
      for (const role of ['translation', 'status', 'image'] as const) {
        if (
          (Object.hasOwn(jobInput, `${role}ModelSelection`) ||
            Object.hasOwn(jobInput, `${role}ModelSnapshot`)) &&
          job.kind !== role
        )
          throw new HttpError(400, 'Auxiliary selection does not match job kind');
      }
      if ((jobInput.translationPrompt || jobInput.translationPolicy) && job.kind !== 'translation')
        throw new HttpError(400, 'Translation settings require translation job');
    }
    product.resolveJobPrompt(product.store.run(source.runId).snapshot, jobInput);
    if (jobInput?.translationImageSelection !== undefined) {
      if (job.kind !== 'translation')
        throw new HttpError(400, 'Automatic image settings require translation job');
      validateImageCatalog(product.store, job.chat_id, jobInput.translationImageSelection);
      if (
        jobInput.translationImageSelection.imageSelectionError !== undefined &&
        jobInput.translationImageSelection.imageSelectionError !== 'IMAGE_MODEL_UNAVAILABLE'
      )
        throw new HttpError(400, 'Invalid automatic image diagnostic');
      product.resolveJobPrompt(
        product.store.run(source.runId).snapshot,
        jobInput.translationImageSelection
      );
    }
    if (jobInput?.imageTarget !== undefined && job.kind !== 'image')
      throw new HttpError(400, 'Image target requires image job');
    if (job.kind === 'image' && job.status !== 'stale')
      validateImageCatalog(product.store, job.chat_id, jobInput);
    if (job.kind === 'image') imageTargetSource(product.store, product.store.job(job.id));
    if (job.source_hash !== source.hash) throw new HttpError(400, 'Job source hash mismatch');
    choice(job.kind, ['translation', 'status', 'image'], 'job kind');
    choice(
      job.status,
      ['completed', 'failed', 'partial', 'cancelled', 'interrupted', 'stale'],
      'job status'
    );
    number(job.generation, 'job generation', 0);
    number(job.revision, 'job revision');
    const resultRow = db.prepare('SELECT * FROM job_results WHERE job_id=?').get(job.id) as
      | Row
      | undefined;
    const result = resultRow ? record(parse(resultRow.result)) : null;
    if (
      result &&
      (result.sourceRevision !== source.id ||
        result.sourceHash !== source.hash ||
        typeof result.mock !== 'boolean' ||
        resultRow!.generation > job.generation)
    )
      throw new HttpError(400, 'Job result dependency mismatch');
    if (job.status === 'completed' && !result)
      throw new HttpError(400, 'Completed job result missing');
    if (result?.manual !== undefined && (job.kind !== 'translation' || result.manual !== true))
      throw new HttpError(400, 'Invalid authored marker');
    if (job.kind === 'translation' && job.status === 'completed')
      validateTranslationArtifact(product.store, product.store.job(job.id), source);
    if (result && job.kind === 'image') {
      if (!isDeepStrictEqual(result.imageTarget, jobInput?.imageTarget))
        throw new HttpError(400, 'Image result target mismatch');
      validateImageCatalog(product.store, job.chat_id, jobInput);
      const assets = imageCatalog(jobInput);
      const imageSource = imageTargetSource(product.store, product.store.job(job.id));
      const entries = archiveList(result.annotations, 4).map((raw) => {
        const entry = record(raw);
        fields(entry, [
          'blockAnchor',
          'assetRef',
          'assetRevision',
          'assetHash',
          'presentationIntent',
          'caption',
        ]);
        const { caption: _caption, ...annotation } = entry;
        return annotation;
      });
      validatePresentation(
        imageSource,
        { sourceRevision: imageSource.id, sourceHash: imageSource.hash, entries },
        assets
      );
    }
    if (result && job.kind === 'status' && result.display)
      validateDisplayAnnotation(source, {
        sourceRevision: source.id,
        sourceHash: source.hash,
        kind: 'display-only',
        entries: result.display,
      });
  }
  const illustrationOwners = validateIllustrationArchive(product.store);
  for (const attempt of rows('attempts')) {
    sameChat(attempt.run_id, attempt.chat_id, runs);
    sameChat(attempt.job_id, attempt.chat_id, jobs);
    const helperOwner = product.db
      .prepare('SELECT task_id FROM helper_task_attempts WHERE attempt_id=?')
      .get(attempt.id);
    const contextOwner = product.db
      .prepare('SELECT job_id FROM context_job_attempts WHERE attempt_id=?')
      .get(attempt.id);
    const illustrationOwner = illustrationOwners.get(attempt.id);
    const primaryOwners = [attempt.run_id, attempt.job_id, attempt.story_job_id].filter(
      (id) => id !== null
    ).length;
    if (
      primaryOwners +
        Number(!!helperOwner) +
        Number(!!contextOwner) +
        Number(!!illustrationOwner) !==
      1
    )
      throw new HttpError(400, 'Attempt target mismatch');
    if (
      illustrationOwner &&
      (attempt.role !== 'illustration' ||
        attempt.chat_id !== illustrationOwner.chatId ||
        attempt.connection_id !== illustrationOwner.connectionId ||
        attempt.model_id !== illustrationOwner.modelId)
    )
      throw new HttpError(400, 'Illustration attempt identity mismatch');
    if (attempt.story_job_id !== null) {
      const target = product.db
        .prepare('SELECT chat_id,kind,inputs FROM story_jobs WHERE id=?')
        .get(attempt.story_job_id) as Row | undefined;
      const compaction =
        attempt.role === 'context' &&
        parse(target?.inputs ?? '[]')?.some((input: Row) => input.contextPlan);
      if (
        !target ||
        target.chat_id !== attempt.chat_id ||
        (target.kind !== attempt.role && !compaction)
      )
        throw new HttpError(400, 'Story attempt target mismatch');
    }
    choice(
      attempt.role,
      [
        'main',
        'translation',
        'status',
        'image',
        'state',
        'context',
        'helper',
        'title',
        'illustration',
      ],
      'attempt role'
    );
    if (
      attempt.story_job_id === null &&
      !helperOwner &&
      !contextOwner &&
      !illustrationOwner &&
      (attempt.run_id !== null
        ? attempt.role !== 'main' &&
          attempt.role !== 'title' &&
          !(attempt.role === 'context' && parse(runs.get(attempt.run_id)!.snapshot).contextPlan)
        : jobs.get(attempt.job_id)?.kind !== attempt.role)
    )
      throw new HttpError(400, 'Attempt role mismatch');
    const request = record(parse(attempt.request));
    if (request.pricingSnapshot !== undefined) {
      const pricing = validatePricingSnapshot(request.pricingSnapshot);
      if (pricing.protocol !== request.protocol || pricing.modelId !== attempt.model_id)
        throw new HttpError(400, 'Attempt pricing identity mismatch');
      catalogTimestamp(request.pricingStartedAt);
      if (typeof request.pricingStartedAt !== 'string')
        throw new HttpError(400, 'Attempt pricing timestamp missing');
    }
    const response = parse(attempt.response);
    if (response?.estimatedCost !== undefined) {
      const calculated = estimateCost(
        request.pricingSnapshot,
        {
          inputTokens: attempt.input_tokens,
          outputTokens: attempt.output_tokens,
          raw: parse(attempt.raw_usage),
        },
        request.pricingStartedAt ?? ''
      );
      if (!isDeepStrictEqual(response.estimatedCost, calculated))
        throw new HttpError(400, 'Attempt cost estimate mismatch');
    }
    if (request.agentId !== undefined) {
      const snapshot =
        attempt.run_id === null
          ? undefined
          : (parse(runs.get(attempt.run_id)!.snapshot) as RunSnapshot);
      const config = snapshot?.profile?.promptPresets?.main?.program.collaboration;
      const agentId = text(request.agentId, 'advisor ID', 64);
      const model = snapshot?.profile?.collaborationModels?.[agentId];
      if (
        !config?.enabled ||
        !config.agents.some((agent) => agent.id === agentId) ||
        !model ||
        attempt.role !== 'main' ||
        request.modelId !== model.modelId ||
        request.connectionId !== model.connectionId
      )
        throw new HttpError(400, 'Advisor attempt attribution mismatch');
    }
    if (attempt.status === 'mock') {
      fields(request, ['mock', 'input']);
      const input = record(request.input);
      if (
        request.mock !== true ||
        attempt.connection_id !== 'local-scripted' ||
        attempt.model_id !== 'deterministic-fixture' ||
        input.role !== (attempt.role === 'image' ? 'presentation' : attempt.role) ||
        [attempt.input_tokens, attempt.output_tokens, attempt.cost_usd, attempt.raw_usage].some(
          (value) => value !== null
        )
      )
        throw new HttpError(400, 'Mock attempt identity mismatch');
    } else if (
      (request.protocol === 'codex-app-server-v1'
        ? request.method !== 'RPC' || request.url !== 'codex://local'
        : request.method !== 'POST') ||
      request.connectionId !== attempt.connection_id ||
      request.modelId !== attempt.model_id ||
      request.role !== attempt.role
    )
      throw new HttpError(400, 'Attempt identity mismatch');
  }
}
