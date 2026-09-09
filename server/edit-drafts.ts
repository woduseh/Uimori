import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type {
  DraftChange,
  DraftImpact,
  DraftPatchResult,
  DraftProposal,
  DraftSaveResult,
  DraftValidation,
  EditDraft,
  EditDraftKind,
  EditDraftModel,
} from '../core/edit-drafts.js';
import type { ChatProfile, Content, PromptPreset, PromptWorkspace } from '../core/product.js';
import {
  promptWorkspace,
  updatePromptWorkspace,
  validatePromptWorkspace,
} from './prompt-workspace.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

export const editDraftTables = ['edit_drafts', 'edit_draft_proposals', 'edit_draft_operations'];
export type DraftWriteIntent = {
  action: 'create' | 'patch' | 'save' | 'undo' | 'discard';
  draftId: string | null;
  kind: EditDraftKind;
  targetId: string | null;
  expectedRevision: number | null;
};
/** Constructed by a trusted UI route or the helper host, never deserialized from model input. */
export type DraftAuthority = {
  requestId: string;
  assert: (intent: DraftWriteIntent) => void;
};
type Row = Record<string, string | number | null>;
const stamp = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const kinds: EditDraftKind[] = ['content', 'prompt-preset', 'prompt-workspace'];
function kindValue(value: unknown): EditDraftKind {
  if (!kinds.includes(value as EditDraftKind)) throw new HttpError(400, 'Invalid draft kind');
  return value as EditDraftKind;
}
function modelValue(kind: EditDraftKind, value: unknown): EditDraftModel {
  const body = record(value);
  fields(
    body,
    kind === 'content'
      ? ['kind', 'title', 'description', 'text', 'loading', 'relatedIds', 'package']
      : kind === 'prompt-preset'
        ? ['title', 'role', 'program', 'values']
        : ['main', 'translation']
  );
  if (json(body).length > 5_000_000) throw new HttpError(400, 'Draft model too large');
  return structuredClone(body) as EditDraftModel;
}
function rawValues(value: unknown): Record<string, string> {
  const body = record(value);
  if (Object.keys(body).length > 1500 || json(body).length > 6_000_000)
    throw new HttpError(400, 'Draft buffers too large');
  return Object.fromEntries(
    Object.entries(body).map(([path, value]) => [
      text(path, 'draft field path', 500),
      text(value, 'draft field text', 1_000_000, true),
    ])
  );
}
function unappliedValues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1500)
    throw new HttpError(400, 'Invalid unapplied fields');
  return [...new Set(value.map((path) => text(path, 'draft field path', 500)))];
}
function draftModel(kind: EditDraftKind, value: Content | PromptPreset | PromptWorkspace) {
  if (kind === 'prompt-workspace') {
    const current = value as PromptWorkspace;
    return modelValue(kind, { main: current.main, translation: current.translation });
  }
  const { id: _id, revision: _revision, ...body } = value as Content | PromptPreset;
  return modelValue(kind, body);
}
export function initEditDrafts(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS edit_drafts(
      id TEXT PRIMARY KEY, editor_key TEXT NOT NULL, kind TEXT NOT NULL,
      target_id TEXT, revision INTEGER NOT NULL CHECK(revision>0),
      status TEXT NOT NULL CHECK(status IN ('active','discarded')), body TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS edit_drafts_active_editor ON edit_drafts(editor_key) WHERE status='active';
    CREATE TABLE IF NOT EXISTS edit_draft_proposals(
      id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES edit_drafts(id), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS edit_draft_operations(
      operation_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES edit_drafts(id),
      action TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      intent TEXT NOT NULL, result TEXT NOT NULL, before_body TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
}

function changes(before: unknown, after: unknown, path = ''): DraftChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>,
      right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      changes(left[key], right[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    );
  }
  return [{ path: path || '/', before: before ?? null, after: after ?? null }];
}

export class EditDraftService {
  constructor(readonly store: Store) {}
  get(id: string): EditDraft {
    const row = this.store.db.prepare('SELECT body FROM edit_drafts WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, 'Edit draft not found');
    return JSON.parse(String(row.body)) as EditDraft;
  }
  list(editorKey?: string): EditDraft[] {
    const rows = editorKey
      ? this.store.db
          .prepare("SELECT body FROM edit_drafts WHERE editor_key=? AND status='active'")
          .all(editorKey)
      : this.store.db
          .prepare(
            "SELECT body FROM edit_drafts WHERE status='active' ORDER BY rowid DESC LIMIT 200"
          )
          .all();
    return rows.map((row) => JSON.parse(String(row.body)) as EditDraft);
  }
  proposals(id: string): DraftProposal[] {
    this.get(id);
    return this.store.db
      .prepare('SELECT body FROM edit_draft_proposals WHERE draft_id=? ORDER BY rowid')
      .all(id)
      .map((row) => JSON.parse(String(row.body)) as DraftProposal);
  }
  private write(draft: EditDraft) {
    this.store.db
      .prepare(`INSERT INTO edit_drafts VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET editor_key=excluded.editor_key,target_id=excluded.target_id,
      revision=excluded.revision,status=excluded.status,body=excluded.body`)
      .run(
        draft.id,
        draft.editorKey,
        draft.kind,
        draft.targetId,
        draft.revision,
        draft.status,
        json(draft)
      );
  }
  private active(id: string, expected?: number): EditDraft {
    const draft = this.get(id);
    if (draft.status !== 'active')
      throw new HttpError(409, '초안이 폐기됐어요. 새 초안을 열어 주세요.');
    if (expected !== undefined && draft.revision !== expected)
      throw new HttpError(
        409,
        '초안이 변경됐어요. 현재 입력은 유지하고 변경 내용을 확인해 주세요.'
      );
    return draft;
  }
  private operation<T>(
    operationId: string,
    input: unknown,
    authority: DraftAuthority,
    intent: () => DraftWriteIntent,
    action: () => { draft: EditDraft; result: T; before: unknown }
  ): T {
    text(operationId, 'draft operation ID', 160);
    if (!authority || typeof authority.assert !== 'function')
      throw new HttpError(403, 'Draft write authority required');
    text(authority.requestId, 'draft request ID', 200);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT * FROM edit_draft_operations WHERE operation_id=?')
        .get(operationId) as Row | undefined;
      if (prior) {
        authority.assert(JSON.parse(String(prior.intent)) as DraftWriteIntent);
        if (prior.request_hash !== hash(input) || prior.request_id !== authority.requestId)
          throw new HttpError(409, 'Draft operation ID already belongs to another request');
        return JSON.parse(String(prior.result)) as T;
      }
      const allowed = intent();
      authority.assert(allowed);
      const { draft, result, before } = action();
      this.store.db
        .prepare('INSERT INTO edit_draft_operations VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          operationId,
          draft.id,
          allowed.action,
          authority.requestId,
          hash(input),
          json(allowed),
          json(result),
          json(before),
          stamp()
        );
      return result;
    });
  }
  create(value: unknown, authority: DraftAuthority): EditDraft {
    const input = record(value);
    fields(input, ['editorKey', 'kind', 'targetId', 'model', 'operationId']);
    const kind = kindValue(input.kind),
      editorKey = text(input.editorKey, 'editor key', 200);
    const targetId = input.targetId === null ? null : text(input.targetId, 'draft target', 160);
    if (kind === 'prompt-workspace' && targetId !== 'current')
      throw new HttpError(400, 'Invalid workspace draft target');
    const operationId = text(input.operationId, 'draft operation ID', 160);
    return this.operation(
      operationId,
      input,
      authority,
      () => ({ action: 'create', draftId: null, kind, targetId, expectedRevision: null }),
      () => {
        const existing = this.list(editorKey)[0];
        if (existing) {
          if (existing.kind !== kind || existing.targetId !== targetId)
            throw new HttpError(409, 'Editor key belongs to another target');
          return { draft: existing, result: existing, before: null };
        }
        const saved = targetId
          ? kind === 'prompt-workspace'
            ? promptWorkspace(this.store)
            : this.store.product.get<Content | PromptPreset>(kind, targetId)
          : null;
        if (targetId && kind !== 'prompt-workspace')
          this.store.product.assertAvailable(kind, targetId);
        const model = saved ? draftModel(kind, saved) : modelValue(kind, input.model);
        const draft: EditDraft = {
          id: randomUUID(),
          revision: 1,
          editorKey,
          kind,
          targetId,
          baseRevision: saved?.revision ?? null,
          baseHash: hash(model),
          baseModel: structuredClone(model),
          model,
          rawFields: {},
          unappliedFields: [],
          status: 'active',
          createdAt: stamp(),
          updatedAt: stamp(),
        };
        this.write(draft);
        return { draft, result: draft, before: null };
      }
    );
  }
  patch(id: string, value: unknown, authority: DraftAuthority): DraftPatchResult {
    const input = record(value);
    fields(input, ['operationId', 'expectedRevision', 'model', 'rawFields', 'unappliedFields']);
    const expected = number(input.expectedRevision, 'draft revision');
    return this.operation(
      text(input.operationId, 'draft operation ID', 160),
      { id, ...input },
      authority,
      () => this.intent('patch', id, expected),
      () => {
        const current = this.active(id),
          model = modelValue(current.kind, input.model);
        const rawFields = rawValues(input.rawFields),
          unappliedFields = unappliedValues(input.unappliedFields);
        if (current.revision !== expected) {
          const proposal: DraftProposal = {
            id: randomUUID(),
            draftId: id,
            expectedRevision: expected,
            actualRevision: current.revision,
            model,
            rawFields,
            unappliedFields,
            createdAt: stamp(),
          };
          this.store.db
            .prepare('INSERT INTO edit_draft_proposals VALUES(?,?,?)')
            .run(proposal.id, id, json(proposal));
          return {
            draft: current,
            result: { status: 'conflict', draft: current, proposal } as DraftPatchResult,
            before: current,
          };
        }
        const draft: EditDraft = {
          ...current,
          model,
          rawFields,
          unappliedFields,
          revision: current.revision + 1,
          updatedAt: stamp(),
        };
        this.write(draft);
        return { draft, result: { status: 'applied', draft } as DraftPatchResult, before: current };
      }
    );
  }
  private intent(
    action: DraftWriteIntent['action'],
    id: string,
    expected: number
  ): DraftWriteIntent {
    const draft = this.get(id);
    return {
      action,
      draftId: id,
      kind: draft.kind,
      targetId: draft.targetId,
      expectedRevision: expected,
    };
  }
  private saveModel(draft: EditDraft): Content | PromptPreset | PromptWorkspace {
    if (draft.kind === 'prompt-workspace')
      return updatePromptWorkspace(
        this.store,
        { ...draft.model, expectedRevision: draft.baseRevision },
        undefined,
        true
      );
    const input = {
      ...draft.model,
      ...(draft.targetId ? { expectedRevision: draft.baseRevision } : {}),
    };
    return (
      draft.kind === 'content'
        ? this.store.product.content(input, draft.targetId ?? undefined, true)
        : this.store.product.promptPreset(input, draft.targetId ?? undefined, true)
    ) as Content | PromptPreset;
  }
  validate(id: string): DraftValidation {
    const draft = this.active(id);
    if (draft.unappliedFields.length)
      return {
        valid: false,
        errors: draft.unappliedFields.map(
          (path) => `${path}: 아직 적용하지 않은 편집 내용이 있어요.`
        ),
      };
    // Run the real save validators in a rollback-only savepoint; no model calls or durable effects.
    this.store.db.exec('SAVEPOINT validate_edit_draft');
    try {
      this.saveModel(draft);
      return { valid: true, errors: [] };
    } catch (error) {
      return { valid: false, errors: [(error as Error).message] };
    } finally {
      this.store.db.exec('ROLLBACK TO validate_edit_draft; RELEASE validate_edit_draft');
    }
  }
  diff(id: string) {
    const draft = this.get(id);
    return {
      draftId: id,
      revision: draft.revision,
      changes: changes(draft.baseModel, draft.model),
      unappliedFields: draft.unappliedFields,
    };
  }
  impact(id: string): DraftImpact {
    const draft = this.get(id),
      contents: DraftImpact['contents'] = [],
      chats: DraftImpact['chats'] = [];
    const affected = new Set(draft.targetId && draft.kind === 'content' ? [draft.targetId] : []);
    if (affected.size) {
      const library = this.store.product.all('content') as Content[];
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const content of library)
          if (
            !affected.has(content.id) &&
            content.package?.modules?.some((ref) => affected.has(ref.id))
          ) {
            affected.add(content.id);
            expanded = true;
          }
      }
      for (const content of library)
        if (affected.has(content.id))
          contents.push({
            id: content.id,
            title: content.title,
            indirect: content.id !== draft.targetId,
          });
    }
    for (const chat of this.store.chats()) {
      const profile = this.store.product.profile(chat.id) as ChatProfile;
      const roles = (profile.packageAttachments ?? [])
        .filter((ref) => affected.has(ref.id))
        .map((ref) => ref.role);
      if (profile.attachments.some((ref) => affected.has(ref.id))) roles.push('module');
      if (draft.kind === 'prompt-workspace' || roles.length)
        chats.push({ id: chat.id, title: chat.title, roles: [...new Set(roles)] });
    }
    return {
      targetId: draft.targetId,
      scope:
        draft.kind === 'prompt-workspace'
          ? 'all-chats'
          : !draft.targetId
            ? 'new-item'
            : draft.kind === 'prompt-preset'
              ? 'saved-preset'
              : 'shared-content',
      contents,
      chats,
      applies: 'next-request',
    };
  }
  save(id: string, value: unknown, authority: DraftAuthority): DraftSaveResult {
    const input = record(value);
    fields(input, ['operationId', 'expectedRevision']);
    const expected = number(input.expectedRevision, 'draft revision'),
      operationId = text(input.operationId, 'draft operation ID', 160);
    return this.operation(
      operationId,
      { id, ...input },
      authority,
      () => this.intent('save', id, expected),
      () => {
        const before = this.active(id, expected);
        if (before.unappliedFields.length)
          throw new HttpError(400, '미적용 초안을 검증하고 적용한 뒤 저장해 주세요.');
        const saved = this.saveModel(before),
          model = draftModel(before.kind, saved);
        const draft: EditDraft = {
          ...before,
          targetId: before.kind === 'prompt-workspace' ? 'current' : (saved as Content).id,
          editorKey:
            before.targetId === null ? `${before.kind}:${(saved as Content).id}` : before.editorKey,
          baseRevision: saved.revision,
          baseHash: hash(model),
          baseModel: structuredClone(model),
          model,
          rawFields: {},
          unappliedFields: [],
          revision: before.revision + 1,
          updatedAt: stamp(),
        };
        this.write(draft);
        return {
          draft,
          before,
          result: {
            status: 'saved',
            draft,
            saved,
            operationId,
            created: before.targetId === null,
            changes: changes(before.baseModel, model),
          } as DraftSaveResult,
        };
      }
    );
  }
  undo(id: string, value: unknown, authority: DraftAuthority): DraftSaveResult {
    const input = record(value);
    fields(input, ['operationId', 'expectedRevision', 'savedOperationId']);
    const expected = number(input.expectedRevision, 'draft revision'),
      operationId = text(input.operationId, 'draft operation ID', 160);
    const savedOperationId = text(input.savedOperationId, 'saved operation ID', 160);
    return this.operation(
      operationId,
      { id, ...input },
      authority,
      () => this.intent('undo', id, expected),
      () => {
        const before = this.active(id, expected);
        const row = this.store.db
          .prepare(
            "SELECT result,before_body FROM edit_draft_operations WHERE operation_id=? AND draft_id=? AND action IN ('save','undo')"
          )
          .get(savedOperationId, id) as Row | undefined;
        if (!row) throw new HttpError(404, 'Saved draft operation not found');
        const original = JSON.parse(String(row.before_body)) as EditDraft;
        const receipt = JSON.parse(String(row.result)) as DraftSaveResult;
        if (original.targetId === null)
          throw new HttpError(409, '새 자료 생성은 자료 삭제 메뉴에서 되돌릴 수 있어요.');
        if (
          before.baseRevision !== receipt.saved.revision ||
          hash(before.model) !== hash(receipt.draft.model) ||
          before.unappliedFields.length
        )
          throw new HttpError(409, '저장 후 편집된 내용이 있어요. 되돌리기 차이를 확인해 주세요.');
        const restoring = { ...before, model: original.baseModel };
        const saved = this.saveModel(restoring),
          model = draftModel(before.kind, saved);
        const draft: EditDraft = {
          ...before,
          baseRevision: saved.revision,
          baseHash: hash(model),
          baseModel: structuredClone(model),
          model,
          rawFields: {},
          unappliedFields: [],
          revision: before.revision + 1,
          updatedAt: stamp(),
        };
        this.write(draft);
        return {
          draft,
          before,
          result: {
            status: 'saved',
            draft,
            saved,
            operationId,
            created: false,
            changes: changes(before.model, model),
          } as DraftSaveResult,
        };
      }
    );
  }
  discard(id: string, value: unknown, authority: DraftAuthority): EditDraft {
    const input = record(value);
    fields(input, ['operationId', 'expectedRevision']);
    const expected = number(input.expectedRevision, 'draft revision');
    return this.operation(
      text(input.operationId, 'draft operation ID', 160),
      { id, ...input },
      authority,
      () => this.intent('discard', id, expected),
      () => {
        const before = this.active(id, expected);
        const draft: EditDraft = {
          ...before,
          revision: before.revision + 1,
          status: 'discarded',
          updatedAt: stamp(),
        };
        this.write(draft);
        return { draft, result: draft, before };
      }
    );
  }
  rebase(id: string, value: unknown, authority: DraftAuthority): EditDraft {
    const input = record(value);
    fields(input, ['operationId', 'expectedRevision', 'expectedTargetRevision', 'mode']);
    const expected = number(input.expectedRevision, 'draft revision');
    const targetRevision = number(input.expectedTargetRevision, 'target revision');
    if (!['keep-draft', 'saved', 'pristine'].includes(input.mode))
      throw new HttpError(400, 'Invalid draft rebase mode');
    return this.operation(
      text(input.operationId, 'draft operation ID', 160),
      { id, ...input },
      authority,
      () => this.intent('patch', id, expected),
      () => {
        const before = this.active(id, expected);
        if (
          input.mode === 'pristine' &&
          (!isDeepStrictEqual(before.model, before.baseModel) ||
            Object.keys(before.rawFields).length > 0 ||
            before.unappliedFields.length > 0)
        )
          throw new HttpError(
            409,
            '편집 중인 초안은 자동으로 바꾸지 않아요. 변경 내용을 확인해 주세요.'
          );
        if (!before.targetId) throw new HttpError(409, '새 자료에는 저장본이 없어요.');
        if (before.kind !== 'prompt-workspace')
          this.store.product.assertAvailable(before.kind, before.targetId);
        const target =
          before.kind === 'prompt-workspace'
            ? promptWorkspace(this.store)
            : this.store.product.get<Content | PromptPreset>(before.kind, before.targetId);
        if (target.revision !== targetRevision)
          throw new HttpError(409, '저장본이 다시 변경됐어요.');
        const baseModel = draftModel(before.kind, target);
        const draft: EditDraft = {
          ...before,
          baseModel,
          baseHash: hash(baseModel),
          baseRevision: target.revision,
          ...(input.mode !== 'keep-draft'
            ? { model: structuredClone(baseModel), rawFields: {}, unappliedFields: [] }
            : {}),
          revision: before.revision + 1,
          updatedAt: stamp(),
        };
        this.write(draft);
        return { draft, result: draft, before };
      }
    );
  }
  savedTarget(id: string) {
    const draft = this.active(id);
    if (!draft.targetId) return null;
    const target =
      draft.kind === 'prompt-workspace'
        ? promptWorkspace(this.store)
        : this.store.product.get<Content | PromptPreset>(draft.kind, draft.targetId);
    return { revision: target.revision, model: draftModel(draft.kind, target) };
  }
  savedOperations(id: string) {
    this.get(id);
    return (
      this.store.db
        .prepare(
          "SELECT operation_id,created_at,result,before_body FROM edit_draft_operations WHERE draft_id=? AND action IN ('save','undo') ORDER BY rowid DESC LIMIT 10"
        )
        .all(id) as Row[]
    ).map((row) => {
      const result = JSON.parse(String(row.result)) as DraftSaveResult;
      const before = JSON.parse(String(row.before_body)) as EditDraft;
      return {
        operationId: String(row.operation_id),
        createdAt: String(row.created_at),
        savedRevision: result.saved.revision,
        created: result.created,
        changes: result.changes,
        undoChanges: changes(result.draft.model, before.baseModel),
      };
    });
  }
}

