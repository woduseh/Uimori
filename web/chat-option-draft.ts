import type { ChatOptionState, OptionValues } from '../core/chat-options.js';
import { promptControls, type PromptValue } from '../core/risu-prompt.js';
import { reviewChatOptionDraft } from './chat-option-review.js';

export type OptionScope = 'fixed' | 'oneoff';
export type OptionDraft = Record<string, { value: PromptValue } | { inherit: true }>;

/** Review actual edit intent once, independently of the currently displayed scope. */
export function reviewOptionDraft(
  base: ChatOptionState,
  draft: OptionDraft,
  saved: ChatOptionState
) {
  const values: OptionValues = {};
  const unsetIds: string[] = [];
  for (const [id, edit] of Object.entries(draft)) {
    if ('value' in edit) values[id] = edit.value;
    else unsetIds.push(id);
  }
  const review = reviewChatOptionDraft(base, {}, values, saved, unsetIds);
  const retained: OptionDraft = {};
  for (const [id, value] of Object.entries(review.oneoff)) retained[id] = { value };
  for (const id of unsetIds)
    if (!review.discarded.some((item) => item.scope === 'fixed' && item.id === id))
      retained[id] = { inherit: true };
  return { draft: retained, discarded: review.discarded };
}

/** One set of edits can target either scope without turning saved fixed values into edits. */
export function optionDraftValues(base: ChatOptionState, draft: OptionDraft) {
  const fixed = { ...base.fixedValues };
  const oneoff: OptionValues = {};
  for (const [id, edit] of Object.entries(draft)) {
    if ('value' in edit) {
      fixed[id] = edit.value;
      oneoff[id] = edit.value;
    } else {
      delete fixed[id];
      const control = (base.controls ?? promptControls(base.program)).find(
        (item) => item.id === id
      );
      // A one-off cannot unset the saved fixed value. Reserve the same effective default explicitly.
      oneoff[id] =
        base.globalValues[id] ?? control?.default ?? (control?.type === 'text' ? '' : '0');
    }
  }
  return { fixed, oneoff };
}

export function editOptionDraft(
  base: ChatOptionState,
  draft: OptionDraft,
  scope: OptionScope,
  values: OptionValues
): OptionDraft {
  const previous = optionDraftValues(base, draft)[scope];
  const next = { ...draft };
  for (const id of new Set([...Object.keys(previous), ...Object.keys(values)])) {
    const present = Object.hasOwn(values, id);
    if (present === Object.hasOwn(previous, id) && values[id] === previous[id]) continue;
    if (!present) {
      if (scope === 'fixed' && Object.hasOwn(base.fixedValues, id)) next[id] = { inherit: true };
      else delete next[id];
    } else if (
      scope === 'fixed' &&
      Object.hasOwn(base.fixedValues, id) &&
      values[id] === base.fixedValues[id]
    ) {
      delete next[id];
    } else next[id] = { value: values[id]! };
  }
  return next;
}
