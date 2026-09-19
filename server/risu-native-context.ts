import type { RunSnapshot } from '../core/types.js';
import type { NativeRisuMessage } from '../core/risu-native-execution.js';
import {
  nativeRisuRegex,
  nativeRisuTriggers,
  nativeRisuLore,
  nativeRisuBackground,
  nativeRisuAssetNames,
} from '../core/risu-native.js';
import type { NativeRisuContent } from '../core/risu-native.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { createHash } from 'node:crypto';
import { resolvePromptValues } from '../core/prompt-program.js';

export function nativeRisuSessionKey(snapshot: RunSnapshot): string {
  const revisions = nativeRisuPackages(snapshot).map(({ attachment, native }) => [
    attachment,
    native.sourceHash,
  ]);
  return `native:${snapshot.chatId}:${snapshot.branchId ?? 'main'}:${createHash('sha256').update(JSON.stringify(revisions)).digest('hex')}`;
}

export function nativeRisuPackages(snapshot: RunSnapshot) {
  return (snapshot.profile?.packageAttachments ?? []).flatMap((attachment) => {
    const pkg = snapshot.profile?.packages?.find(
      (entry) => entry.id === attachment.id && entry.revision === attachment.revision
    );
    return pkg?.nativeRisu ? [{ attachment, pkg, native: pkg.nativeRisu }] : [];
  });
}

export function nativeRisuMessages(snapshot: RunSnapshot): NativeRisuMessage[] {
  return snapshot.logicalHistory
    ? snapshot.logicalHistory
        .filter((entry) => entry.sourceKind !== 'authored-start')
        .map((entry) => ({
          id: entry.id,
          role: entry.role === 'user' ? 'user' : 'char',
          data: entry.text,
        }))
    : snapshot.history.map((entry) => ({ role: 'char', data: entry.text }));
}

/** Each invocation receives its own character, modules, variables and asset namespace. */
export function nativeRisuContext(snapshot: RunSnapshot) {
  const entries = nativeRisuPackages(snapshot);
  const bot = entries.find((entry) => entry.attachment.role === 'bot') ?? entries[0];
  const preset = snapshot.profile?.promptPresets?.main;
  if (!bot && !preset?.program.nativeRisuPreset) return undefined;
  const presetSource = preset?.program.nativeRisuPreset?.preset;
  const presetRegex = presetSource?.regex ?? presetSource?.presetRegex;
  const natives = entries.map((entry) => entry.native);
  const effectiveTriggers = natives.flatMap(nativeRisuTriggers);
  const base = bot?.native ?? {
    version: 1 as const,
    card: {},
    assets: [],
    sourceHash: createHash('sha256').update(JSON.stringify(presetSource)).digest('hex'),
  };
  const native: NativeRisuContent = {
    ...structuredClone(base),
    module: {
      ...base.module,
      regex: [
        ...(Array.isArray(presetRegex) ? presetRegex : []),
        ...natives.flatMap(nativeRisuRegex),
      ],
      trigger: effectiveTriggers,
      lorebook: natives.flatMap(nativeRisuLore),
    },
    assets: natives.flatMap((entry) => entry.assets),
  };
  const extensions = native.card.extensions as Record<string, unknown> | undefined;
  native.card.extensions = {
    ...extensions,
    risuai: {
      ...(extensions?.risuai as Record<string, unknown> | undefined),
      backgroundHTML: natives.map(nativeRisuBackground).filter(Boolean).join('\n'),
    },
  };
  const identity = packageIdentityFromProfile(snapshot.profile!);
  const assetUrls: Record<string, string> = Object.create(null);
  for (const entry of entries)
    for (const asset of entry.native.assets) {
      const image = entry.pkg.images?.find((image) => image.id === asset.imageId);
      if (!image) continue;
      const url = `/api/package-image-blobs/${image.blobHash}`;
      for (const name of nativeRisuAssetNames(entry.native, asset)) assetUrls[name] = url;
    }
  return {
    native,
    effectiveTriggers,
    background: natives.map(nativeRisuBackground).filter(Boolean).join('\n'),
    charName: identity.bot.name,
    userName: identity.user.name,
    globalVariables: preset
      ? Object.fromEntries(
          Object.entries(
            resolvePromptValues(
              preset.program,
              snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values ??
                preset.values
            )
          ).map(([key, value]) => [`toggle_${key}`, String(value)])
        )
      : {},
    mainPrompt: typeof presetSource?.mainPrompt === 'string' ? presetSource.mainPrompt : '',
    globalNote: typeof presetSource?.globalNote === 'string' ? presetSource.globalNote : '',
    now: snapshot.executionClock ? Date.parse(snapshot.executionClock.iso) : 0,
    variables: {
      ...resolveTemplateVariableContext(snapshot.profile, 'main').variables,
      ...snapshot.nativeRisuExecution?.variables,
    },
    messages: nativeRisuMessages(snapshot),
    assetUrls,
  };
}
