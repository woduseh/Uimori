import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { jsonPayloadHash } from './json-hash.js';
import { HttpError, fields, isSha256Hex, number, record, text } from './request-validation.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { Content, ProfileSnapshot } from '../core/product.js';
import type { Run, RunSnapshot } from '../core/types.js';
import {
  resolvePackageStart,
  validatePackageStartRef,
  validatePackageStarts,
  type PackageStartRef,
  type PackageStartSnapshot,
} from '../core/package-start.js';
import { chatVariableProfile } from './chat-variable-context.js';
import type { Store } from './store.js';

export type PackageStartCommand = Omit<PackageStartRef, 'startId'> & {
  startId: string | null;
  expectedSettingsRevision: number;
  expectedProfileRevision: number;
  idempotencyKey: string;
  expectedRevision?: string;
  expectedSourceHash?: string;
};
export function validatePackageStartCommand(value: unknown): PackageStartCommand {
  const body = record(value);
  fields(body, [
    'packageId',
    'packageRevision',
    'startId',
    'expectedSettingsRevision',
    'expectedProfileRevision',
    'idempotencyKey',
    'expectedRevision',
    'expectedSourceHash',
  ]);
  if (body.startId === null && body.expectedRevision === undefined)
    throw new HttpError(400, 'Source revision required');
  const replacing = body.expectedRevision !== undefined || body.expectedSourceHash !== undefined;
  if (replacing && !isSha256Hex(body.expectedSourceHash))
    throw new HttpError(400, 'Invalid source hash');
  return {
    ...(replacing
      ? {
          expectedRevision: text(body.expectedRevision, 'source revision', 200),
          expectedSourceHash: body.expectedSourceHash as string,
        }
      : {}),
    ...validatePackageStartRef({
      packageId: body.packageId,
      packageRevision: body.packageRevision,
      startId: body.startId === null ? 'start-0' : body.startId,
    }),
    ...(body.startId === null ? { startId: null } : {}),
    expectedSettingsRevision: number(body.expectedSettingsRevision, 'settings revision'),
    expectedProfileRevision: number(body.expectedProfileRevision, 'profile revision'),
    idempotencyKey: text(body.idempotencyKey, 'idempotency key', 120),
  };
}

/** Only an untouched opening can change without reinterpreting later conversation or card actions. */
export function canChangePackageStart(store: Store, chatId: string): boolean {
  return !!store.db
    .prepare(
      `SELECT 1 FROM chats c JOIN sources s ON s.id=c.head_revision JOIN runs r ON r.id=s.run_id
      JOIN chat_organization o ON o.chat_id=c.id
      JOIN versions v ON v.kind='content' AND v.id=o.bot_id
        AND v.id=json_extract(r.snapshot,'$.packageStart.packageId')
        AND v.revision=json_extract(r.snapshot,'$.packageStart.packageRevision')
      WHERE c.id=? AND s.chat_id=c.id AND s.parent_revision IS NULL
      AND json_array_length(v.body,'$.package.starts')>=1
      AND json_extract(r.snapshot,'$.packageStart.mode')='authored'
      AND NOT EXISTS (SELECT 1 FROM runs other WHERE other.chat_id=c.id
        AND (COALESCE(json_extract(other.snapshot,'$.packageStart.mode'),'')!='authored' OR other.status!='completed'))`
    )
    .get(chatId);
}

function clearPackageStart(store: Store, chatId: string, command: PackageStartCommand) {
  const key = `transcript:package-start:${chatId}:${command.idempotencyKey}`;
  const digest = jsonPayloadHash(command);
  return store.transaction(() => {
    const prior = readImportReceipt<{ run: null }>(
      store,
      key,
      digest,
      'Idempotency key reused with different command'
    );
    if (prior) return { run: null, created: false };
    if (
      store.db
        .prepare('SELECT 1 FROM runs WHERE chat_id=? AND request_key=?')
        .get(chatId, command.idempotencyKey)
    )
      throw new HttpError(409, 'Idempotency key reused with different command');
    const chat = store.assertRunAdmission(chatId, {
      ...command,
      request: '',
      expectedRevision: command.expectedRevision!,
    });
    if (!canChangePackageStart(store, chatId))
      throw new HttpError(409, 'PACKAGE_START_CONVERSATION_STARTED');
    const profile = chatVariableProfile(store, chatId);
    if (
      chat.botId !== command.packageId ||
      !profile?.packageAttachments?.some(
        (item) =>
          item.role === 'bot' &&
          item.id === command.packageId &&
          item.revision === command.packageRevision
      )
    )
      throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
    store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(chatId);
    store.db
      .prepare('UPDATE context_heads SET revision=revision+1,checkpoint_id=NULL WHERE chat_id=?')
      .run(chatId);
    // Detach the opening, retaining authored edits and completed artifacts as history.
    for (const table of ['jobs', 'illustration_jobs']) {
      const jobs = store.db
        .prepare(
          `SELECT id FROM ${table} WHERE source_revision=? AND status IN ('queued','running')`
        )
        .all(command.expectedRevision!);
      store.db
        .prepare(
          `UPDATE ${table} SET status='cancelled',generation=generation+1,owner=NULL,updated_at=? WHERE source_revision=? AND status IN ('queued','running')`
        )
        .run(new Date().toISOString(), command.expectedRevision!);
      for (const job of jobs)
        store.event(
          chatId,
          table === 'jobs' ? 'job.cancelled' : 'illustration.cancelled',
          String(job.id)
        );
    }
    store.event(chatId, 'source.updated', command.expectedRevision!);
    saveImportReceipt(store, key, digest, { run: null });
    return { run: null, created: true };
  });
}

