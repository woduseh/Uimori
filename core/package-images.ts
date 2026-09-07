import type { ProfileSnapshot, Asset } from './product.js';

export const PACKAGE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PackageImage = { id: string; title: string; description: string; blobHash: string; mime: typeof PACKAGE_IMAGE_MIMES[number]; allowedUse: 'profile' | 'inline' | 'both' };
const identifier = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u;
export function validatePackageImages(value: unknown): PackageImage[] {
  if (!Array.isArray(value) || value.length > 2000) throw new Error('PACKAGE_IMAGE_LIST_LIMIT');
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id','title','description','blobHash','mime','allowedUse'].includes(key))) throw new Error('PACKAGE_IMAGE_FIELDS');
    const image = item as PackageImage;
    if (typeof image.id !== "string" || !identifier.test(image.id) || ids.has(image.id) || typeof image.title !== 'string' || !image.title.trim() || image.title.length > 200 || typeof image.description !== 'string' || image.description.length > 2000 || typeof image.blobHash !== 'string' || !/^[a-f0-9]{64}$/u.test(image.blobHash) || !PACKAGE_IMAGE_MIMES.includes(image.mime) || !['profile','inline','both'].includes(image.allowedUse)) throw new Error('PACKAGE_IMAGE_INVALID');
    ids.add(image.id);
  }
  return structuredClone(value);
}

/** Only immutable, explicitly attached package revisions enter the catalog. */
export function packageImages(profile: Pick<ProfileSnapshot, 'chatId' | 'packages' | 'packageAttachments'>): Asset[] {
  return (profile.packageAttachments ?? []).flatMap(attachment => {
    const pkg = profile.packages?.find(item => item.id === attachment.id && item.revision === attachment.revision);
    if (!pkg) throw new Error('PACKAGE_IMAGE_REVISION_MISSING');
    return validatePackageImages(pkg.images ?? []).map(image => ({
      id: `package:${pkg.id}:${attachment.role}:${image.id}`, chatId: profile.chatId, revision: pkg.revision,
      title: image.title, description: image.description, hash: image.blobHash, mime: image.mime,
      actor: '', outfit: '', location: '', allowedUse: image.allowedUse, url: `/api/package-image-blobs/${image.blobHash}`,
      packageOwner: { id: pkg.id, revision: pkg.revision, role: attachment.role, title: pkg.title, imageId: image.id },
    }));
  });
}
