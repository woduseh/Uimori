import { behaviorPayloadHash } from './package-behavior-store.js';
import type { BackupRemap, BackupRow } from './chat-backup-remap.js';

/** Remap host ownership only; recorded expression inputs and outcomes remain historical facts. */
export function remapBackupBehavior(ctx: BackupRemap): void {
  const { tables, id } = ctx;
  const ownership = (value: BackupRow): BackupRow => ({
    ...value,
    chatId: id(value.chatId),
    branchId: id(value.branchId),
  });
  const dependencies = (value: { id: string; hash: string }[]) =>
    value.map((source) => ({ ...source, id: id(source.id) }));
  const journalKey = (key: string, provenance: string) => {
    const match = /^(run|source):([^:]+):([a-f0-9]{64})$/u.exec(key);
    if (
      !match ||
      (match[1] === 'run' && !['before-turn', 'model-tool'].includes(provenance)) ||
      (match[1] === 'source' && provenance !== 'local-output-parser')
    )
      return key;
    return `${match[1]}:${id(match[2])}:${match[3]}`;
  };
  for (const row of tables.package_behavior_states)
    row.scope = JSON.stringify(ownership(JSON.parse(row.scope)));
  for (const row of tables.package_behavior_journal) {
    const payload = JSON.parse(row.payload),
      result = JSON.parse(row.result),
      key = journalKey(row.idempotency_key, result.provenance);
    payload.scope = ownership(payload.scope);
    if (payload.previousScope) payload.previousScope = ownership(payload.previousScope);
    payload.idempotencyKey = key;
    row.idempotency_key = key;
    row.payload = JSON.stringify(payload);
    row.payload_hash = behaviorPayloadHash(payload);
    row.result = JSON.stringify({ ...ownership(result), idempotencyKey: key });
  }
  for (const row of tables.package_behavior_heads)
    row.dependencies = JSON.stringify(dependencies(JSON.parse(row.dependencies)));
  // Opportunity bodies, execution states and output bodies contain no current ownership IDs.
  // In particular, originEntropy is the original proof, and hostRuntime may be read by expressions.
  for (const row of tables.package_behavior_runs) {
    const progress = JSON.parse(row.body);
    progress.opportunityId = id(progress.opportunityId);
    row.body = JSON.stringify(progress);
  }
  for (const row of tables.package_requests) {
    const value = JSON.parse(row.body),
      beforeDependencies = JSON.parse(row.dependencies),
      afterDependencies = dependencies(beforeDependencies),
      current: BackupRow = {
        ...ownership(value),
        id: id(value.id),
        sourceRevision: id(value.sourceRevision),
      },
      origin = value.origin ?? {
        chatId: value.chatId,
        branchId: value.branchId,
        sourceRevision: value.sourceRevision,
        dependencies: beforeDependencies,
      };
    row.body = JSON.stringify({
      ...current,
      origin: {
        ...origin,
        identities: [
          { from: origin.chatId, to: current.chatId },
          { from: origin.branchId, to: current.branchId },
          ...origin.dependencies.map((source: { id: string }, index: number) => ({
            from: source.id,
            to: afterDependencies[index].id,
          })),
        ],
      },
    });
    row.dependencies = JSON.stringify(afterDependencies);
  }
  for (const row of tables.runs) {
    const snapshot = JSON.parse(row.snapshot),
      command = JSON.parse(row.command);
    if (snapshot.behaviorExecution) {
      snapshot.behaviorExecution.opportunityId = id(snapshot.behaviorExecution.opportunityId);
      row.snapshot = JSON.stringify(snapshot);
    }
    if (Object.hasOwn(command, 'packageRequestId')) {
      command.packageRequestId = id(command.packageRequestId);
      row.command = JSON.stringify(command);
    }
  }
}
