import { isDeepStrictEqual } from 'node:util';
import type { ChatVariableMutation } from '../core/chat-variables.js';
import { packageInstanceId } from '../core/execution-context.js';
import { risuCompatKey, risuCompatWrites, type RisuCompatReceipt } from '../core/risu-compat.js';
import { readChatVariables } from './chat-variables.js';
import {
  adoptExtensionVariableMutation,
  chatVariableStateHash,
  hasExtensionVariableWriteGrant,
  projectExtensionVariableMutation,
  variableStateFromProfile,
} from './extension-variables.js';
import type { Run, Source, Store } from './store.js';

/**
 * The branch shared variables one completed Run's preserved Risu CBS wrote. The evaluation itself is
 * frozen at reservation, so this only adopts what the receipt already recorded: nothing is evaluated
 * again, and nothing here may fail the source save - every refusal drops the writes whole and leaves
 * an event behind instead. Runs the caller replays (candidates, forks, archive restores) adopt under
 * their own run id on their own branch, so no write is applied twice.
 */
export function commitRunCompatVariables(store: Store, run: Run, source: Source): void {
  const receipt = run.snapshot.risuCompat;
  const profile = run.snapshot.profile;
  if (!receipt || !profile || !risuCompatWrites(receipt).length) return;
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  const branch = store.product.branch(run.chatId, run.snapshot.branchId);
  // The evaluation read the variables the reservation froze. Anything that moved the branch since -
  // the user's own edit, another run, this run's own behavior adoption - leaves those reads behind,
  // so the writes are dropped rather than applied over a value they never saw.
  const before = variableStateFromProfile(profile);
  if (!isDeepStrictEqual(readChatVariables(store, run.chatId, branch.id), before)) {
    store.event(run.chatId, 'risu.compat.variables.stale', run.id);
    return;
  }
  const admitted: RisuCompatReceipt = { version: 1, entries: [] };
  for (const attachment of profile.packageAttachments ?? []) {
    const prefix = risuCompatKey(attachment, '');
    const entries = receipt.entries.filter(
      (entry) => entry.key.startsWith(prefix) && entry.writes?.length
    );
    if (!entries.length) continue;
    if (!hasExtensionVariableWriteGrant(store, profile, attachment)) {
      store.event(run.chatId, 'risu.compat.variables.skipped', packageInstanceId(attachment));
      continue;
    }
    admitted.entries.push(...entries);
  }
  const changes: Record<string, string> = {};
  for (const write of risuCompatWrites(admitted)) changes[write.key] = write.value;
  if (!Object.keys(changes).length) return;
  const mutation: ChatVariableMutation = {
    beforeRevision: before.revision,
    beforeHash: chatVariableStateHash(before),
    changes,
  };
  // The projection owns the key, value and total-size rules the chat variable writer applies, so a
  // card that wrote past them is refused here rather than inside the source transaction's writer.
  try {
    projectExtensionVariableMutation(before, mutation);
  } catch {
    store.event(run.chatId, 'risu.compat.variables.rejected', run.id);
    return;
  }
  store.db.exec('SAVEPOINT risu_compat_variables');
  try {
    adoptExtensionVariableMutation(
      store,
      run.chatId,
      branch.id,
      source.hash,
      `run:${run.id}:risu-compat`,
      mutation
    );
    store.db.exec('RELEASE risu_compat_variables');
  } catch {
    store.db.exec('ROLLBACK TO risu_compat_variables; RELEASE risu_compat_variables');
    store.event(run.chatId, 'risu.compat.variables.rejected', run.id);
  }
}
