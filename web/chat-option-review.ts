import type { ChatOptionState, OptionValues } from '../core/chat-options.js';
import { promptControls, reconcilePromptValues, type PromptValue } from '../core/risu-prompt.js';

/** Prepare a review without changing either the draft or the saved state. */
export function reviewChatOptionDraft(
  base: ChatOptionState,
  fixed: OptionValues,
  oneoff: OptionValues,
  saved: ChatOptionState
) {
  const oldControls = base.controls ?? promptControls(base.program);
  const controls = saved.controls ?? promptControls(saved.program);
  const sameOwner = base.binding.owner === saved.binding.owner;
  const sameBinding = sameOwner && base.binding.definitionHash === saved.binding.definitionHash;
  const discarded: {
    scope: 'fixed' | 'oneoff';
    id: string;
    label: string;
    value: PromptValue;
    reason: string;
    unset?: boolean;
  }[] = [];
  const nextFixed = { ...saved.fixedValues };
  const nextOneoff: OptionValues = {};
  function retain(scope: 'fixed' | 'oneoff', id: string, value: PromptValue, target: OptionValues) {
    const previous = oldControls.find((control) => control.id === id);
    const control = controls.find((control) => control.id === id);
    let reason = '';
    if (!sameOwner) reason = '사용하는 프롬프트가 바뀌었어요.';
    else if (!control) reason = '이 옵션이 없어졌어요.';
    else if (!previous || previous.type !== control.type) reason = '입력 형식이 바뀌었어요.';
    else if (reconcilePromptValues([control], { [id]: value }).resetKeys.length)
      reason = '이 값은 더 이상 사용할 수 없어요.';
    else if (
      control.type === 'select' &&
      previous.options?.find((option) => option.value === (value ?? previous.default))?.label !==
        control.options?.find((option) => option.value === (value ?? control.default))?.label
    )
      reason = '선택지의 뜻이 바뀌었어요. 다시 선택해 주세요.';
    if (reason) {
      discarded.push({ scope, id, label: previous?.label ?? control?.label ?? id, value, reason });
    } else {
      target[id] = reconcilePromptValues([control!], { [id]: value }).values[id]!;
    }
  }
  for (const id of new Set([...Object.keys(base.fixedValues), ...Object.keys(fixed)])) {
    if (
      sameBinding &&
      Object.hasOwn(fixed, id) === Object.hasOwn(base.fixedValues, id) &&
      fixed[id] === base.fixedValues[id]
    )
      continue;
    if (!Object.hasOwn(fixed, id)) {
      const previous = oldControls.find((control) => control.id === id);
      const control = controls.find((entry) => entry.id === id);
      if (sameOwner && previous && control && previous.type === control.type) delete nextFixed[id];
      else if (Object.hasOwn(saved.fixedValues, id))
        discarded.push({
          scope: 'fixed',
          id,
          label: previous?.label ?? id,
          value: null,
          unset: true,
          reason: '프롬프트나 입력 형식이 바뀌어 이 옵션의 해제 선택을 적용하지 않아요.',
        });
    } else retain('fixed', id, fixed[id]!, nextFixed);
  }
  for (const [id, value] of Object.entries(oneoff)) retain('oneoff', id, value, nextOneoff);
  return { fixed: nextFixed, oneoff: nextOneoff, discarded };
}
