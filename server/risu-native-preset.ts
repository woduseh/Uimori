import { createHash } from 'node:crypto';
import { nativeRisuPresetFields, evaluatedNativeRisuPreset } from '../core/risu-native-preset.js';
import { validateRisuPrompt, type RisuPrompt } from '../core/risu-prompt.js';
import type { RunSnapshot } from '../core/types.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import type { RisuContentSource } from '../core/risu-native.js';
import { nativeRisuContext } from './risu-native-context.js';
import { evaluateNativeRisuFields } from './risu-native-cbs.js';
import { nativePromptSlots } from './native-prompt-slots.js';
import { risuImageHandoffText } from '../core/risu-image-handoff.js';
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fieldContext(snapshot: RunSnapshot) {
  const bot = snapshot.profile?.packageAttachments?.find((item) => item.role === 'bot');
  const pkg = snapshot.profile?.packages?.find(
    (item) => item.id === bot?.id && item.revision === bot.revision
  );
  return {
    slots: nativePromptSlots(snapshot),
    globalNoteReplacement:
      pkg && snapshot.profile?.image
        ? risuImageHandoffText(pkg, 'card:post_history_instructions')
        : string(pkg?.nativeRisu?.card.post_history_instructions),
  };
}

export function nativeRisuPresetPending(snapshot: RunSnapshot): boolean {
  return (
    !!snapshot.profile?.promptPresets?.main?.program.nativeRisuPreset &&
    !snapshot.nativeRisuPresetProgram
  );
}
export function nativeRisuPresetRegex(snapshot: RunSnapshot): Record<string, unknown>[] {
  const preset = snapshot.profile?.promptPresets?.main?.program.nativeRisuPreset?.preset;
  const value = preset?.regex ?? preset?.presetRegex;
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}
export async function prepareNativeRisuPreset(snapshot: RunSnapshot): Promise<RunSnapshot> {
  const preset = snapshot.profile?.promptPresets?.main,
    source = preset?.program.nativeRisuPreset;
  if (!source) return snapshot;
  if (snapshot.nativeRisuPresetProgram) {
    projectNativeRisuPresetProgram(snapshot, preset!.program);
    return snapshot;
  }
  const identity = packageIdentityFromProfile(snapshot.profile!);
  const base = nativeRisuContext(snapshot);
  const native: RisuContentSource = base?.native ?? {
    version: 1,
    sourceHash: hash(source),
    assets: [],
    card: { name: identity.bot.name, extensions: { risuai: {} } },
  };
  const context = fieldContext(snapshot);
  const fieldPlan = nativeRisuPresetFields(source, context);
  const result = await evaluateNativeRisuFields({
    native,
    fields: fieldPlan,
    fieldRoles: Object.fromEntries(
      (source.preset.promptTemplate as Record<string, unknown>[]).flatMap((raw, index) =>
        raw.type === 'plain'
          ? [
              [
                `block:${index}:text`,
                raw.role === 'user'
                  ? 'user'
                  : raw.role === 'bot' || raw.role === 'assistant'
                    ? 'assistant'
                    : 'system',
              ],
            ]
          : []
      )
    ),
    context: {
      variables: {
        ...resolveTemplateVariableContext(snapshot.profile).variables,
        ...base?.variables,
      },
      globalVariables: base?.globalVariables ?? {},
      messages:
        snapshot.nativeRisuExecution?.messages ??
        base?.messages ??
        (snapshot.logicalHistory ?? []).map((message) => ({
          role: message.role === 'user' ? 'user' : 'char',
          data: message.text,
        })),
      charName: identity.bot.name,
      userName: identity.user.name,
      globalNote: context.globalNoteReplacement,
      templateDefaultVariables: string(source.preset.templateDefaultVariables),
      now: snapshot.executionClock ? Date.parse(snapshot.executionClock.iso) : 0,
    },
  });
  const next = {
    ...snapshot,
    nativeRisuPresetProgram: {
      version: 2 as const,
      sourceHash: hash(source),
      contextHash: hash(fieldPlan),
      ...result,
    },
    promptCompilation: undefined,
  };
  projectNativeRisuPresetProgram(next, preset!.program);
  return next;
}
/** Replay only projects frozen output; neither CBS nor provider work is repeated. */
export function projectNativeRisuPresetProgram(
  snapshot: RunSnapshot,
  program: RisuPrompt
): RisuPrompt {
  const source = program.nativeRisuPreset,
    receipt = snapshot.nativeRisuPresetProgram;
  if (!source || !receipt) return program;
  if (
    ![1, 2].includes(receipt.version) ||
    receipt.sourceHash !== hash(source) ||
    !receipt.fields ||
    typeof receipt.fields !== 'object' ||
    Array.isArray(receipt.fields) ||
    Object.values(receipt.fields).some((value) => typeof value !== 'string')
  )
    throw new Error('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
  const context = fieldContext(snapshot);
  const fieldPlan = nativeRisuPresetFields(
    source,
    receipt.version === 1 ? { legacy: true } : context
  );
  if (receipt.version === 2 && receipt.contextHash !== hash(fieldPlan))
    throw new Error('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
  const expected = Object.keys(fieldPlan).sort();
  if (JSON.stringify(expected) !== JSON.stringify(Object.keys(receipt.fields).sort()))
    throw new Error('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
  return validateRisuPrompt({
    ...program,
    nativeRisuPreset: evaluatedNativeRisuPreset(source, receipt.fields),
  });
}

/** Translation evaluates its own source and controls without changing card state or the stored preset. */
export async function prepareNativeRisuTranslationPrompt(
  snapshot: RunSnapshot
): Promise<RunSnapshot> {
  const preset = snapshot.profile?.promptPresets?.translation;
  if (!preset) return snapshot;
  const prepared = await prepareNativeRisuPreset({
    ...snapshot,
    nativeRisuPresetProgram: undefined,
    profile: {
      ...snapshot.profile!,
      promptPresets: { ...snapshot.profile!.promptPresets, main: preset },
    },
  });
  const program = projectNativeRisuPresetProgram(prepared, preset.program);
  return {
    ...snapshot,
    profile: {
      ...snapshot.profile!,
      promptPresets: { ...snapshot.profile!.promptPresets, translation: { ...preset, program } },
    },
  };
}
