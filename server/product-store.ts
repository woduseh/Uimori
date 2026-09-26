import { compareModelDisplayOrder } from '../core/model-order.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { encodedImage, storeImage } from './image-storage.js';
import { prepareConnection, saveConnection } from './provider-connections.js';
import { recordContentProfileEvents } from './content-profile-events.js';
import { detectRisuImageHandoff, type RisuImageHandoff } from '../core/risu-image-handoff.js';
import { assertRisuContentSource } from '../core/risu-native.js';
import { stripDeprecatedRisuPresetFields } from '../core/risu-deprecated-fields.js';
import { projectNativeRisuPackage } from './risu-native-projection.js';
import {
  HttpError,
  boolean,
  choice,
  fields,
  number,
  parse,
  record,
  text,
} from './request-validation.js';
import { resolveModelPricing } from '../core/model-pricing.js';
import { HOST_LIST_PAGE_DEFAULT, HOST_LIST_PAGE_MAX, pageSlice } from '../core/paging.js';
import { estimateCost } from '../core/pricing-estimate.js';
import { translationPolicy } from '../core/translation-settings.js';
import {
  defaultPromptWorkspace,
  promptWorkspace,
  chatPromptWorkspace,
  freezeCurrentPrompts,
  validateCurrentPrompt,
  validateCombinationOwner,
} from './prompt-workspace.js';
import { combinationOwner } from '../core/prompt-combinations.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { randomUUID, createHash } from 'node:crypto';
import { validateEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { Store } from './store.js';
export { fields, number, record, text } from './request-validation.js';
import {
  defaultProfile,
  workspaceModelRef,
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
import {
  isProviderSetting,
  modelOptionKeys,
  modelPricing,
  validateModelGeneration,
  validateModelSnapshot,
} from './provider-archive.js';

import {
  promptControls,
  resolveEditablePromptValues,
  validateEditableRisuPrompt,
} from '../core/risu-prompt.js';

import { assertModelSelection } from './provider-selection.js';

import { freezeChatOverrides } from './chat-overrides.js';
import { projectChatPackageCompilation } from '../core/chat-overrides.js';
import {
  assertRisuContent,
  validateRisuContent,
  validateContentAttachment,
  type ContentAttachment,
} from '../core/risu-content.js';
import { compileContentAttachment } from '../core/package-runtime.js';
import {
  assertPackageReferences,
  resolvePackageModules,
  resolvePackageProfile,
} from './package-features.js';
import { decodeImage } from './package-images.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';

type Row = Record<string, any>;
const json = JSON.stringify;
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
        CREATE TABLE versions (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE provider_settings (kind TEXT NOT NULL CHECK(kind IN ('connection','model')),id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE profiles (chat_id TEXT PRIMARY KEY REFERENCES chats(id),body TEXT NOT NULL);
        CREATE TABLE branches (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),title TEXT NOT NULL,head_revision TEXT REFERENCES sources(id),revision INTEGER NOT NULL,is_default INTEGER NOT NULL);
        CREATE UNIQUE INDEX default_branch ON branches(chat_id) WHERE is_default=1;
        CREATE TABLE prompt_workspace (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
        CREATE TABLE library_hidden (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE attempts (id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),run_id TEXT REFERENCES runs(id),job_id TEXT REFERENCES jobs(id),role TEXT NOT NULL,connection_id TEXT NOT NULL,model_id TEXT NOT NULL,status TEXT NOT NULL,request TEXT NOT NULL,response TEXT,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL,raw_usage TEXT,price_revision TEXT,error TEXT);
        CREATE TABLE assets (id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),body TEXT NOT NULL,hash TEXT NOT NULL REFERENCES image_blobs(hash));
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
    const limit =
      body.limit === undefined
        ? HOST_LIST_PAGE_DEFAULT
        : number(body.limit, 'library limit', 1, HOST_LIST_PAGE_MAX);
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
    const page = pageSlice(found, offset, limit);
    return { items: page.items, total: page.total, offset, nextOffset: page.nextOffset };
  }
  isHidden(kind: string, id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM library_hidden WHERE kind=? AND id=?').get(kind, id);
  }
  assertAvailable(kind: string, id: string) {
    if (this.isHidden(kind, id)) throw new HttpError(404, 'Library item deleted');
  }
  get<T>(kind: string, id: string, revision?: number): T {
    if (kind === 'package-image') return encodedImage(this.db, id) as T;
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
  saveInTransaction(kind: string, value: Row, id?: string, expected?: number, createId?: string) {
    // Server-owned import identities are never update IDs or accepted from ordinary edit bodies.
    if (
      createId &&
      (id ||
        this.db
          .prepare(
            'SELECT 1 FROM versions WHERE id=? UNION SELECT 1 FROM provider_settings WHERE id=? UNION SELECT 1 FROM library_hidden WHERE id=?'
          )
          .get(createId, createId, createId))
    )
      throw new HttpError(409, 'New library identity already exists');
    if (id) this.assertAvailable(kind, id);
    const prior = id ? this.get<Row & ContentRef>(kind, id) : null;
    if (prior && prior.revision !== expected) throw new HttpError(409, 'Revision conflict');
    const result: Row & ContentRef = {
      ...value,
      id: id ?? createId ?? randomUUID(),
      revision: (prior?.revision ?? 0) + 1,
    };
    if (kind === 'content' && result.package)
      result.package = validateRisuContent({
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
        .prepare(
          'INSERT INTO versions VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,body=excluded.body'
        )
        .run(kind, result.id, result.revision, json(result));
    if (kind === 'content' && result.package)
      resolvePackageModules(this, [{ id: result.id, revision: result.revision, role: 'module' }], {
        latest: true,
      });
    if (!prior) this.store.libraryOrganization.register(kind, result.id, result.kind);
    if (kind === 'content' || kind === 'prompt-preset')
      recordContentProfileEvents(this.db, kind, result.id);
    return result;
  }
  content(value: unknown, id?: string, inTransaction = false, createId?: string) {
    const b = { ...record(value) };
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
    const kind = choice(b.kind, ['bot', 'persona', 'module'], 'content kind');
    let packageInput = b.package;
    if (packageInput === undefined) {
      const card = {
        name: text(b.title, 'title', 200),
        description: text(b.text, 'text', SOURCE_TEXT_MAX_CHARS, true),
        creator_notes: text(b.description, 'description', 4000, true),
        first_mes: '',
        character_book: { entries: [] },
        extensions: { risuai: {} },
      };
      packageInput = {
        version: 2,
        id: createId ?? id ?? randomUUID(),
        revision: 1,
        title: card.name,
        description: card.creator_notes,
        body: card.description,
        lore: [],
        nativeRisu: {
          version: 1,
          card,
          assets: [],
          sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
        },
      };
    }
    if (packageInput && record(packageInput).nativeRisu) {
      const raw = record(packageInput);
      assertRisuContentSource(raw.nativeRisu);
      const native = raw.nativeRisu;
      const { imageHandoff: _old, ...rest } = raw;
      const handoff = detectRisuImageHandoff(
        native,
        raw.imageHandoff as RisuImageHandoff | undefined
      );
      packageInput = { ...rest, ...(handoff ? { imageHandoff: handoff } : {}) };
    }
    // Validate external input without copying it. Projection reads that input; the final
    // save validates and detaches the projected package after assigning its identity.
    assertRisuContent(packageInput);
    const pkg = projectNativeRisuPackage(packageInput, kind).pkg;
    return (inTransaction ? this.saveInTransaction : this.save).call(
      this,
      'content',
      {
        kind,
        title: text(pkg.title, 'title', 200),
        description: text(pkg.description, 'description', 4000, true),
        text: text(pkg.body ?? '', 'text', SOURCE_TEXT_MAX_CHARS, !!b.package),
        loading: choice(b.loading, ['pinned', 'discoverable'], 'loading'),
        relatedIds: [...new Set(b.relatedIds.map((x: unknown) => text(x, 'related ID', 100)))],
        package: pkg,
      },
      id,
      id ? number(b.expectedRevision, 'revision') : undefined,
      createId
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
        controls: promptControls(program),
      });
    });
  }
  promptPreset(value: unknown, id?: string, inTransaction = false, createId?: string) {
    const b = record(value);
    fields(b, ['title', 'role', 'text', 'program', 'values', 'expectedRevision']);
    const role = choice(b.role, ['main', 'translation'], 'prompt role');
    const program =
      b.program !== undefined
        ? validateEditableRisuPrompt(b.program)
        : validateEditableRisuPrompt(
            createDefaultRisuPrompt(text(b.text, 'prompt text', 200000, true), role)
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
      id ? number(b.expectedRevision, 'revision') : undefined,
      createId
    );
  }
  prepareConnection(value: unknown, id?: string) {
    return prepareConnection(this, value, id);
  }
  connection(value: unknown, id?: string) {
    return saveConnection(this, value, id);
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
      'displayOrder',
      'pricing',
      'expectedRevision',
    ]);
    const expectedRevision = id ? number(b.expectedRevision, 'revision') : undefined;
    const current = id ? this.get<ModelPreset>('model', id) : undefined;
    if (current && current.revision !== expectedRevision)
      throw new HttpError(409, 'Revision conflict');
    const displayOrder = current ? current.displayOrder : b.displayOrder;
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
      ...(b.executionMode !== undefined
        ? {
            executionMode: choice(
              b.executionMode,
              ['realtime', 'batch'],
              'execution mode'
            ) as NonNullable<ModelPreset['executionMode']>,
          }
        : {}),
      capabilityProtocol: connection.protocol,
      ...(b.inputTokenLimit !== undefined ? { inputTokenLimit: b.inputTokenLimit } : {}),
      ...(vertex || b.timeoutMs !== undefined
        ? { timeoutMs: b.timeoutMs ?? VERTEX_GEMINI_DEFAULT_TIMEOUT_MS }
        : {}),
      ...(b.evaluationTools !== undefined
        ? { evaluationTools: validateEvaluationToolOptions(b.evaluationTools) }
        : {}),
      ...(b.contextTools === true ? { contextTools: true } : {}),
      ...(b.providerOptions !== undefined
        ? { providerOptions: structuredClone(b.providerOptions) }
        : {}),
      ...(b.enabled !== undefined ? { enabled: boolean(b.enabled) } : {}),
      ...(displayOrder !== undefined
        ? { displayOrder: number(displayOrder, 'model display order', 0) }
        : {}),
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
  /** Presentation-only ordering must not revise model generation settings or credentials. */
  moveModel(id: string, value: unknown) {
    const body = record(value);
    const direction = choice(body.direction, ['up', 'down'], 'model move direction');
    return this.store.transaction(() => {
      const model = this.get<ModelPreset>('model', id);
      const group = (this.all('model') as ModelPreset[])
        .filter((item) => item.connectionId === model.connectionId)
        .sort(compareModelDisplayOrder);
      const index = group.findIndex((item) => item.id === id);
      const target = index + (direction === 'up' ? -1 : 1);
      if (index < 0 || target < 0 || target >= group.length) return { moved: false };
      [group[index], group[target]] = [group[target]!, group[index]!];
      const update = this.db.prepare(
        "UPDATE provider_settings SET body=json_set(body, '$.displayOrder', ?) WHERE kind='model' AND id=?"
      );
      group.forEach((item, order) => {
        if (item.displayOrder !== order) update.run(order, item.id);
      });
      return { moved: true };
    });
  }
  modelSnapshot(id: string, role?: string, authorize = true): ModelSnapshot {
    try {
      this.assertAvailable('model', id);
      // New executions use the current contract; stored settings and historical snapshots stay intact.
      const {
        capabilityRevision: _retiredRevision,
        displayOrder: _displayOrder,
        ...model
      } = this.get<ModelPreset & { capabilityRevision?: unknown }>('model', id);
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
      'image',
      'imageTranslation',
      'packageAttachments',
      'loreContext',
      'pinned',
    ]);
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
      resolvePackageModules(this, packageAttachments ?? [], {
        latest: true,
      });
      this.store.organization.assertBotAttachments(chatId, packageAttachments);
      const result: ChatProfile = {
        ...((requestedLore ?? prior.loreContext)
          ? { loreContext: requestedLore ?? prior.loreContext }
          : {}),
        chatId,
        revision: prior.revision + 1,
        ...(pinned && Object.keys(pinned).length ? { pinned } : {}),
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
      };
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
    // Auxiliary jobs keep their global prompt; an unavailable main pin must not prevent translation.
    const workspace = (() => {
      if (requiredRole !== 'main' && requiredRole !== 'inspect')
        return chatPromptWorkspace(this.store, { mainModel: p.pinned?.mainModel });
      try {
        return chatPromptWorkspace(this.store, p.pinned);
      } catch (error) {
        // An unavailable writing preset blocks new writing, not existing prose or translation.
        if (
          requiredRole !== 'inspect' ||
          !(error instanceof HttpError) ||
          !error.message.startsWith('PINNED_PROMPT_UNAVAILABLE')
        )
          throw error;
        return chatPromptWorkspace(this.store, { mainModel: p.pinned?.mainModel });
      }
    })();
    const models: ProfileSnapshot['models'] = {};
    const routes = { ...p.routes };
    for (const role of ['main', 'translation', 'status'] as const) {
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
    const scriptRef = workspaceModelRef(workspace, 'script');
    let scriptModel: ModelSnapshot | undefined;
    if (scriptRef) {
      try {
        scriptModel = this.modelSnapshot(scriptRef.id, undefined, false);
      } catch (error) {
        // An unavailable add-on model must not prevent reservation of the user's prose.
        if (!(error instanceof HttpError) || ![403, 404, 409].includes(error.statusCode))
          throw error;
      }
    }
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
      models,
      ...resolvePackageProfile(this, p),
      ...frozen,
      ...(contextModel ? { contextModel } : {}),
      ...(scriptModel ? { scriptModel } : {}),
      ...(collaboration?.enabled && (requiredRole === 'main' || requiredRole === 'inspect')
        ? { collaborationModels }
        : {}),
    };
    // Freeze today's supported Risu fields for new work, without rewriting library versions or
    // the source-time packages held by completed runs and backup receipts.
    if (profile.packages)
      profile.packages = profile.packages.map(
        (pkg) =>
          projectNativeRisuPackage(pkg, this.get<Content>('content', pkg.id, pkg.revision).kind).pkg
      );
    for (const preset of Object.values(profile.promptPresets ?? {}))
      if (preset.program.nativeRisuPreset)
        stripDeprecatedRisuPresetFields(preset.program.nativeRisuPreset.preset);
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
    // Explicit null freezes the absence of a guide as well as a populated one. Old jobs do not
    // silently adopt newly edited metadata at worker start or during judgment-only recovery.
    if (
      input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.hasOwn(input, 'translationGuide')
    )
      resolved.translationGuide = structuredClone(
        (input as { translationGuide: RunSnapshot['translationGuide'] }).translationGuide
      );
    for (const role of ['translation', 'status'] as const) {
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
      resolved.profile ??= { ...defaultProfile(resolved.chatId), models: {} };
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
      resolved.profile ??= { ...defaultProfile(resolved.chatId), models: {} };
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
        resolved.settings.maxCalls = policy.maxCalls;
      }
    }
    return resolved;
  }
  resources(chatId: string, p: ProfileSnapshot): Resource[] {
    return [
      ...(p.packageAttachments ?? []).flatMap((ref) => {
        const pkg = p.packages!.find(
          (item) => item.id === ref.id && item.revision === ref.revision
        )!;
        const compiled = compileContentAttachment(pkg, ref, {
          chatId,
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
      current.credentialRef !== connection.credentialRef
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
  branch(chatId: string, id?: string): Branch {
    const b = this.branches(chatId).find((x) => (id === undefined ? x.default : x.id === id));
    if (!b) throw new HttpError(404, 'Branch not found');
    return b;
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
  resumeAttempt(id: string, runId: string, request: WireRecord) {
    const row = this.db
      .prepare('SELECT run_id,role,connection_id,model_id,request FROM attempts WHERE id=?')
      .get(id) as Row | undefined;
    const batch = this.db
      .prepare('SELECT 1 FROM anthropic_batches WHERE attempt_id=? AND run_id=?')
      .get(id, runId);
    const previous = row ? parse(row.request) : null;
    if (
      !row ||
      !batch ||
      row.run_id !== runId ||
      row.role !== request.role ||
      row.connection_id !== request.connectionId ||
      row.model_id !== request.modelId ||
      previous?.protocol !== request.protocol ||
      previous?.bodySha256 !== request.bodySha256 ||
      previous?.stablePrefixSha256 !== request.stablePrefixSha256 ||
      previous?.executionMode !== 'batch'
    )
      throw new HttpError(409, 'Batch attempt recovery mismatch');
    return id;
  }
  finishAttempt(id: string, result: ProviderResult) {
    const row = this.db.prepare('SELECT request FROM attempts WHERE id=?').get(id) as
      | Row
      | undefined;
    const request = row ? parse(row.request) : null;
    let estimatedCost = estimateCost(
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
    if (
      request?.executionMode === 'batch' &&
      request?.protocol === 'anthropic-messages-v1' &&
      estimatedCost.status !== 'unavailable'
    )
      estimatedCost = {
        ...estimatedCost,
        usd: estimatedCost.usd === null ? null : estimatedCost.usd * 0.5,
        subtotalUsd: estimatedCost.subtotalUsd * 0.5,
        lines: estimatedCost.lines.map((line) => ({
          ...line,
          rate: line.rate === null ? null : line.rate * 0.5,
          usd: line.usd === null ? null : line.usd * 0.5,
        })),
        notes: [...estimatedCost.notes, 'ANTHROPIC_BATCH_50_PERCENT'],
      };
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
    const r = this.db
      .prepare(
        'SELECT a.body,i.bytes FROM assets a JOIN image_blobs i ON i.hash=a.hash WHERE a.id=?'
      )
      .get(id) as Row | undefined;
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
    storeImage(this.db, { hash: result.hash, mime, bytes });
    this.db
      .prepare('INSERT INTO assets VALUES(?,?,?,?)')
      .run(id, chatId, json(result), result.hash);
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
      promptPresets: summary ? this.libraryMetadata().prompts : this.all('prompt-preset'),
      promptCombinations: this.all('prompt-combination'),
      contents,
      connections: this.all('connection'),
      models: this.all('model'),
      assets: summary ? [] : this.assets(),
    };
  }
}

function currentRef(product: ProductStore, kind: string, reference: ContentRef): ContentRef {
  const current = product.get<ContentRef>(kind, reference.id);
  return { id: current.id, revision: current.revision };
}
/** Pure current-settings projection. Frozen Run/source profiles never pass through this path. */
function currentProfile(product: ProductStore, saved: ChatProfile): ChatProfile {
  const current = saved;
  const result = {
    ...current,
    imageTranslation: current.imageTranslation ?? true,
    routes: {
      ...structuredClone(promptWorkspace(product.store).modelRoutes),
      ...(saved.pinned?.mainModel ? { main: structuredClone(saved.pinned.mainModel) } : {}),
    },
  };
  if (saved.packageAttachments)
    result.packageAttachments = saved.packageAttachments.map((r) => ({
      ...r,
      ...currentRef(product, 'content', r),
    }));
  return result;
}
function packageRefs(product: ProductStore, value: unknown): ContentAttachment[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new HttpError(400, 'Invalid package attachments');
  const refs = value.map(validateContentAttachment);
  if (
    new Set(refs.map((r) => `${r.id}:${r.role}`)).size !== refs.length ||
    refs.filter((r) => r.role === 'bot').length > 1 ||
    refs.filter((r) => r.role === 'persona').length > 1
  )
    throw new HttpError(400, 'Duplicate package or primary role');
  for (const r of refs)
    if (!product.get<Content>('content', r.id).package)
      throw new HttpError(400, 'Content is not a package');
  return refs;
}
