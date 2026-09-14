import type { ContentPackage } from '../core/content-package.js';
import type { NativeTransferFile } from '../core/native-transfer.js';
import { RISU_IMPORT_MAX_ASSETS, type RisuImportKind } from '../core/risu-import.js';
import { decodeImage } from './package-images.js';
import { HttpError } from './request-validation.js';
import { object, string, type RisuCard, type RisuCardAsset } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/**
 * Reads the images stored inside the file. Nothing is fetched: an asset that names a file the
 * container does not hold stays with the original. The asset URLs map every reference form Risu
 * text uses to the package image that replaces it.
 */
export function importRisuAssets({
  card,
  kind,
  members,
  findings,
}: {
  card: RisuCard;
  kind: RisuImportKind;
  members: Map<string, () => Buffer>;
  findings: RisuImportFindings;
}): {
  images: NativeTransferFile['images'];
  packageImages: NonNullable<ContentPackage['images']>;
  assetUrls: Map<string, string>;
  portraitImageId?: string;
} {
  const images: NativeTransferFile['images'] = [];
  const packageImages: NonNullable<ContentPackage['images']> = [];
  const assetUrls = new Map<string, string>();
  let portraitImageId: string | undefined;
  // A package image carries no role field, so a typed asset keeps only its bytes and its name.
  let typedAsset = false;
  const assets = Array.isArray(card.assets) ? card.assets : [];
  if (assets.length > RISU_IMPORT_MAX_ASSETS) throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  for (const [index, raw] of assets.entries()) {
    const asset = object(raw) as RisuCardAsset,
      uri = string(asset.uri),
      name = string(asset.name) || `이미지 ${index + 1}`;
    const path = uri.replace(/^(?:embeded|embedded):\/\//iu, '');
    const read = /^(?:embeded|embedded):\/\//iu.test(uri) ? members.get(path) : undefined;
    if (!read) {
      findings.add(
        'asset-unavailable',
        'unsupported',
        '파일 밖의 이미지나 찾을 수 없는 첨부 자료는 가져오지 않아요. 원본 파일에는 보존해요.'
      );
      continue;
    }
    const bytes = read();
    // Some cards retain a .png asset name after converting its bytes to WebP.
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
    if (!mime) {
      findings.add(
        'asset-format',
        'unsupported',
        'PNG·JPEG·WebP 이외의 첨부 자료는 아직 사용할 수 없어요.'
      );
      continue;
    }
    let image: ReturnType<typeof decodeImage>;
    try {
      image = decodeImage(mime, bytes.toString('base64'));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      findings.add(
        'asset-invalid',
        'unsupported',
        '형식이 맞지 않거나 2 MB를 넘는 이미지는 제외해요. 원본 파일에는 보존해요.'
      );
      continue;
    }
    if (!images.some((item) => item.hash === image.hash))
      images.push({
        id: image.hash,
        hash: image.hash,
        revision: 1,
        mime: image.mime,
        base64: image.bytes.toString('base64'),
      });
    const id = `image-${index}`;
    packageImages.push({
      id,
      title: name.slice(0, 200),
      description: '',
      blobHash: image.hash,
      mime: image.mime,
      allowedUse: 'both',
    });
    if (asset.type === 'emotion' || asset.type === 'background') typedAsset = true;
    if ((kind === 'bot' || asset.type === 'icon') && (!portraitImageId || name === 'main'))
      portraitImageId = id;
    const url = `/api/package-image-blobs/${image.hash}`;
    assetUrls.set(uri, url);
    assetUrls.set(`{{raw::${name}}}`, url);
    assetUrls.set(`{{image::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
    assetUrls.set(`{{img::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
  }
  if (typedAsset)
    findings.add(
      'asset-role',
      'info',
      '감정·배경으로 표시된 첨부는 역할 없이 일반 이미지로 가져와요. 이름은 그대로 두지만 어떤 감정이나 배경인지는 자료에 남기지 않아요.'
    );
  return { images, packageImages, assetUrls, ...(portraitImageId ? { portraitImageId } : {}) };
}
