import type { DatabaseSync } from 'node:sqlite';
import { sourceHash } from '../core/source-history.js';
import { projectStoryUiText } from '../core/story-ui.js';
import type { TranslationReference } from '../core/translation-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { validateTranslationArtifact } from './translation-artifacts.js';

type Identity = Pick<TranslationReference, 'id' | 'revision' | 'sourceRevision' | 'sourceHash'>;
type PinnedTranslation = { readers: number; removedResult?: string };
const pins = new WeakMap<DatabaseSync, Map<string, PinnedTranslation>>();

export function retainPrunedTranslation(db: DatabaseSync, id: string, result: string) {
  const pin = pins.get(db)?.get(id);
  if (pin) pin.removedResult = result;
}

export function captureTranslationReferences(
  store: Store,
  snapshot: Pick<RunSnapshot, 'chatId' | 'history'>
) {
  const history = snapshot.history.map((item) => [
    item.revision,
    item.contentHash ?? sourceHash(item.text),
  ]);
  const identities = history.length
    ? (store.db
        .prepare(`
    SELECT j.id, j.revision, j.source_revision AS sourceRevision, j.source_hash AS sourceHash
    FROM json_each(?) h JOIN sources s ON s.id=h.value->>0 AND s.chat_id=?
    JOIN jobs j ON j.id=(
      SELECT t.id FROM jobs t JOIN job_results r ON r.job_id=t.id
      WHERE t.source_revision=s.id AND t.kind='translation' AND t.status='completed'
        AND t.source_hash=h.value->>1
      ORDER BY t.revision DESC,t.created_at DESC,t.id DESC LIMIT 1
    )
    WHERE j.chat_id=s.chat_id AND h.value->>1=COALESCE(
      (SELECT e.hash FROM source_edits e WHERE e.source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash)
    ORDER BY h.key`)
        .all(JSON.stringify(history), snapshot.chatId) as Identity[])
    : [];
  const byId = new Map(identities.map((item) => [item.id, item]));
  const active = pins.get(store.db) ?? new Map<string, PinnedTranslation>();
  pins.set(store.db, active);
  for (const id of byId.keys()) {
    const pin = active.get(id);
    if (pin) pin.readers++;
    else active.set(id, { readers: 1 });
  }
  const references = new Map<string, TranslationReference | null>();
  const decode = (item: Identity, raw: string) => {
    try {
      const result = JSON.parse(raw);
      validateTranslationArtifact(
        { result, sourceHash: item.sourceHash },
        { id: item.sourceRevision, hash: item.sourceHash }
      );
      references.set(item.id, {
        ...item,
        text: projectStoryUiText(result.text),
        manual: result.manual === true,
      });
    } catch {
      references.set(item.id, null);
    }
  };
  return {
    count: identities.length,
    load(id?: string) {
      const selected =
        id === undefined ? identities : [byId.get(id)].filter((item) => item !== undefined);
      const unread: string[] = [];
      for (const item of selected) {
        if (references.has(item.id)) continue;
        const removed = active.get(item.id)?.removedResult;
        if (removed === undefined) unread.push(item.id);
        else decode(item, removed);
      }
      if (unread.length) {
        const rows = store.db
          .prepare(
            'SELECT job_id,result FROM job_results WHERE job_id IN (SELECT value FROM json_each(?))'
          )
          .iterate(JSON.stringify(unread));
        for (const row of rows) decode(byId.get(String(row.job_id))!, String(row.result));
      }
      return selected.flatMap((item) => references.get(item.id) ?? []);
    },
    [Symbol.dispose]() {
      for (const id of byId.keys()) {
        const pin = active.get(id)!;
        if (--pin.readers === 0) active.delete(id);
      }
      byId.clear();
      identities.length = 0;
      references.clear();
    },
  };
}
