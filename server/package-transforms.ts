import {
  ContentPackageError,
  validatePackageTransform,
  type PackageTransform,
} from '../core/content-package.js';
import { TextTransformError, type TextTransformResult } from '../core/text-transform.js';
import { applyTextTransforms } from './text-transforms.js';
export type PackageTransformResult = TextTransformResult;
/** Compatibility facade: package presentation and prompt projections share one bounded worker. */
export async function applyPackageTransforms(
  text: string,
  rules: readonly PackageTransform[],
  target: 'source' | 'translation',
  options: { timeoutMs?: number } = {}
): Promise<PackageTransformResult> {
  if (typeof text !== 'string' || text.length > 1_000_000)
    throw new ContentPackageError('PACKAGE_TRANSFORM_INPUT_LIMIT');
  if (!Array.isArray(rules) || rules.length > 32)
    throw new ContentPackageError('PACKAGE_TRANSFORM_RULE_LIMIT');
  if (target !== 'source' && target !== 'translation')
    throw new ContentPackageError('PACKAGE_TRANSFORM_TARGET');
  const selected = rules.map(validatePackageTransform).filter((rule) => rule.target === target);
  try {
    return await applyTextTransforms(text, selected, options);
  } catch (error) {
    if (error instanceof TextTransformError)
      throw new ContentPackageError(error.code.replace(/^TEXT_/, 'PACKAGE_'), error.itemId);
    throw error;
  }
}
