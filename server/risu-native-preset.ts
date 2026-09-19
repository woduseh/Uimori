import { createHash } from 'node:crypto';
import { nativeRisuPresetFields, nativeRisuPresetProjection } from '../core/risu-native-preset.js';
import {
  resolvePromptValues,
  validatePromptProgram,
  type PromptProgram,
} from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import type { NativeRisuContent } from '../core/risu-native.js';
import { nativeRisuContext } from './risu-native-context.js';
import { evaluateNativeRisuFields } from './risu-native-cbs.js';
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
  const native: NativeRisuContent = base?.native ?? {
    version: 1,
    sourceHash: hash(source),
    assets: [],
    card: { name: identity.bot.name, extensions: { risuai: {} } },
  };
  const values = resolvePromptValues(
    preset!.program,
    snapshot.profile?.promptControls?.[`${preset!.id}@${preset!.revision}`]?.values ??
      preset!.values
  );
  const globalVariables = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      `toggle_${key}`,
      value === null ? 'null' : String(value),
    ])
  );
  const result = await evaluateNativeRisuFields({
    native,
    fields: nativeRisuPresetFields(source),
    context: {
      variables: {
        ...resolveTemplateVariableContext(snapshot.profile, 'main').variables,
        ...base?.variables,
      },
      globalVariables,
      messages:
        snapshot.nativeRisuExecution?.messages ??
        base?.messages ??
        (snapshot.logicalHistory ?? []).map((message) => ({
          role: message.role === 'user' ? 'user' : 'char',
          data: message.text,
        })),
      charName: identity.bot.name,
      userName: identity.user.name,
      mainPrompt: string(source.preset.mainPrompt),
      globalNote: string(source.preset.globalNote),
      jailbreak: string(source.preset.jailbreak),
      jailbreakToggle: source.preset.jailbreakToggle === true,
      templateDefaultVariables: string(source.preset.templateDefaultVariables),
      now: snapshot.executionClock ? Date.parse(snapshot.executionClock.iso) : 0,
    },
  });
  const next = {
    ...snapshot,
    nativeRisuPresetProgram: { version: 1 as const, sourceHash: hash(source), ...result },
    promptCompilation: undefined,
  };
  projectNativeRisuPresetProgram(next, preset!.program);
  return next;
}
/** Replay only projects frozen output; neither CBS nor provider work is repeated. */
export function projectNativeRisuPresetProgram(
  snapshot: RunSnapshot,
  program: PromptProgram
): PromptProgram {
  const source = program.nativeRisuPreset,
    receipt = snapshot.nativeRisuPresetProgram;
  if (!source || !receipt) return program;
  if (
    receipt.version !== 1 ||
    receipt.sourceHash !== hash(source) ||
    !receipt.fields ||
    typeof receipt.fields !== 'object' ||
    Array.isArray(receipt.fields) ||
    Object.values(receipt.fields).some((value) => typeof value !== 'string')
  )
    throw new Error('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
  const expected = Object.keys(nativeRisuPresetFields(source)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(Object.keys(receipt.fields).sort()))
    throw new Error('RISU_NATIVE_PRESET_RECEIPT_MISMATCH');
  const { nativeRisuPreset: _source, ...other } = program;
  return validatePromptProgram({ ...other, ...nativeRisuPresetProjection(source, receipt.fields) });
}