/** Validate restored editing evidence without requiring an unfinished editor model to be saveable. */
export function validateEditDraftArchive(store: Store): void {
  const invalid = (message: string): never => {
    throw new HttpError(400, `Invalid edit draft archive: ${message}`);
  };
  const timestamp = (value: unknown) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid('timestamp');
  };
  const checked = (value: unknown): EditDraft => {
    const body = record(value);
    fields(body, [
      'id',
      'revision',
      'editorKey',
      'kind',
      'targetId',
      'baseRevision',
      'baseHash',
      'baseModel',
      'model',
      'rawFields',
      'unappliedFields',
      'status',
      'createdAt',
      'updatedAt',
    ]);
    const kind = kindValue(body.kind);
    text(body.id, 'draft ID', 160);
    text(body.editorKey, 'editor key', 200);
    number(body.revision, 'draft revision');
    if (!['active', 'discarded'].includes(String(body.status))) invalid('draft status');
    modelValue(kind, body.model);
    modelValue(kind, body.baseModel);
    rawValues(body.rawFields);
    unappliedValues(body.unappliedFields);
    if (body.baseHash !== hash(body.baseModel)) invalid('base hash');
    timestamp(body.createdAt);
    timestamp(body.updatedAt);
    if (body.targetId === null) {
      if (kind === 'prompt-workspace' || body.baseRevision !== null) invalid('new target');
    } else {
      const targetId = text(body.targetId, 'target ID', 160),
        revision = number(body.baseRevision, 'base revision');
      if (kind === 'prompt-workspace') {
        if (targetId !== 'current' || revision > promptWorkspace(store).revision)
          invalid('workspace target');
      } else {
        const saved = store.product.get<Content | PromptPreset>(kind, targetId, revision);
        if (!isDeepStrictEqual(body.baseModel, draftModel(kind, saved))) invalid('base source');
      }
    }
    return body as EditDraft;
  };
  const drafts = new Map<string, EditDraft>();
  for (const row of store.db.prepare('SELECT * FROM edit_drafts').all() as Row[]) {
    const draft = checked(JSON.parse(String(row.body)));
    if (
      row.id !== draft.id ||
      row.editor_key !== draft.editorKey ||
      row.kind !== draft.kind ||
      row.target_id !== draft.targetId ||
      row.revision !== draft.revision ||
      row.status !== draft.status
    )
      invalid('draft row identity');
    drafts.set(draft.id, draft);
  }
  const proposals = new Map<string, DraftProposal>();
  const proposal = (value: unknown): DraftProposal => {
    const body = record(value);
    fields(body, [
      'id',
      'draftId',
      'expectedRevision',
      'actualRevision',
      'model',
      'rawFields',
      'unappliedFields',
      'createdAt',
    ]);
    const draft = drafts.get(text(body.draftId, 'draft ID', 160));
    if (!draft) return invalid('proposal owner');
    text(body.id, 'proposal ID', 160);
    number(body.expectedRevision, 'expected revision');
    number(body.actualRevision, 'actual revision');
    if (body.actualRevision > draft.revision || body.expectedRevision === body.actualRevision)
      invalid('proposal revision');
    modelValue(draft.kind, body.model);
    rawValues(body.rawFields);
    unappliedValues(body.unappliedFields);
    timestamp(body.createdAt);
    return body as DraftProposal;
  };
  for (const row of store.db.prepare('SELECT * FROM edit_draft_proposals').all() as Row[]) {
    const entry = proposal(JSON.parse(String(row.body)));
    if (row.id !== entry.id || row.draft_id !== entry.draftId) invalid('proposal identity');
    proposals.set(entry.id, entry);
  }
  for (const row of store.db.prepare('SELECT * FROM edit_draft_operations').all() as Row[]) {
    const current = drafts.get(String(row.draft_id));
    if (!current) invalid('operation owner');
    text(row.operation_id, 'operation ID', 160);
    text(row.request_id, 'request ID', 200);
    timestamp(row.created_at);
    if (typeof row.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.request_hash))
      invalid('request hash');
    const intent = record(JSON.parse(String(row.intent)));
    fields(intent, ['action', 'draftId', 'kind', 'targetId', 'expectedRevision']);
    if (
      !['create', 'patch', 'save', 'undo', 'discard'].includes(String(intent.action)) ||
      row.action !== intent.action ||
      intent.kind !== current!.kind
    )
      invalid('operation intent');
    if (intent.action === 'create') {
      if (intent.draftId !== null || intent.expectedRevision !== null) invalid('create intent');
    } else {
      if (intent.draftId !== current!.id) invalid('operation draft');
      number(intent.expectedRevision, 'expected revision');
    }
    const result = record(JSON.parse(String(row.result)));
    const receiptDraft = checked(result.draft ?? result);
    if (
      receiptDraft.id !== current!.id ||
      receiptDraft.kind !== current!.kind ||
      receiptDraft.revision > current!.revision
    )
      invalid('receipt draft');
    const before = JSON.parse(String(row.before_body)) as unknown;
    if (before !== null) {
      const prior = checked(before);
      if (
        prior.id !== current!.id ||
        prior.revision > receiptDraft.revision ||
        prior.status !== 'active'
      )
        invalid('operation predecessor');
      if (intent.targetId !== prior.targetId) invalid('operation target');
    } else if (intent.action !== 'create') invalid('missing predecessor');
    if (intent.action === 'save' || intent.action === 'undo') {
      fields(result, ['status', 'draft', 'saved', 'operationId', 'created', 'changes']);
      if (
        result.status !== 'saved' ||
        result.operationId !== row.operation_id ||
        typeof result.created !== 'boolean'
      )
        invalid('save receipt');
      const saved = record(result.saved);
      if (
        saved.revision !== receiptDraft.baseRevision ||
        !isDeepStrictEqual(
          draftModel(current!.kind, saved as Content | PromptPreset | PromptWorkspace),
          receiptDraft.model
        )
      )
        invalid('saved model');
      if (current!.kind === 'prompt-workspace') validatePromptWorkspace(saved);
      else if (
        !isDeepStrictEqual(
          saved,
          store.product.get<Content | PromptPreset>(
            current!.kind,
            String(saved.id),
            Number(saved.revision)
          )
        )
      )
        invalid('saved source');
      const prior = before as EditDraft;
      if (
        !isDeepStrictEqual(
          result.changes,
          changes(intent.action === 'undo' ? prior.model : prior.baseModel, receiptDraft.model)
        )
      )
        invalid('saved difference');
    } else if (result.status === 'conflict') {
      fields(result, ['status', 'draft', 'proposal']);
      const entry = proposal(result.proposal);
      if (!isDeepStrictEqual(entry, proposals.get(entry.id))) invalid('conflict proposal');
    } else if (result.status === 'applied') fields(result, ['status', 'draft']);
  }
}

