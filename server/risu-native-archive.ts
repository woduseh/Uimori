import type { RunSnapshot } from '../core/types.js';
import type { NativeRisuMessage } from '../core/risu-native-execution.js';
import { nativeRisuInputHash } from './risu-native-run.js';

/** Only host message identities are references. Text, variables and wire receipts stay exact. */
export function mapNativeMessageId(id: string, source: (id: string) => string): string {
  const match = /^(request|source):(.+)$/u.exec(id);
  if (match) return `${match[1]}:${source(match[2]!)}`;
  const native = /^native:(.+):(\d+)$/u.exec(id);
  return native ? `native:${source(native[1]!)}:${native[2]}` : id;
}

/** Call after all snapshot ownership/source references are remapped, before recompilation. */
export function remapNativeRisuSnapshot(
  snapshot: RunSnapshot,
  source: (id: string) => string,
  run: (id: string) => string
): void {
  const messages = (items: NativeRisuMessage[]) =>
    items.map((message) => ({
      ...message,
      ...(message.id ? { id: mapNativeMessageId(message.id, source) } : {}),
    }));
  const receipt = snapshot.nativeRisuExecution;
  if (receipt) {
    receipt.messages = messages(receipt.messages);
    if (receipt.preRequest) receipt.preRequest.messages = messages(receipt.preRequest.messages);
    if (receipt.output) receipt.output.messages = messages(receipt.output.messages);
    receipt.history = receipt.history.map((message) => ({
      ...message,
      id: mapNativeMessageId(message.id, source),
      ...(message.sourceRevision ? { sourceRevision: source(message.sourceRevision) } : {}),
      ...(message.runId ? { runId: run(message.runId) } : {}),
    }));
    // requestEdits records an already-sent prompt. Its provenance and hash belong to that
    // original execution, like model_inputs, and must not become a new request to replay.
    receipt.inputHash = nativeRisuInputHash(snapshot);
  }
  if (snapshot.nativeRisuAuthored)
    snapshot.nativeRisuAuthored.messages = messages(snapshot.nativeRisuAuthored.messages);
}

/** Candidates reuse the prepared input, then execute their own request/output callbacks. */
export function resetNativeRisuCandidate(snapshot: RunSnapshot): void {
  const receipt = snapshot.nativeRisuExecution;
  if (!receipt) return;
  if (!receipt.preRequest && receipt.requestEdits?.length)
    throw new Error('RISU_NATIVE_CANDIDATE_INPUT_MISSING');
  if (receipt.preRequest) {
    receipt.variables = structuredClone(receipt.preRequest.variables);
    receipt.messages = structuredClone(receipt.preRequest.messages);
    if (receipt.preRequest.historyRevision)
      receipt.historyRevision = receipt.preRequest.historyRevision;
    else delete receipt.historyRevision;
  }
  delete receipt.output;
  delete receipt.requestEdits;
}
