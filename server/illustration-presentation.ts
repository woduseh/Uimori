import type { Store } from './store.js';
import type {
  IllustrationDisplay,
  IllustrationPresentation,
} from '../core/illustration-storyboard.js';
import type { IllustrationJobInput } from '../core/illustration.js';
import { HttpError } from './request-validation.js';

export const illustrationPresentationKey = (sourceId: string) =>
  `illustration-presentation:${sourceId}`;
export function illustrationPresentation(
  store: Store,
  sourceId: string,
  sourceHash?: string
): IllustrationPresentation | null {
  const row = store.db
    .prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(illustrationPresentationKey(sourceId));
  if (!row) return null;
  const value = JSON.parse(String(row.value)) as IllustrationPresentation;
  if (!sourceHash || value.sourceHash === sourceHash) return value;
  // An edit may restore a text hash with verified placements from an earlier revision.
  if (
    Object.values(value.detached ?? {}).some((entry) => entry.sourceHash === sourceHash) &&
    store.source(sourceId).hash === sourceHash
  )
    return newIllustrationPresentation(sourceHash, value);
  return null;
}
export function saveIllustrationPresentation(
  store: Store,
  sourceId: string,
  value: IllustrationPresentation
): void {
  value.revision++;
  store.db
    .prepare(
      'INSERT INTO app_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    .run(illustrationPresentationKey(sourceId), JSON.stringify(value));
  store.event(store.source(sourceId).chatId, 'illustration-layout.updated', sourceId);
}
export function newIllustrationPresentation(
  sourceHash: string,
  previous?: IllustrationPresentation | null
): IllustrationPresentation {
  const value: IllustrationPresentation = {
    version: 1,
    revision: previous?.revision ?? 0,
    sourceHash,
    heroTargetId: null,
    targets: {},
  };
  const detached = { ...previous?.detached };
  if (previous)
    for (const [id, entry] of Object.entries(previous.targets)) {
      if (entry.placedTarget)
        detached[id] = {
          ...entry,
          placedTarget: entry.placedTarget,
          sourceHash: previous.sourceHash,
        };
    }
  for (const [id, entry] of Object.entries(detached)) {
    if (entry.sourceHash === sourceHash) {
      const { sourceHash: _hash, ...target } = entry;
      value.targets[id] = target;
    } else (value.detached ??= {})[id] = entry;
  }
  return value;
}
export function illustrationDisplay(
  presentation: IllustrationPresentation | null,
  id?: string
): IllustrationDisplay | undefined {
  if (!id || !presentation) return;
  const target = presentation.targets[id] ?? presentation.detached?.[id];
  if (!target) return;
  return {
    latestRequestedJobId: target.latestRequestedJobId,
    displayedJobId: target.displayedJobId,
    revision: presentation.revision,
    hero: presentation.heroTargetId === id,
    ...(presentation.translation && Object.hasOwn(presentation.translation.afterByTarget, id)
      ? {
          translation: {
            textHash: presentation.translation.target.textHash,
            afterAnchor: presentation.translation.afterByTarget[id],
          },
        }
      : {}),
  };
}
/** A late result may be saved as history, but cannot replace a newer request's selection. */
export function selectCompletedIllustration(
  store: Store,
  sourceId: string,
  sourceHash: string,
  input: IllustrationJobInput,
  jobId: string
): void {
  const presentation = illustrationPresentation(store, sourceId, sourceHash);
  const target = input.target && presentation?.targets[input.target.id];
  if (!presentation || !target || target.latestRequestedJobId !== jobId) return;
  target.displayedJobId = jobId;
  saveIllustrationPresentation(store, sourceId, presentation);
}
export function selectRequestedIllustration(
  store: Store,
  sourceId: string,
  sourceHash: string,
  input: IllustrationJobInput,
  jobId: string
): void {
  const presentation = illustrationPresentation(store, sourceId, sourceHash);
  const target = input.target && presentation?.targets[input.target.id];
  if (!presentation || !target) return;
  target.latestRequestedJobId = jobId;
  saveIllustrationPresentation(store, sourceId, presentation);
}
export function changeIllustrationHero(
  store: Store,
  sourceId: string,
  expectedHash: string,
  expectedRevision: number,
  targetId: string | null
): IllustrationPresentation {
  return store.transaction(() => {
    const source = store.source(sourceId);
    const value = illustrationPresentation(store, sourceId, expectedHash);
    if (source.hash !== expectedHash || !value)
      throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
    if (value.revision !== expectedRevision)
      throw new HttpError(409, 'ILLUSTRATION_PRESENTATION_CHANGED');
    if (targetId !== null && !value.targets[targetId])
      throw new HttpError(400, 'ILLUSTRATION_TARGET_UNAVAILABLE');
    value.heroTargetId = targetId;
    saveIllustrationPresentation(store, sourceId, value);
    return value;
  });
}
/** All attempts of a cut are removed together, across its explicitly updated placements. */
export function forgetIllustrationTarget(store: Store, sourceId: string, targetId: string): void {
  const value = illustrationPresentation(store, sourceId);
  if (!value || (!value.targets[targetId] && !value.detached?.[targetId])) return;
  delete value.targets[targetId];
  if (value.detached) delete value.detached[targetId];
  if (value.heroTargetId === targetId) value.heroTargetId = null;
  if (value.translation) delete value.translation.afterByTarget[targetId];
  saveIllustrationPresentation(store, sourceId, value);
}
