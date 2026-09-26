import { HttpError, fields, number, record, text } from './request-validation.js';
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
import { type ContentAttachment } from '../core/risu-content.js';

export type PackageStartCommand = PackageStartRef & {
  expectedSettingsRevision: number;
  expectedProfileRevision: number;
  idempotencyKey: string;
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
  ]);
  return {
    ...validatePackageStartRef({
      packageId: body.packageId,
      packageRevision: body.packageRevision,
      startId: body.startId,
    }),
    expectedSettingsRevision: number(body.expectedSettingsRevision, 'settings revision'),
    expectedProfileRevision: number(body.expectedProfileRevision, 'profile revision'),
    idempotencyKey: text(body.idempotencyKey, 'idempotency key', 120),
  };
}

function startText(snapshot: RunSnapshot): string {
  return snapshot.packageStart!.text;
}

/** Confirm a Risu greeting atomically without making a model request. */
export function createPackageStart(
  store: Store,
  chatId: string,
  value: unknown
): { run: Run; created: boolean } {
  const command = validatePackageStartCommand(value);
  const content = store.product.get<Content>('content', command.packageId, command.packageRevision);
  if (!content.package) throw new HttpError(400, 'PACKAGE_START_REQUIRES_PACKAGE');
  const start = validatePackageStarts(content.package.starts ?? []).find(
    (item) => item.id === command.startId
  );
  if (!start) throw new HttpError(400, 'PACKAGE_START_NOT_FOUND');
  const ref: PackageStartRef = {
    packageId: command.packageId,
    packageRevision: command.packageRevision,
    startId: command.startId,
  };
  return store.transaction(() => {
    const prior = store.db
      .prepare('SELECT command FROM runs WHERE chat_id=? AND request_key=?')
      .get(chatId, command.idempotencyKey) as { command: string } | undefined;
    let prepared:
      | {
          profile: ProfileSnapshot;
          attachment: ContentAttachment;
          selected: PackageStartSnapshot;
        }
      | undefined;
    let request: string;
    if (prior) {
      // A lost response reuses the already frozen dynamic request. Store still compares every
      // other canonical command field before returning the prior Run.
      request = text(record(JSON.parse(prior.command)).request, 'request', REQUEST_TEXT_MAX_CHARS);
    } else {
      const chat = store.chat(chatId);
      const profile = chatVariableProfile(store, chatId, store.product.branch(chatId).id);
      const attachment = profile?.packageAttachments?.find(
        (item) =>
          item.role === 'bot' &&
          item.id === command.packageId &&
          item.revision === command.packageRevision
      );
      if (!profile || !attachment || chat.botId !== command.packageId)
        throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
      const selected = resolvePackageStart(content.package!, command.startId);
      prepared = { profile, attachment, selected };
      request = `[작성된 도입문] ${selected.title}`;
    }
    // Store applies the shared run/authored reservation phases after this callback's
    // optional initial action, inside the same transaction as an authored source commit.
    const result = store.createRunInTransaction(
      chatId,
      {
        request,
        expectedRevision: null,
        expectedSettingsRevision: command.expectedSettingsRevision,
        expectedProfileRevision: command.expectedProfileRevision,
        idempotencyKey: command.idempotencyKey,
        packageStart: ref,
      },
      (chat) => {
        // Check after idempotency lookup. A lost successful response may replay even after the head advanced.
        if (store.db.prepare('SELECT 1 FROM runs WHERE chat_id=? LIMIT 1').get(chatId))
          throw new HttpError(409, 'PACKAGE_START_ALREADY_CONFIRMED');
        if (!prepared) throw new HttpError(409, 'PACKAGE_START_REPLAY_MISSING');
        const { profile, selected } = prepared;
        if (chat.botId !== command.packageId)
          throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
        const iso = new Date().toISOString();
        const snapshot: RunSnapshot = {
          chatId,
          parentRevision: null,
          branchId: `main:${chatId}`,
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
    store.completeRunInTransaction(
      result.run.id,
      startText(result.run.snapshot),
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      result.run.snapshot.settings
    );
    return { run: store.run(result.run.id), created: true };
  });
}
