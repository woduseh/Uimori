import sharp from 'sharp';
import { JevError, type JevRequest } from './jev-judgment.js';

/** A small, upright still for judgment; the stored original is never rewritten. */
export async function prepareJevImage(
  bytes: Uint8Array
): Promise<NonNullable<JevRequest['assets']>[string]> {
  try {
    const jpeg = await sharp(bytes, { animated: false })
      .autoOrient()
      .resize({ width: 512, height: 512, fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, progressive: false })
      .toBuffer();
    return { type: 'image', format: 'jpeg', data_base64: jpeg.toString('base64') };
  } catch {
    throw new JevError('JEV_IMAGE_INVALID');
  }
}
