import { HttpError, fields, number, record, text } from './request-validation.js';
import { isDeepStrictEqual } from 'node:util';
import type { Content, ProfileSnapshot } from '../core/product.js';
import type { Run, RunSnapshot, Source } from '../core/types.js';
import { packageInstanceId, executionContext } from '../core/execution-context.js';
import {
  GENERATED_PACKAGE_START_MAX_CHARS,
  resolvePackageStart,
  validatePackageStartRef,
  validatePackageStarts,
  type PackageStartRef,
  type PackageStartSnapshot,
} from '../core/package-start.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { projectRisuCompatReceipt } from '../core/risu-compat.js';
import { chatVariableProfile } from './chat-variable-context.js';
import type { Store } from './store.js';
import { packageControlKey, type PackageAttachment } from '../core/content-package.js';
import { freezePackageStates } from './package-behavior-host.js';
import type { BehaviorScope } from './package-behavior-store.js';

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

/**
 * The exact text an authored opening commits. `packageStart.text` stays the rendered selection the
 * archive compares, and a card that kept its Risu CBS commits the reservation's frozen evaluation of
 * the same field instead - the projection every other compilation of that field reads. A Run reserved
 * before the receipt existed has no entry and keeps committing the stored text.
 */
function startText(snapshot: RunSnapshot): string {
  const start = snapshot.packageStart!;
  const attachment = snapshot.profile?.packageAttachments?.find(
    (item) =>
      item.role === 'bot' && item.id === start.packageId && item.revision === start.packageRevision
  );
  const evaluated =
    snapshot.risuCompat && attachment
      ? projectRisuCompatReceipt(snapshot.risuCompat, attachment)[`start:${start.startId}`]
      : undefined;
  return evaluated ?? start.text;
}

/** Check authorship against immutable package/source records, never the current edited source. */
export function validateArchivedPackageStart(store: Store, run: Run, snapshot: RunSnapshot): void {
  const row = store.db.prepare('SELECT command FROM runs WHERE id=?').get(run.id) as {
    command: string;
  };
  const command = record(JSON.parse(row.command));
  if (snapshot.packageStart === undefined) {
    if (command.packageStart !== undefined)
      throw new HttpError(400, 'PACKAGE_START_ARCHIVE_MARKER_MISSING');
    return;
  }
  const marker = record(snapshot.packageStart);
  const ref = validatePackageStartRef({
    packageId: marker.packageId,
    packageRevision: marker.packageRevision,
    startId: marker.startId,
  });
  const profile = snapshot.profile;
  const attachment = profile?.packageAttachments?.find(
    (item) =>
      item.role === 'bot' && item.id === ref.packageId && item.revision === ref.packageRevision
  );
  if (
    !attachment ||
    !profile ||
    run.parentRevision !== null ||
    store.chat(run.chatId).botId !== ref.packageId
  )
    throw new HttpError(400, 'PACKAGE_START_ARCHIVE_OWNER_MISMATCH');
  const content = store.product.get<Content>('content', ref.packageId, ref.packageRevision);
  if (!content.package) throw new HttpError(400, 'PACKAGE_START_REQUIRES_PACKAGE');
  const values = profile.packageValues?.[packageControlKey(attachment)] ?? {};
  const expected = resolvePackageStart(
    content.package,
    ref.startId,
    values,
    packageIdentityFromProfile(profile)
  );
  if (!isDeepStrictEqual(marker, expected) || !isDeepStrictEqual(values, expected.values))
    throw new HttpError(400, 'PACKAGE_START_ARCHIVE_SELECTION_MISMATCH');
  if (command.packageStart !== undefined && !isDeepStrictEqual(command.packageStart, ref))
    throw new HttpError(400, 'PACKAGE_START_ARCHIVE_COMMAND_MISMATCH');
  const request =
    expected.mode === 'authored' ? `[작성된 도입문] ${expected.title}` : expected.text;
  if (run.request !== request) throw new HttpError(400, 'PACKAGE_START_ARCHIVE_REQUEST_MISMATCH');
  if (expected.mode === 'authored') {
    if (run.status !== 'completed' || !run.sourceRevision || snapshot.candidateOf)
      throw new HttpError(400, 'PACKAGE_START_ARCHIVE_AUTHORSHIP_MISMATCH');
    const original = store.sourceOriginal(run.sourceRevision);
    if (
      original.chatId !== run.chatId ||
      original.runId !== run.id ||
      original.text !== startText(snapshot)
    )
      throw new HttpError(400, 'PACKAGE_START_ARCHIVE_SOURCE_MISMATCH');
  }
}

