import { validateHiddenStoryConfig } from './hidden-story.js';
import type { HiddenStorySelection } from './hidden-story-package.js';

export type PackageModuleRef = { id: string; revision: number };
export type PackageHiddenStory = HiddenStorySelection & { module: PackageModuleRef };
function reference(value: unknown): PackageModuleRef {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['id','revision'].includes(key))) throw new Error('PACKAGE_MODULE_REFERENCE');
  const ref = value as PackageModuleRef;
  if (typeof ref.id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/u.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('PACKAGE_MODULE_REFERENCE');
  return structuredClone(ref);
}
export function validatePackageModules(value: unknown): PackageModuleRef[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('PACKAGE_MODULE_LIMIT');
  const refs = value.map(reference);
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error('PACKAGE_MODULE_DUPLICATE');
  return refs;
}
export function validatePackageHiddenStory(value: unknown): PackageHiddenStory {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['module','config','insertion'].includes(key))) throw new Error('PACKAGE_HIDDEN_FIELDS');
  const selection = value as PackageHiddenStory;
  if (selection.insertion !== undefined && !['before-current','before-history'].includes(selection.insertion)) throw new Error('PACKAGE_HIDDEN_INSERTION');
  return { module: reference(selection.module), config: validateHiddenStoryConfig(selection.config), ...(selection.insertion ? { insertion: selection.insertion } : {}) };
}
