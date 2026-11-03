import { message as uiMessage } from './i18n.js';
import { deleteRecoveryIfModel, readRecovery, writeRecovery } from './editor-recovery.js';
import { deleteHelperAttachmentRecovery } from './helper-attachment-draft.js';

// Keep the latest text across panel unmounts. The existing editor database owns disk storage.
const values = new Map<string, string | null>();
const writes = new Map<string, Promise<void>>();
const failedWrites = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;
const diskKey = (key: string) => `helper:${key}`;

export function subscribeHelperRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function helperRecoveryRevision(): number {
  return revision;
}
function notifyWrites() {
  revision++;
  for (const listener of listeners) listener();
}

export function failedHelperRecoveryKeys(id: string): string[] {
  return ['helper-input', 'helper-selection', 'helper-outline']
    .map((kind) => `${kind}:${id}`)
    .filter((key) => failedWrites.has(key));
}

export function cachedHelperRecovery(key: string): string | null | undefined {
  return values.get(key);
}

/** Read once per key; a user edit made during hydration always wins. */
export async function loadHelperRecovery(key: string): Promise<string | null> {
  if (values.has(key)) return values.get(key) ?? null;
  let stored: Awaited<ReturnType<typeof readRecovery<string>>>;
  try {
    stored = await readRecovery<string>(diskKey(key));
  } catch {
    throw new Error(uiMessage('helpers.m206'));
  }
  if (values.has(key)) return values.get(key) ?? null;
  values.set(key, stored?.model ?? null);
  return stored?.model ?? null;
}

/** Resolve every owner before editing any part of a conversation's recovered draft. */
export async function loadHelperSessionRecovery(id: string): Promise<void> {
  await Promise.all(
    ['helper-input', 'helper-outbox', 'helper-selection', 'helper-outline'].map((kind) =>
      loadHelperRecovery(`${kind}:${id}`)
    )
  );
}

/** Memory updates first; callers needing durable admission await the transaction. */
export function writeHelperRecovery(key: string, value: string | null): Promise<void> {
  values.set(key, value);
  const previous = writes.get(key) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(() =>
      writeRecovery(
        diskKey(key),
        value === null ? undefined : { revision: null, model: value, rawFields: {} }
      )
    );
  writes.set(key, write);
  void write.then(
    () => {
      if (writes.get(key) === write && failedWrites.delete(key)) notifyWrites();
    },
    () => {
      if (writes.get(key) === write && !failedWrites.has(key)) {
        failedWrites.add(key);
        notifyWrites();
      }
    }
  );
  return write;
}

/** Retry the latest in-memory value; later edits remain ordered after this write. */
export function retryHelperRecoveryWrite(key: string): Promise<void> {
  if (!values.has(key)) return Promise.reject(new Error(uiMessage('helpers.m206')));
  return writeHelperRecovery(key, values.get(key) ?? null);
}

/** Removal after admission must never erase a newer request for the same session. */
export async function clearHelperRecoveryIf(key: string, expected: string): Promise<void> {
  if (!values.has(key)) await loadHelperRecovery(key);
  if (values.get(key) !== expected) return;
  await writes.get(key)?.catch(() => {});
  if (values.get(key) !== expected) return;
  let remaining: Awaited<ReturnType<typeof deleteRecoveryIfModel<string>>>;
  try {
    remaining = await deleteRecoveryIfModel(diskKey(key), expected);
  } catch (cause) {
    // The server already accepted this exact request; do not resurrect it on panel navigation.
    if (values.get(key) === expected) {
      values.set(key, null);
      if (failedWrites.delete(key)) notifyWrites();
    }
    throw cause;
  }
  if (values.get(key) === expected) {
    values.set(key, remaining?.model ?? null);
    if (failedWrites.delete(key)) notifyWrites();
  }
}

export async function deleteHelperSessionRecovery(id: string): Promise<void> {
  await deleteHelperAttachmentRecovery(id);
  const artifactIndex = `helper-artifacts:${id}`;
  const artifactKeys = JSON.parse((await loadHelperRecovery(artifactIndex)) ?? '[]') as string[];
  await Promise.all(
    [
      ...['helper-input', 'helper-outbox', 'helper-selection', 'helper-outline'].map(
        (kind) => `${kind}:${id}`
      ),
      ...artifactKeys,
      artifactIndex,
    ].map(async (key) => {
      await writeHelperRecovery(key, null);
    })
  );
}
