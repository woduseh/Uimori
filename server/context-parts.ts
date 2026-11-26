import { estimateContextTokens, estimateImageTokens } from '../core/context-budget.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { NATIVE_HOST_CONTEXT_ID } from '../core/provider-messages.js';
import type { LogicalMessage } from '../core/risu-prompt.js';
import {
  MAIN_CONTEXT_PARTS,
  type MainContextPart,
  type MainContextParts,
} from '../core/scene-usage.js';
import type { ProviderRequest } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';

const BLOCK_ID = /^risu-block-(\d+)(?::|$)/u;
const LORE_MESSAGES =
  /^(lore-reference:|__native_lore:|__host_background_lore__$|__host_scene_lore__$)/u;
const blockParts: Record<string, MainContextPart> = {
  plain: 'prompt',
  chatML: 'prompt',
  postEverything: 'prompt',
  chat: 'botDescription',
  description: 'botDescription',
  persona: 'persona',
  lorebook: 'lore',
  authornote: 'authorNote',
};

function blockTypes(snapshot: RunSnapshot): unknown[] {
  const program =
    snapshot.profile?.promptPresets?.main?.program ?? createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT);
  return (program.nativeRisuPreset.preset.promptTemplate as { type?: unknown }[]).map(
    (block) => block.type
  );
}

function messagePart(message: LogicalMessage, types: unknown[]): MainContextPart {
  const { blockId, origin, sourceMessageId } = message.provenance;
  if (origin === 'current') return 'request';
  if (sourceMessageId === 'context-summary') return 'summary';
  if (origin === 'history') return 'history';
  if (blockId === NATIVE_HOST_CONTEXT_ID) return 'appInstructions';
  if (LORE_MESSAGES.test(blockId)) return 'lore';
  const index = BLOCK_ID.exec(blockId)?.[1];
  const type = index === undefined ? undefined : types[Number(index) - 1];
  return (typeof type === 'string' && blockParts[type]) || 'other';
}

export function continuedContextParts(first: MainContextParts, total: number): MainContextParts {
  const before = Object.values(first).reduce((sum, tokens) => sum + (tokens ?? 0), 0);
  if (total <= before || before <= 0) {
    const parts: MainContextParts = {};
    let assigned = 0;
    for (const part of MAIN_CONTEXT_PARTS) {
      const share = before > 0 ? Math.floor(((first[part] ?? 0) * total) / before) : 0;
      if (share > 0) parts[part] = share;
      assigned += share;
    }
    if (total > assigned) parts.other = (parts.other ?? 0) + total - assigned;
    return parts;
  }
  return { ...first, toolResults: (first.toolResults ?? 0) + total - before };
}

export function mainContextParts(
  snapshot: RunSnapshot,
  request: ProviderRequest,
  total: number
): MainContextParts | undefined {
  if (!request.prompt || request.opaqueState != null || !request.contextBudget) return undefined;
  const budget = request.contextBudget;
  const types = blockTypes(snapshot);
  const texts = new Map<MainContextPart, string[]>([
    ['appInstructions', [request.stable.contract]],
  ]);
  const images = new Map<MainContextPart, number>();
  for (const message of request.prompt.messages) {
    const part = messagePart(message, types);
    if (part === 'other') continue;
    for (const content of message.content) {
      if (content.type === 'text') texts.set(part, [...(texts.get(part) ?? []), content.text]);
      else if (content.type === 'image')
        images.set(
          part,
          (images.get(part) ?? 0) +
            estimateImageTokens(content.image.input.width, content.image.input.height)
        );
    }
  }
  const guide = snapshot.storyGuide?.config.enabled ? snapshot.storyGuide.brief?.text : undefined;
  if (guide) texts.set('storyGuide', [guide]);
  const measured = new Map<MainContextPart, number>();
  for (const part of MAIN_CONTEXT_PARTS) {
    const text = texts.get(part);
    const tokens =
      (text ? estimateContextTokens(text.join('\n'), budget) : 0) + (images.get(part) ?? 0);
    if (tokens > 0) measured.set(part, tokens);
  }
  if (request.stable.tools.length)
    measured.set('tools', estimateContextTokens(request.stable.tools, budget));
  const sum = [...measured.values()].reduce((value, tokens) => value + tokens, 0);
  const ratio = sum > total ? total / sum : 1;
  const parts: MainContextParts = {};
  let assigned = 0;
  for (const [part, tokens] of measured) {
    const share = Math.floor(tokens * ratio);
    if (share > 0) parts[part] = share;
    assigned += share;
  }
  if (total > assigned) parts.other = total - assigned;
  return parts;
}
