import { createHash, randomUUID } from 'node:crypto';
import { splitSource, type SourceBlock } from '../core/auxiliary.js';
import type { PortableIllustration, PortableIllustrationAnchor } from '../core/chat-backup.js';
import type { IllustrationJobInput } from '../core/illustration.js';
import { illustrationTargetSet, type IllustrationTarget } from '../core/illustration-storyboard.js';
import type { Store } from './store.js';
import {
  illustrationPresentation,
  newIllustrationPresentation,
  saveIllustrationPresentation,
} from './illustration-presentation.js';
import { successfulTranslation } from './translation-artifacts.js';
import { storeImage } from './image-storage.js';
import { HttpError } from './request-validation.js';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const portableAnchor = (
  blocks: SourceBlock[],
  anchor: string
): PortableIllustrationAnchor | undefined => {
  const block = blocks.find((item) => item.anchor === anchor);
  return block ? { index: block.index, textHash: hash(block.text) } : undefined;
};
const restoredAnchor = (
  blocks: SourceBlock[],
  position?: PortableIllustrationAnchor
): string | undefined => {
  if (!position || !Number.isSafeInteger(position.index) || position.index < 0) return;
  const block = blocks[position.index];
  return block && hash(block.text) === position.textHash ? block.anchor : undefined;
};

/** Capture the displayed result, including the old successful image during a new render. */
export function captureIllustrations(
  store: Store,
  history: { revision: string }[],
  binary = false
): PortableIllustration[] {
  const result: PortableIllustration[] = [];
  for (const [entry, reference] of history.entries()) {
    const source = store.source(reference.revision);
    const blocks = splitSource(source);
    const presentation = illustrationPresentation(store, source.id, source.hash);
    const translation = successfulTranslation(store, source);
    const rows = store.db
      .prepare(`SELECT j.id,j.source_hash,j.input,i.position,i.mime,i.body,i.hash${binary ? '' : ',b.bytes'} FROM illustration_jobs j
      JOIN illustration_images i ON i.job_id=j.id JOIN image_blobs b ON b.hash=i.hash
      WHERE j.source_revision=? AND j.status='completed' ORDER BY j.created_at,j.id,i.position`)
      .all(source.id);
    for (const row of rows) {
      const input = JSON.parse(String(row.input)) as IllustrationJobInput;
      const target = input.target;
      const selected = target && presentation?.targets[target.id];
      if (selected && selected.displayedJobId !== row.id) continue;
      const body = JSON.parse(String(row.body));
      const stale = row.source_hash !== source.hash;
      const start = target && !stale ? portableAnchor(blocks, target.startAnchor) : undefined;
      const end = target && !stale ? portableAnchor(blocks, target.endAnchor) : undefined;
      const mapped = target && presentation?.translation;
      const translatedAnchor =
        mapped && translation?.translationLayout?.textHash === mapped.target.textHash
          ? mapped.afterByTarget[target.id]
          : null;
      const after = translatedAnchor
        ? portableAnchor(translation!.translationLayout!.blocks, translatedAnchor)
        : undefined;
      result.push({
        entry,
        group: String(row.id),
        position: Number(row.position),
        mime: row.mime as 'image/webp',
        base64: binary
          ? `archive:${String(row.hash)}`
          : Buffer.from(row.bytes as Uint8Array).toString('base64'),
        title: String(body.caption ?? ''),
        ...(body.width && body.height ? { width: body.width, height: body.height } : {}),
        ...(stale ? { stale: true, sourceHash: String(row.source_hash) } : {}),
        ...(target && start && end
          ? {
              target: {
                focus: target.focus,
                start,
                end,
                hero: presentation?.heroTargetId === target.id,
              },
            }
          : {}),
        ...(after && mapped ? { translation: { textHash: mapped.target.textHash, after } } : {}),
      });
    }
  }
  return result;
}

