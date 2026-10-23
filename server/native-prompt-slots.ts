import {
  serializeRisuContextSource,
  serializeRisuLoreSources,
} from '../core/risu-context-source.js';
import { buildMainInput, pinnedSlotSources, type MainInput } from '../core/provider.js';
import { compiledPackages, type ResolvedPackage } from '../core/package-context.js';
import type { RunSnapshot } from '../core/types.js';
import { packageIdentityFromProfile } from '../core/package-identity.js';
import { nativeExampleMessages } from '../core/risu-native-messages.js';
import { nativeRisuFieldKey } from '../core/risu-native-execution.js';
import { risuImageHandoffText } from '../core/risu-image-handoff.js';

/** Authored examples keep their source and prepared text; they are not conversation history. */
export function nativeCharacterExamples(
  snapshot: RunSnapshot,
  packages: readonly ResolvedPackage[] = compiledPackages(snapshot, 'main')
) {
  const bot = packages.find((entry) => entry.attachment.role === 'bot');
  if (!bot) return undefined;
  const identity = snapshot.profile ? packageIdentityFromProfile(snapshot.profile) : undefined;
  const names = { char: identity?.bot.name ?? '', user: identity?.user.name ?? '' };
  const text = snapshot.profile?.image
    ? risuImageHandoffText(bot.package, 'card:mes_example')
    : String(bot.package.nativeRisu?.card.mes_example ?? '');
  const messages = nativeExampleMessages(text, names.char, names.user).map((message, index) => ({
    ...message,
    text:
      snapshot.nativeRisuExecution?.fields[nativeRisuFieldKey(bot.attachment)]?.[
        `example:${index}`
      ] ?? message.text,
  }));
  if (!messages.length) return undefined;
  return {
    source: {
      sourceRole: 'bot' as const,
      sourceName: identity?.bot.name ?? bot.package.identity?.name ?? bot.package.title,
      contentId: bot.attachment.id,
      revision: bot.attachment.revision,
      field: 'mes_example',
    },
    names,
    messages,
  };
}

/** The same fixed host slots determine both CBS evaluation and message composition. */
export function nativePromptSlots(
  snapshot: RunSnapshot,
  input: MainInput = buildMainInput(snapshot)
): Record<string, string> {
  const body = (slot: string) =>
    pinnedSlotSources(input, slot).map(serializeRisuContextSource).filter(Boolean).join('\n\n');
  const slots: Record<string, string> = {
    description: body('bot'),
    persona: body('persona'),
    lorebook: serializeRisuLoreSources(pinnedSlotSources(input, 'lore')),
    authorNote: snapshot.profile?.authorNote ?? '',
    postEverything: '',
  };
  return slots;
}
