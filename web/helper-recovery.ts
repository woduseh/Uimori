import { deleteRecoveryIfModel, readRecovery, writeRecovery } from './editor-recovery.js';

// Keep the latest text across panel unmounts. The existing editor database owns disk storage.
const values = new Map<string, string | null>();
const writes = new Map<string, Promise<void>>();
const registrations = new Map<string, Promise<void>>();
const diskKey = (key: string) => `helper:${key}`;

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
    throw new Error('복구 저장소를 읽지 못했어요.');
  }
  if (values.has(key)) return values.get(key) ?? null;
  values.set(key, stored?.model ?? null);
  return stored?.model ?? null;
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
  return write;
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
    if (values.get(key) === expected) values.set(key, null);
    throw cause;
  }
  if (values.get(key) === expected) values.set(key, remaining?.model ?? null);
}

export async function deleteHelperSessionRecovery(id: string): Promise<void> {
  const artifactIndex = `helper-artifacts:${id}`;
  await registrations.get(artifactIndex)?.catch(() => {});
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

export async function registerHelperArtifactRecovery(
  sessionId: string,
  key: string
): Promise<void> {
  const indexKey = `helper-artifacts:${sessionId}`;
  const next = (registrations.get(indexKey) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const old = JSON.parse((await loadHelperRecovery(indexKey)) ?? '[]') as string[];
      if (!old.includes(key)) await writeHelperRecovery(indexKey, JSON.stringify([...old, key]));
    });
  registrations.set(indexKey, next);
  await next;
}
