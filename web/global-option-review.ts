import { t } from './i18n.js';
import type { CurrentPrompt } from '../core/product.js';
import { promptOptionOwner, type OptionValues } from '../core/chat-options.js';
import { promptControls, reconcilePromptValues, type PromptValue } from '../core/risu-prompt.js';

/** Review global option edits against saved values without replacing unrelated remote edits. */
export function reviewGlobalOptionDraft(
  base: CurrentPrompt,
  draft: OptionValues,
  saved: CurrentPrompt
) {
  const previousControls = promptControls(base.program);
  const controls = promptControls(saved.program);
  const sameOwner = promptOptionOwner(base) === promptOptionOwner(saved);
  const sameDefinition = JSON.stringify(previousControls) === JSON.stringify(controls);
  const values = { ...saved.values };
  const discarded: {
    id: string;
    label: string;
    value: PromptValue;
    reason: string;
    unset?: boolean;
  }[] = [];
  for (const id of new Set([...Object.keys(base.values), ...Object.keys(draft)])) {
    const edited =
      Object.hasOwn(base.values, id) !== Object.hasOwn(draft, id) || base.values[id] !== draft[id];
    if (!edited && sameOwner && sameDefinition) continue;
    const previous = previousControls.find((control) => control.id === id);
    const control = controls.find((entry) => entry.id === id);
    const label = previous?.label ?? control?.label ?? id;
    if (!Object.hasOwn(draft, id)) {
      if (sameOwner && previous && control && previous.type === control.type) delete values[id];
      else if (Object.hasOwn(saved.values, id))
        discarded.push({
          id,
          label,
          value: null,
          unset: true,
          reason: t('settings.m112'),
        });
      continue;
    }
    const value = draft[id]!;
    let reason = '';
    if (!sameOwner) reason = t('settings.m106');
    else if (!control) reason = t('settings.m107');
    else if (!previous || previous.type !== control.type) reason = t('settings.m108');
    else if (reconcilePromptValues([control], { [id]: value }).resetKeys.length)
      reason = t('settings.m109');
    else if (
      control.type === 'select' &&
      previous.options?.find((option) => option.value === (value ?? previous.default))?.label !==
        control.options?.find((option) => option.value === (value ?? control.default))?.label
    )
      reason = t('settings.m110');
    if (reason) discarded.push({ id, label, value, reason });
    else if (edited) values[id] = reconcilePromptValues([control!], { [id]: value }).values[id]!;
  }
  return { values, discarded };
}