export function createPackageStart<T extends { startId: string }>(
  store: Store,
  chatId: string,
  value: T
): { run: Run; created: boolean };
export function createPackageStart(
  store: Store,
  chatId: string,
  value: unknown
): { run: Run | null; created: boolean };
/** Confirm a Risu greeting atomically without making a model request. */
export function createPackageStart(
  store: Store,
  chatId: string,
  value: unknown
): { run: Run | null; created: boolean } {
  const command = validatePackageStartCommand(value);
  if (command.startId === null) return clearPackageStart(store, chatId, command);
  const ref: PackageStartRef = {
    packageId: command.packageId,
    packageRevision: command.packageRevision,
    startId: command.startId,
  };
  return store.transaction(() => {
    if (
      store.db
        .prepare('SELECT 1 FROM import_operations WHERE key=?')
        .get(`transcript:package-start:${chatId}:${command.idempotencyKey}`)
    )
      throw new HttpError(409, 'Idempotency key reused with different command');
    const prior = store.db
      .prepare('SELECT command FROM runs WHERE chat_id=? AND request_key=?')
      .get(chatId, command.idempotencyKey) as { command: string } | undefined;
    let prepared:
      | {
          profile: ProfileSnapshot;
          selected: PackageStartSnapshot;
        }
      | undefined;
    let request: string;
    if (prior) {
      // A lost response reuses the already frozen dynamic request. Store still compares every
      // other canonical command field before returning the prior Run.
      request = text(record(JSON.parse(prior.command)).request, 'request', REQUEST_TEXT_MAX_CHARS);
    } else {
      const content = store.product.get<Content>(
        'content',
        command.packageId,
        command.packageRevision
      );
      if (!content.package) throw new HttpError(400, 'PACKAGE_START_REQUIRES_PACKAGE');
      const start = validatePackageStarts(content.package.starts ?? []).find(
        (item) => item.id === command.startId
      );
      if (!start) throw new HttpError(400, 'PACKAGE_START_NOT_FOUND');
      const chat = store.chat(chatId);
      const profile = chatVariableProfile(store, chatId);
      const attachment = profile?.packageAttachments?.find(
        (item) =>
          item.role === 'bot' &&
          item.id === command.packageId &&
          item.revision === command.packageRevision
      );
      if (!profile || !attachment || chat.botId !== command.packageId)
        throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
      const selected = resolvePackageStart(content.package!, ref.startId);
      prepared = { profile, selected };
      request = `[작성된 도입문] ${selected.title}`;
    }
    // Store applies the shared run/authored reservation phases after this callback's
    // optional initial action, inside the same transaction as an authored source commit.
    const result = store.createRunInTransaction(
      chatId,
      {
        request,
        expectedRevision: command.expectedRevision ?? null,
        ...(command.expectedSourceHash ? { expectedSourceHash: command.expectedSourceHash } : {}),
        expectedSettingsRevision: command.expectedSettingsRevision,
        expectedProfileRevision: command.expectedProfileRevision,
        idempotencyKey: command.idempotencyKey,
        packageStart: ref,
      },
      (chat) => {
        // Check after idempotency lookup. A lost successful response may replay even after the head advanced.
        if (command.expectedRevision) {
          if (!canChangePackageStart(store, chatId))
            throw new HttpError(409, 'PACKAGE_START_CONVERSATION_STARTED');
        } else if (store.db.prepare('SELECT 1 FROM runs WHERE chat_id=? LIMIT 1').get(chatId))
          throw new HttpError(409, 'PACKAGE_START_ALREADY_CONFIRMED');
        if (!prepared) throw new HttpError(409, 'PACKAGE_START_REPLAY_MISSING');
        const { profile, selected } = prepared;
        if (chat.botId !== command.packageId)
          throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
        const iso = new Date().toISOString();
        const snapshot: RunSnapshot = {
          chatId,
          parentRevision: null,
          ...(command.expectedRevision
            ? {
                replacement: {
                  sourceRevision: command.expectedRevision,
                  sourceHash: command.expectedSourceHash!,
                },
              }
            : {}),
          settingsRevision: chat.settingsRevision,
          settings: chat.settings,
          request,
          resources: store.product.resources(chatId, profile),
          history: [],
          profile,
          packageStart: selected,
          executionClock: { iso, unix: Math.floor(Date.parse(iso) / 1000) },
        };
        return snapshot;
      }
    );
    if (!result.created || result.run.snapshot.packageStart?.mode !== 'authored') return result;
    // No queue worker can observe an authored Run before its exact source commits.
    store.db
      .prepare("UPDATE runs SET status='running' WHERE id=? AND status='queued'")
      .run(result.run.id);
    store.completeRunInTransaction(result.run.id, result.run.snapshot.packageStart.text, {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
    return { run: store.run(result.run.id), created: true };
  });
}