/** Explicit confirmation only. Generated openings return a queued Run for the existing scheduler. */
export function createPackageStart(
  store: Store,
  chatId: string,
  value: unknown,
  validateGenerated?: (snapshot: RunSnapshot) => void
): { run: Run; created: boolean } {
  const command = validatePackageStartCommand(value);
  const content = store.product.get<Content>('content', command.packageId, command.packageRevision);
  if (!content.package) throw new HttpError(400, 'PACKAGE_START_REQUIRES_PACKAGE');
  const start = validatePackageStarts(content.package.starts ?? [], content.package).find(
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
          attachment: PackageAttachment;
          selected: PackageStartSnapshot;
        }
      | undefined;
    let request: string;
    if (prior) {
      // A lost response reuses the already frozen dynamic request. Store still compares every
      // other canonical command field before returning the prior Run.
      request = text(
        record(JSON.parse(prior.command)).request,
        'request',
        start.mode === 'generate' ? GENERATED_PACKAGE_START_MAX_CHARS : 4000
      );
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
      const selected = resolvePackageStart(
        content.package!,
        command.startId,
        profile.packageValues?.[packageControlKey(attachment)],
        packageIdentityFromProfile(profile)
      );
      const storedValues = profile.packageValues?.[packageControlKey(attachment)];
      if (
        Object.entries(selected.values).some(([key, v]) => !storedValues || storedValues[key] !== v)
      )
        throw new HttpError(409, 'PACKAGE_START_VALUES_NOT_SAVED');
      prepared = { profile, attachment, selected };
      request = selected.mode === 'authored' ? `[작성된 도입문] ${selected.title}` : selected.text;
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
        const { profile, attachment, selected } = prepared;
        if (chat.botId !== command.packageId)
          throw new HttpError(409, 'PACKAGE_START_OWNER_CHANGED');
        const iso = new Date().toISOString();
        let snapshot: RunSnapshot = {
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
        if (selected.mode !== 'authored') validateGenerated?.(snapshot);
        if (selected.initialAction) {
          const behavior = content.package!.behavior!;
          const scope: BehaviorScope = {
            chatId,
            branchId: `main:${chatId}`,
            attachmentInstanceId: packageInstanceId(attachment),
            packageId: attachment.id,
            packageRevision: attachment.revision,
            behaviorRevision: behavior.revision,
            schemaVersion: behavior.schemaVersion,
          };
          if (store.behavior.read(scope, behavior).stateRevision !== 0)
            throw new HttpError(409, 'PACKAGE_START_STATE_ALREADY_CHANGED');
          snapshot = freezePackageStates(store, snapshot, false);
          store.behavior.executeInTransaction(
            scope,
            behavior,
            {
              ...selected.initialAction,
              expectedStateRevision: 0,
              expectedSourceHash: null,
              idempotencyKey: `start:${command.idempotencyKey}`,
            },
            executionContext(snapshot, 'main', attachment)
          );
          store.event(chatId, 'package.start.initialized', scope.attachmentInstanceId);
        }
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

/** Bind explicitly confirmed state to the authored source; this is not a model output parse. */
export function completeAuthoredPackageStartStatesInTransaction(
  store: Store,
  run: Run,
  source: Source
): void {
  if (run.snapshot.packageStart?.mode !== 'authored')
    throw new HttpError(400, 'PACKAGE_START_AUTHORSHIP_REQUIRED');
  const branchId = run.snapshot.branchId ?? `main:${run.chatId}`;
  const dependencies = store
    .history(source.id)
    .map((item) => ({ id: item.revision, hash: store.source(item.revision).hash }));
  for (const frozen of run.snapshot.packageStates ?? []) {
    const pkg = run.snapshot.profile?.packages?.find(
      (item) => item.id === frozen.packageId && item.revision === frozen.packageRevision
    );
    if (!pkg?.behavior) throw new HttpError(409, 'PACKAGE_START_STATE_DEFINITION_MISSING');
    const scope: BehaviorScope = {
      chatId: run.chatId,
      branchId,
      attachmentInstanceId: frozen.instanceId,
      packageId: frozen.packageId,
      packageRevision: frozen.packageRevision,
      behaviorRevision: frozen.behaviorRevision,
      schemaVersion: frozen.schemaVersion,
    };
    const current = store.behavior.read(scope, pkg.behavior);
    if (
      current.stateRevision !== frozen.stateRevision ||
      JSON.stringify(current.state) !== JSON.stringify(frozen.state)
    )
      throw new HttpError(409, 'PACKAGE_START_STATE_CHANGED');
    store.db.prepare('INSERT INTO package_behavior_outputs VALUES(?,?,?)').run(
      source.id,
      frozen.instanceId,
      JSON.stringify({
        before: frozen,
        after: frozen,
        status: 'ready',
        error: null,
        sourceHash: source.hash,
      })
    );
    store.db
      .prepare(
        'INSERT INTO package_behavior_heads VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id,branch_id,instance_id) DO UPDATE SET dependencies=excluded.dependencies,status=excluded.status,error=excluded.error,draws=excluded.draws'
      )
      .run(
        run.chatId,
        branchId,
        frozen.instanceId,
        JSON.stringify(dependencies),
        'ready',
        null,
        JSON.stringify(frozen.draws)
      );
    store.event(run.chatId, 'package.start.state.bound', source.id);
  }
}