/** Authentication/origin checks are owned by the app; this explicit UI endpoint grants only its own operation. */
export function editDraftRoutes(app: FastifyInstance, service: EditDraftService) {
  const ui = (operationId: unknown): DraftAuthority => ({
    requestId: `user-ui:${text(operationId, 'draft operation ID', 160)}`,
    assert: () => {},
  });
  app.get<{ Querystring: { editorKey?: string } }>('/api/edit-drafts', async (request) =>
    service.list(
      request.query.editorKey === undefined
        ? undefined
        : text(request.query.editorKey, 'editor key', 200)
    )
  );
  app.post('/api/edit-drafts', { bodyLimit: 12_000_000 }, async (request) =>
    service.create(request.body, ui(record(request.body).operationId))
  );
  app.get<{ Params: { id: string } }>('/api/edit-drafts/:id', async (request) =>
    service.get(request.params.id)
  );
  app.patch<{ Params: { id: string } }>(
    '/api/edit-drafts/:id',
    { bodyLimit: 12_000_000 },
    async (request) =>
      service.patch(request.params.id, request.body, ui(record(request.body).operationId))
  );
  app.get<{ Params: { id: string } }>('/api/edit-drafts/:id/proposals', async (request) =>
    service.proposals(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/edit-drafts/:id/saved-target', async (request) =>
    service.savedTarget(request.params.id)
  );
  app.get<{ Params: { id: string } }>('/api/edit-drafts/:id/saved-operations', async (request) =>
    service.savedOperations(request.params.id)
  );
  for (const action of ['validate', 'diff', 'impact'] as const)
    app.get<{ Params: { id: string } }>(`/api/edit-drafts/:id/${action}`, async (request) =>
      service[action](request.params.id)
    );
  for (const action of ['save', 'undo', 'rebase'] as const)
    app.post<{ Params: { id: string } }>(`/api/edit-drafts/:id/${action}`, async (request) =>
      service[action](request.params.id, request.body, ui(record(request.body).operationId))
    );
  app.delete<{ Params: { id: string } }>('/api/edit-drafts/:id', async (request) =>
    service.discard(request.params.id, request.body, ui(record(request.body).operationId))
  );
}
