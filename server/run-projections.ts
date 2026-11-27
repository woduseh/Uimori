import { executionSnapshot } from './execution-snapshot.js';
import { translationSnapshot } from '../core/translation-context.js';
import type { Run, RunReceipt, RunSnapshot } from '../core/types.js';
import { prefersMinimal } from './endpoint.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export function readRunStatus(store: Pick<Store, 'db'>, id: string): Run['status'] {
  const row = store.db.prepare('SELECT status FROM runs WHERE id=?').get(id) as
    | { status: Run['status'] }
    | undefined;
  if (!row) throw new HttpError(404, 'Run not found');
  return row.status;
}

export function readRunState(
  store: Pick<Store, 'db'>,
  id: string
): Pick<Run, 'id' | 'chatId' | 'status' | 'request'> {
  const row = store.db
    .prepare('SELECT id,chat_id AS chatId,status,request FROM runs WHERE id=?')
    .get(id) as Pick<Run, 'id' | 'chatId' | 'status' | 'request'> | undefined;
  if (!row) throw new HttpError(404, 'Run not found');
  return row;
}

export function runResponse(prefer: unknown, run: Run): Run | RunReceipt {
  if (!prefersMinimal(prefer)) return run;
  const { snapshot: _snapshot, inputs: _inputs, toolEvents: _toolEvents, ...receipt } = run;
  return receipt;
}

export function readStoredRunSnapshot(store: Pick<Store, 'db'>, id: string): RunSnapshot {
  const row = store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(id) as
    | { snapshot: string }
    | undefined;
  if (!row) throw new HttpError(404, 'Run not found');
  return JSON.parse(row.snapshot) as RunSnapshot;
}

export function readRunSnapshot(store: Store, id: string): RunSnapshot {
  return executionSnapshot(store, readStoredRunSnapshot(store, id));
}

export function readTranslationSelection(store: Store, runId: string, input: unknown): RunSnapshot {
  const stored = readStoredRunSnapshot(store, runId);
  let snapshot = stored;
  if (stored.settled) {
    if (
      input &&
      typeof input === 'object' &&
      Object.hasOwn(input, 'translationModelSelection') &&
      Object.hasOwn(input, 'translationPrompt')
    ) {
      const { chatId, revision, image } = store.product.profile(stored.chatId);
      snapshot = {
        ...stored,
        profile: { chatId, revision, image, routes: { main: null, translation: null }, models: {} },
      };
    } else {
      snapshot = {
        ...stored,
        profile: store.product.snapshot(stored.chatId, 'inspect', stored.parentRevision),
      };
    }
  }
  return store.product.resolveJobPrompt(translationSnapshot(snapshot, 'source-only'), input);
}
