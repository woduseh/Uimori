import type { ChatOptionState, OptionValues } from '../core/chat-options.js';
import { promptControls, reconcilePromptValues, type PromptValue } from '../core/risu-prompt.js';
import { t } from './i18n.js';

export type OptionScope = 'fixed' | 'oneoff';
export type OptionDraft = Record<string, { value: PromptValue } | { inherit: true }>;

/** Review actual edit intent once, independently of the currently displayed scope. */
export function reviewOptionDraft(
  base: ChatOptionState,
  draft: OptionDraft,
  saved: ChatOptionState
) {
  const oldControls = base.controls ?? promptControls(base.program);
  const controls = saved.controls ?? promptControls(saved.program);
  const sameOwner = base.binding.owner === saved.binding.owner;
  const discarded: {
    scope: OptionScope;
    id: string;
    label: string;
    value: PromptValue;
    reason: string;
    unset?: boolean;
  }[] = [];
  const retained: OptionDraft = {};
  const retainedUnsets: string[] = [];
  // Preserve the review's unset-before-value order and existing scope keys.
  for (const [id, edit] of Object.entries(draft)) {
    if ('value' in edit) continue;
    const previous = oldControls.find((control) => control.id === id);
    const control = controls.find((entry) => entry.id === id);
    if (sameOwner && previous && control && previous.type === control.type) retainedUnsets.push(id);
    else
      discarded.push({
        scope: 'fixed',
        id,
        label: previous?.label ?? id,
        value: null,
        unset: true,
        reason: t('settings.m111'),
      });
  }
  for (const [id, edit] of Object.entries(draft)) {
    if (!('value' in edit)) continue;
    const { value } = edit;
    const previous = oldControls.find((control) => control.id === id);
    const control = controls.find((control) => control.id === id);
    let reason = '';
    let reconciled: ReturnType<typeof reconcilePromptValues> | undefined;
    if (!sameOwner) reason = t('settings.m106');
    else if (!control) reason = t('settings.m107');
    else if (!previous || previous.type !== control.type) reason = t('settings.m108');
    else {
      reconciled = reconcilePromptValues([control], { [id]: value });
      if (reconciled.resetKeys.length) reason = t('settings.m109');
      else if (
        control.type === 'select' &&
        previous.options?.find((option) => option.value === (value ?? previous.default))?.label !==
          control.options?.find((option) => option.value === (value ?? control.default))?.label
      )
        reason = t('settings.m110');
    }
    if (reason)
      discarded.push({
        scope: 'oneoff',
        id,
        label: previous?.label ?? control?.label ?? id,
        value,
        reason,
      });
    else retained[id] = { value: reconciled!.values[id]! };
  }
  for (const id of retainedUnsets) retained[id] = { inherit: true };
  return { draft: retained, discarded };
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