/** Portable anchors describe text, not an old source UUID. Unverifiable positions stay supplemental. */
export function restoreIllustrations(
  store: Store,
  history: { revision: string }[],
  images: PortableIllustration[],
  readBinary?: (reference: string) => Buffer
): void {
  const groups = new Map<string, PortableIllustration[]>();
  for (const [index, image] of images.entries()) {
    if (
      !Number.isSafeInteger(image.entry) ||
      image.entry < 0 ||
      !history[image.entry] ||
      typeof image.title !== 'string'
    )
      throw new HttpError(400, '삽화의 메시지 정보가 올바르지 않아요.');
    const key = `${image.entry}:${image.group ?? `legacy-${index}`}`;
    const list = groups.get(key) ?? [];
    list.push(image);
    groups.set(key, list);
  }
  const restoredTargets = new Map<string, IllustrationTarget[]>();
  for (const group of groups.values()) {
    group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const first = group[0];
    const source = store.source(history[first.entry].revision);
    const blocks = splitSource(source);
    const startAnchor = restoredAnchor(blocks, first.target?.start);
    const endAnchor = restoredAnchor(blocks, first.target?.end);
    const target: IllustrationTarget | undefined =
      !first.stale &&
      first.target &&
      typeof first.target.focus === 'string' &&
      startAnchor &&
      endAnchor &&
      first.target.start.index <= first.target.end.index
        ? {
            id: randomUUID(),
            order: first.target.end.index,
            focus: first.target.focus,
            visualBrief: first.target.focus,
            startAnchor,
            endAnchor,
          }
        : undefined;
    const sourceHash =
      first.stale &&
      typeof first.sourceHash === 'string' &&
      /^[a-f0-9]{64}$/u.test(first.sourceHash)
        ? first.sourceHash
        : source.hash;
    const id = randomUUID(),
      time = new Date().toISOString();
    store.db
      .prepare(`INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,attempt,input,created_at,updated_at)
      VALUES(?,?,?,?,'manual','completed',1,1,?,?,?)`)
      .run(
        id,
        source.chatId,
        source.id,
        sourceHash,
        JSON.stringify({
          version: 1,
          task: 'render',
          generator: 'none',
          settingsRevision: 1,
          styleGuidance: '',
          maxAutoRetries: 0,
          ...(target ? { target } : {}),
        }),
        time,
        time
      );
    for (const [position, image] of group.entries()) {
      const bytes = readBinary ? readBinary(image.base64) : Buffer.from(image.base64, 'base64');
      const imageHash = hash(bytes);
      storeImage(store.db, { hash: imageHash, mime: image.mime, bytes });
      store.db
        .prepare(
          'INSERT INTO illustration_images(id,job_id,chat_id,position,mime,hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(
          randomUUID(),
          id,
          source.chatId,
          position,
          image.mime,
          imageHash,
          JSON.stringify({
            caption: image.title,
            ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
          }),
          time
        );
    }
    if (!target) continue;
    const presentation =
      illustrationPresentation(store, source.id, source.hash) ??
      newIllustrationPresentation(source.hash);
    presentation.targets[target.id] = { latestRequestedJobId: id, displayedJobId: id };
    if (first.target?.hero && !presentation.heroTargetId) presentation.heroTargetId = target.id;
    const targets = restoredTargets.get(source.id) ?? [];
    targets.push(target);
    restoredTargets.set(source.id, targets);
    const translation = successfulTranslation(store, source);
    const after =
      first.translation && translation?.translationLayout?.textHash === first.translation.textHash
        ? restoredAnchor(translation.translationLayout.blocks, first.translation.after)
        : undefined;
    if (after && translation?.translationLayout) {
      presentation.translation ??= {
        target: {
          mode: 'translation',
          textHash: translation.translationLayout.textHash,
          translationJobId: translation.id,
          translationRevision: translation.revision ?? 1,
        },
        targetSetHash: '',
        afterByTarget: {},
      };
      presentation.translation.afterByTarget[target.id] = after;
    }
    saveIllustrationPresentation(store, source.id, presentation);
  }
  for (const [sourceId, targets] of restoredTargets) {
    const presentation = illustrationPresentation(store, sourceId)!;
    if (!presentation.translation) continue;
    presentation.translation.targetSetHash = illustrationTargetSet(targets).hash;
    for (const target of targets) presentation.translation.afterByTarget[target.id] ??= null;
    saveIllustrationPresentation(store, sourceId, presentation);
  }
}
