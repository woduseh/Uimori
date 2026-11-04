import type { ChatCopyState } from '../core/chat-backup.js';
import type { Store } from './store.js';
import { readImage } from './image-storage.js';
import { illustrationReferences, updateIllustrationReferences } from './illustrations.js';
import { fields, HttpError, record, text } from './request-validation.js';

type PortableReferences = NonNullable<ChatCopyState['illustrationReferences']>;

/** Referenced image bytes belong to the copy, not to the original chat's asset rows. */
export function captureIllustrationReferences(
  store: Store,
  chatId: string,
  binary: boolean
): PortableReferences | undefined {
  const { references, characterProfiles } = illustrationReferences(store, chatId);
  if (!references.length && !characterProfiles.length) return undefined;
  const used = new Set([
    ...references.map((item) => item.ref),
    ...characterProfiles.flatMap((item) => item.referenceRef ?? []),
  ]);
  const images = store.product
    .assets(chatId)
    .filter((item) => used.has(item.id))
    .map((item) => ({
      ref: item.id,
      title: item.title,
      description: item.description,
      actor: item.actor,
      outfit: item.outfit,
      location: item.location,
      allowedUse: item.allowedUse,
      mime: item.mime,
      base64: binary
        ? `archive:${item.hash}`
        : readImage(store.db, item.hash).bytes.toString('base64'),
    }));
  return { references, characterProfiles, images };
}

/** Imported packages get new identities; their image IDs and attachment roles stay stable. */
export function remapIllustrationPackageReferences(
  copy: PortableReferences,
  remap: Map<string, string>
): void {
  const ref = (value: string) => {
    const match = /^package:(.+):(bot|persona|module):([^:]+)$/u.exec(value);
    if (!match) return value;
    const nextId = remap.get(match[1]);
    return nextId ? `package:${nextId}:${match[2]}:${match[3]}` : value;
  };
  copy.references = copy.references.map((item) => ({ ...item, ref: ref(item.ref) }));
  copy.characterProfiles = copy.characterProfiles.map((item) => ({
    ...item,
    ...(item.referenceRef ? { referenceRef: ref(item.referenceRef) } : {}),
  }));
}

/** Check archive fields before processing embedded images; full reference validation occurs on save. */
export function checkedPortableIllustrationReferences(value: unknown): PortableReferences {
  const body = record(value);
  fields(body, ['references', 'characterProfiles', 'images']);
  if (
    !Array.isArray(body.references) ||
    body.references.length > 8 ||
    !Array.isArray(body.characterProfiles) ||
    body.characterProfiles.length > 32 ||
    !Array.isArray(body.images) ||
    body.images.length > 8
  )
    throw new HttpError(400, '삽화 참고 정보가 올바르지 않아요.');
  const used = new Set<string>();
  for (const raw of body.references) used.add(text(record(raw).ref, 'reference', 300));
  for (const raw of body.characterProfiles) {
    const profile = record(raw);
    if (profile.referenceRef !== undefined)
      used.add(text(profile.referenceRef, 'character reference', 300));
  }
  const seen = new Set<string>();
  for (const raw of body.images) {
    const image = record(raw);
    fields(image, [
      'ref',
      'title',
      'description',
      'actor',
      'outfit',
      'location',
      'allowedUse',
      'mime',
      'base64',
    ]);
    const ref = text(image.ref, 'reference', 300);
    if (!used.has(ref) || seen.has(ref))
      throw new HttpError(400, '삽화 참고 이미지가 올바르지 않아요.');
    seen.add(ref);
    text(image.title, 'image title', 200);
    text(image.description, 'image description', 2000, true);
    text(image.actor, 'image actor', 200, true);
    text(image.outfit, 'image outfit', 200, true);
    text(image.location, 'image location', 200, true);
    text(image.mime, 'image mime', 100);
    text(image.base64, 'image bytes', 90 * 1024 * 1024);
    if (!['profile', 'inline', 'both'].includes(image.allowedUse))
      throw new HttpError(400, '삽화 참고 이미지 사용 범위가 올바르지 않아요.');
  }
  return body as PortableReferences;
}

export function restoreIllustrationReferences(
  store: Store,
  chatId: string,
  raw: unknown,
  readBinary?: (reference: string) => Buffer
): void {
  const copy = checkedPortableIllustrationReferences(raw);
  const remap = new Map<string, string>();
  for (const image of copy.images) {
    const { ref, ...asset } = image;
    const base64 = image.base64.startsWith('archive:')
      ? readBinary?.(image.base64).toString('base64')
      : image.base64;
    if (!base64) throw new HttpError(400, '삽화 참고 이미지가 없어요.');
    const created = store.product.createAsset(chatId, { ...asset, base64 });
    remap.set(ref, created.id);
  }
  updateIllustrationReferences(
    store,
    chatId,
    {
      expectedRevision: 0,
      references: copy.references.map((item) => ({
        ...item,
        ref: remap.get(item.ref) ?? item.ref,
      })),
      characterProfiles: copy.characterProfiles.map((item) => ({
        ...item,
        ...(item.referenceRef
          ? { referenceRef: remap.get(item.referenceRef) ?? item.referenceRef }
          : {}),
      })),
    },
    { allowUnavailableReferences: true }
  );
}
