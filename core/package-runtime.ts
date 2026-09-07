import { compilePromptProgram, resolvePromptValues, type PromptControl, type PromptValue, type RuntimeValue } from './prompt-program.js';
import { ContentPackageError, validateContentPackage, validatePackageAttachment, type ContentPackage, type PackageAttachment, type PackageStateView, type PackageTarget, type PackageTransform } from './content-package.js';
import type { Resource } from './types.js';

export type CompiledPackageAttachment = {
  resources: Resource[]; pinned: Resource[]; instructions: { id: string; text: string; position?: string }[];
  controls: PromptControl[]; values: Record<string, PromptValue>; stateView?: PackageStateView; transforms: PackageTransform[];
};
/** Revision checks precede projection. No global library access or role-specific rewriting. */
export function compilePackageAttachment(value: ContentPackage, ref: PackageAttachment, context: { chatId: string; target: PackageTarget; values?: Record<string, PromptValue>; runtime?: Record<string, RuntimeValue>; slots?: Record<string,string>; resourcesOnly?: boolean }): CompiledPackageAttachment {
  const pkg = validateContentPackage(value), attachment = validatePackageAttachment(ref);
  if (pkg.id !== attachment.id || pkg.revision !== attachment.revision) throw new ContentPackageError('PACKAGE_REVISION_MISMATCH');
  if (!context.chatId || typeof context.chatId !== 'string') throw new ContentPackageError('PACKAGE_CHAT_REQUIRED');
  const prefix = `package:${pkg.id}:${attachment.role}`;
  const resource = (key: string, title: string, description: string, text: string, loading: 'pinned' | 'discoverable', sourceKind: string): Resource => ({ id: `${prefix}:${key}`, chatId: context.chatId, revision: pkg.revision, title, description, text, loading, sourceKind, kind: 'lore' });
  const resources = pkg.lore.map(lore => ({ ...resource(`lore:${lore.id}`, lore.title, lore.description, lore.text, lore.loading, 'lore'), ...(lore.relatedIds ? { relatedIds: lore.relatedIds.map(id => `${prefix}:lore:${id}`) } : {}) }));
  if (pkg.body !== undefined) resources.unshift(resource('body', pkg.title, pkg.description, pkg.body, 'pinned', attachment.role));
  if (pkg.identity) resources.unshift(resource('identity', pkg.identity.name, 'Identity description supplied by the package author.', pkg.identity.description, 'pinned', attachment.role));
  if (context.resourcesOnly) return { resources, pinned: resources.filter(r => r.loading === 'pinned'), instructions: [], controls: structuredClone(pkg.controls), values: resolvePromptValues({version:1,controls:pkg.controls,blocks:[]},context.values), stateView: pkg.stateView, transforms: structuredClone(pkg.transforms) };
  const selected = pkg.instructions.filter(n => n.target === context.target && (!n.attachmentRoles || n.attachmentRoles.includes(attachment.role)));
  const compilation = compilePromptProgram({ version: 1, controls: pkg.controls, blocks: [
    ...selected.map(n => ({ id: n.id, title: n.id, kind: 'message' as const, role: 'system' as const, template: n.template ?? [{ kind: 'text' as const, text: n.text }], ...(n.when === undefined ? {} : { when: n.when }) })),
    { id: '__package_current__', title: 'Runtime placeholder', kind: 'current' },
  ] }, { values: context.values, runtime: context.runtime, slots: context.slots ?? {}, history: [{ id: '__package_input__', role: 'user', text: '', current: true }] });
  const instructions = compilation.messages.filter(m => m.provenance.origin === 'prompt').map(m => ({ id: `${prefix}:instruction:${m.id}`, text: m.content.map(c => c.text).join(''), ...(selected.find(n=>n.id===m.provenance.blockId)?.position ? {position:selected.find(n=>n.id===m.provenance.blockId)!.position} : {}) }));
  const binding = pkg.roleBindings?.[attachment.role];
  if (binding !== undefined) instructions.unshift({ id: `${prefix}:binding`, text: binding });
  return { resources, pinned: resources.filter(r => r.loading === 'pinned'), instructions, controls: structuredClone(pkg.controls), values: compilation.values, ...(pkg.stateView ? { stateView: structuredClone(pkg.stateView) } : {}), transforms: structuredClone(pkg.transforms) };
}

export type PackageStateField = { key: string; label: string; text: string; missing: boolean };
/** Returns plain text descriptors, never HTML, arithmetic, mutations or executable templates. */
export function renderPackageStateView(view: PackageStateView, values: Record<string, unknown>): { title: string; fields: PackageStateField[] } {
  // Reuse the complete validator so standalone callers have the same limits.
  validateContentPackage({ version: 1, id: 'view', revision: 1, title: '', description: '', lore: [], instructions: [], controls: [], transforms: [], stateView: view });
  return { title: view.title, fields: view.fields.map(field => {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
    if (value === undefined || value === null) return { key: field.key, label: field.label, text: '—', missing: true };
    if (!['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new ContentPackageError('PACKAGE_STATE_VALUE', field.key);
    if (field.format === 'number' && typeof value !== 'number' || field.format === 'boolean' && typeof value !== 'boolean') throw new ContentPackageError('PACKAGE_STATE_TYPE', field.key);
    const text = `${String(value)}${field.suffix ?? ''}`;
    if (text.length > 16_384) throw new ContentPackageError('PACKAGE_STATE_VALUE_LIMIT', field.key);
    return { key: field.key, label: field.label, text, missing: false };
  }) };
}
