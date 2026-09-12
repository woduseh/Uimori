import {
  compilePromptProgram,
  resolvePromptValues,
  PromptProgramError,
  type PromptControl,
  type PromptValue,
  type RuntimeValue,
} from './prompt-program.js';
import {
  ContentPackageError,
  validateContentPackage,
  validatePackageAttachment,
  type ContentPackage,
  type PackageAttachment,
  type PackageStateView,
  type PackageTarget,
  type PackageTransform,
} from './content-package.js';
import type { Resource } from './types.js';
import { PromptBudget, PromptEvaluationError } from './prompt-values.js';

export type CompiledPackageAttachment = {
  unavailableInstructions?: { id: string; code: string }[];
  resources: Resource[];
  pinned: Resource[];
  instructions: { id: string; text: string; position?: string }[];
  controls: PromptControl[];
  values: Record<string, PromptValue>;
  stateView?: PackageStateView;
  transforms: PackageTransform[];
};
/** Revision checks precede projection. No global library access or role-specific rewriting. */
export function compilePackageAttachment(
  value: ContentPackage,
  ref: PackageAttachment,
  context: {
    chatId: string;
    target: PackageTarget;
    values?: Record<string, PromptValue>;
    runtime?: Record<string, RuntimeValue>;
    slots?: Record<string, string>;
    resourcesOnly?: boolean;
    behaviorUnavailable?: string;
    /** Host-only shared budget for all optional instruction evaluations. */
    budget?: PromptBudget;
  }
): CompiledPackageAttachment {
  const pkg = validateContentPackage(value),
    attachment = validatePackageAttachment(ref);
  if (pkg.id !== attachment.id || pkg.revision !== attachment.revision)
    throw new ContentPackageError('PACKAGE_REVISION_MISMATCH');
  if (!context.chatId || typeof context.chatId !== 'string')
    throw new ContentPackageError('PACKAGE_CHAT_REQUIRED');
  const prefix = `package:${pkg.id}:${attachment.role}`;
  const resource = (
    key: string,
    title: string,
    description: string,
    text: string,
    loading: 'pinned' | 'discoverable',
    sourceKind: string
  ): Resource => ({
    id: `${prefix}:${key}`,
    chatId: context.chatId,
    revision: pkg.revision,
    title,
    description,
    text,
    loading,
    sourceKind,
    kind: 'lore',
  });
  const groups = new Map<string, typeof pkg.lore>();
  for (const lore of pkg.lore) {
    const key = lore.loreContext?.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), lore]);
  }
  const ordered = [...groups.values()].flatMap((group) =>
    [...group].sort((a, b) => (a.loreContext?.order ?? 0) - (b.loreContext?.order ?? 0))
  );
  const resources = ordered.map((lore) => ({
    ...resource(`lore:${lore.id}`, lore.title, lore.description, lore.text, lore.loading, 'lore'),
    ...(lore.loreContext ? { loreContext: structuredClone(lore.loreContext) } : {}),
    ...(lore.relatedIds ? { relatedIds: lore.relatedIds.map((id) => `${prefix}:lore:${id}`) } : {}),
  }));
  if (pkg.body !== undefined)
    resources.unshift(
      resource('body', pkg.title, pkg.description, pkg.body, 'pinned', attachment.role)
    );
  if (pkg.identity)
    resources.unshift(
      resource(
        'identity',
        pkg.identity.name,
        'Identity description supplied by the package author.',
        pkg.identity.description,
        'pinned',
        attachment.role
      )
    );
  if (context.resourcesOnly)
    return {
      resources,
      pinned: resources.filter((r) => r.loading === 'pinned'),
      instructions: [],
      controls: structuredClone(pkg.controls),
      values: resolvePromptValues(
        { version: 1, controls: pkg.controls, blocks: [] },
        context.values
      ),
      stateView: pkg.stateView,
      transforms: structuredClone(pkg.transforms),
    };
  const unavailableInstructions: { id: string; code: string }[] = [];
  const selected = pkg.instructions.filter(
    (instruction) =>
      instruction.target === context.target &&
      (!instruction.attachmentRoles || instruction.attachmentRoles.includes(attachment.role))
  );
  const values = resolvePromptValues(
    { version: 1, controls: pkg.controls, blocks: [] },
    context.values
  );
  const budget = context.budget ?? new PromptBudget();
  const instructions: CompiledPackageAttachment['instructions'] = [];
  let outputChars = 0;
  for (const instruction of selected) {
    try {
      const compilation = compilePromptProgram(
        {
          version: 1,
          controls: pkg.controls,
          blocks: [
            {
              id: instruction.id,
              title: instruction.id,
              kind: 'message',
              role: 'system',
              template: instruction.template ?? [{ kind: 'text', text: instruction.text }],
              ...(instruction.when === undefined ? {} : { when: instruction.when }),
            },
            { id: '__package_current__', title: 'Runtime placeholder', kind: 'current' },
          ],
        },
        {
          values,
          runtime: context.runtime,
          slots: context.slots ?? {},
          history: [{ id: '__package_input__', role: 'user', text: '', current: true }],
          budget,
        }
      );
      for (const message of compilation.messages.filter(
        (message) => message.provenance.origin === 'prompt'
      )) {
        const text = message.content.map((part) => part.text).join('');
        budget.textLength(outputChars + text.length, true);
        outputChars += text.length;
        instructions.push({
          id: `${prefix}:instruction:${message.id}`,
          text,
          ...(instruction.position ? { position: instruction.position } : {}),
        });
      }
    } catch (error) {
      // Package instructions are optional add-on expressions. Main PromptProgram compilation
      // uses the same evaluator without this boundary; DB/identity/schema errors stay outside.
      if (!(error instanceof PromptProgramError) && !(error instanceof PromptEvaluationError))
        throw error;
      unavailableInstructions.push({ id: instruction.id, code: error.code });
    }
  }
  const binding = pkg.roleBindings?.[attachment.role];
  if (binding !== undefined) instructions.unshift({ id: `${prefix}:binding`, text: binding });
  if (context.behaviorUnavailable || unavailableInstructions.length)
    instructions.push({
      id: `${prefix}:instruction-diagnostics`,
      text: `Optional package instruction diagnostics: ${JSON.stringify(unavailableInstructions)}. These instructions were not applied; preserve the other package content and continue the original writing request.${context.behaviorUnavailable ? ` Package behavior is unavailable (${context.behaviorUnavailable}); its state and action outcomes are not current facts. Do not invent successful actions or replacement state.` : ''}`,
    });
  return {
    ...(unavailableInstructions.length ? { unavailableInstructions } : {}),
    resources,
    pinned: resources.filter((r) => r.loading === 'pinned'),
    instructions,
    controls: structuredClone(pkg.controls),
    values,
    ...(pkg.stateView ? { stateView: structuredClone(pkg.stateView) } : {}),
    transforms: structuredClone(pkg.transforms),
  };
}

