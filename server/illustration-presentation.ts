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
  return sourceHash && value.sourceHash !== sourceHash ? null : value;
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
export function newIllustrationPresentation(sourceHash: string): IllustrationPresentation {
  return { version: 1, revision: 0, sourceHash, heroTargetId: null, targets: {} };
}
export function illustrationDisplay(
  presentation: IllustrationPresentation | null,
  input: IllustrationJobInput
): IllustrationDisplay | undefined {
  const id = input.target?.id;
  if (!id || !presentation?.targets[id]) return;
  const target = presentation.targets[id];
  return {
    ...target,
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
/** Deleting a visible attempt can reveal an older successful image of the same target. */
export function forgetIllustrationJob(
  store: Store,
  sourceId: string,
  sourceHash: string,
  input: IllustrationJobInput,
  jobId: string
): void {
  const value = illustrationPresentation(store, sourceId, sourceHash);
  const id = input.target?.id;
  const target = id && value?.targets[id];
  if (!value || !id || !target) return;
  const remaining = store.db
    .prepare(`SELECT j.id,j.status,EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id) AS hasImage
    FROM illustration_jobs j WHERE source_revision=? AND source_hash=? AND json_extract(input,'$.target.id')=? AND id!=?
    ORDER BY created_at DESC,id DESC`)
    .all(sourceId, sourceHash, id, jobId);
  if (!remaining.length) {
    delete value.targets[id];
    if (value.heroTargetId === id) value.heroTargetId = null;
    if (value.translation) delete value.translation.afterByTarget[id];
  } else {
    if (target.latestRequestedJobId === jobId)
      target.latestRequestedJobId = String(remaining[0].id);
    if (target.displayedJobId === jobId)
      target.displayedJobId =
        (remaining.find((row) => row.status === 'completed' && row.hasImage)?.id as
          | string
          | undefined) ?? null;
  }
  saveIllustrationPresentation(store, sourceId, value);
}
