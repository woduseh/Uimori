import {
  serializeRisuContextSource,
  serializeRisuLoreSources,
} from '../core/risu-context-source.js';
import { buildMainInput, pinnedSlotSources } from '../core/provider.js';
import { compiledPackages } from '../core/package-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { PromptCompilerVersion } from '../core/risu-prompt.js';

/** The same fixed host slots determine both CBS evaluation and message composition. */
export function nativePromptSlots(
  snapshot: RunSnapshot,
  compilerVersion?: PromptCompilerVersion
): Record<string, string> {
  const input = buildMainInput(snapshot, [], { compilerVersion });
  const packages = compiledPackages(snapshot, 'main');
  const body = (slot: string) =>
    pinnedSlotSources(input, slot).map(serializeRisuContextSource).filter(Boolean).join('\n\n');
  const bot = packages.find((entry) => entry.attachment.role === 'bot')?.package;
  const slots: Record<string, string> = {
    char: bot?.identity?.name ?? bot?.title ?? 'Character',
    bot: body('bot'),
    description: body('bot'),
    persona: body('persona'),
    lore: serializeRisuLoreSources(pinnedSlotSources(input, 'lore')),
    lorebook: serializeRisuLoreSources(pinnedSlotSources(input, 'lore')),
    notes: input.notes ? JSON.stringify(input.notes) : '',
    outline: input.outline ? JSON.stringify(input.outline) : '',
    globalNote: '',
    authorNote: '',
    authornote: '',
    postEverything: '',
    slot: '',
    backgroundLore: pinnedSlotSources(input, 'backgroundLore')
      .map((item) => JSON.stringify(item))
      .join('\n'),
    sceneLore: pinnedSlotSources(input, 'sceneLore')
      .map((item) => JSON.stringify(item))
      .join('\n'),
    references: JSON.stringify(
      input.pinnedSources?.length
        ? { pinnedSources: pinnedSlotSources(input, 'references') }
        : { facts: input.facts }
    ),
    catalog: JSON.stringify(input.catalog),
    source: '',
  };
  return slots;
}