export type PackageStateField = { key: string; label: string; text: string; missing: boolean };
/** Returns plain text descriptors, never HTML, arithmetic, mutations or executable templates. */
export function renderPackageStateView(
  view: PackageStateView,
  values: Record<string, unknown>
): { title: string; fields: PackageStateField[] } {
  // Reuse the complete validator so standalone callers have the same limits.
  validateContentPackage({
    version: 1,
    id: 'view',
    revision: 1,
    title: '',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    stateView: view,
  });
  return {
    title: view.title,
    fields: view.fields.map((field) => {
      const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
      if (value === undefined || value === null)
        return { key: field.key, label: field.label, text: '—', missing: true };
      if (
        !['string', 'boolean', 'number'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))
      )
        throw new ContentPackageError('PACKAGE_STATE_VALUE', field.key);
      if (
        (field.format === 'number' && typeof value !== 'number') ||
        (field.format === 'boolean' && typeof value !== 'boolean')
      )
        throw new ContentPackageError('PACKAGE_STATE_TYPE', field.key);
      const text = `${String(value)}${field.suffix ?? ''}`;
      if (text.length > 16_384)
        throw new ContentPackageError('PACKAGE_STATE_VALUE_LIMIT', field.key);
      return { key: field.key, label: field.label, text, missing: false };
    }),
  };
}
