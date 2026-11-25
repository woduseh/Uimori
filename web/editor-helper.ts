import { createContext } from 'react';
import type { EditorFocus } from '../core/editor-focus.js';
import { t } from './i18n.js';

export type EditorHelperOpener = (focus: EditorFocus) => void;
export const EditorHelperContext = createContext<EditorHelperOpener | null>(null);

type Subject = { key: string; code: boolean; prose: boolean };

const ITEM_SUBJECTS: Record<string, Subject> = {
  lore: { key: 'editorHelper.subject.lore', code: false, prose: true },
  regex: { key: 'editorHelper.subject.regex', code: true, prose: false },
  triggers: { key: 'editorHelper.subject.trigger', code: true, prose: false },
  blocks: { key: 'editorHelper.subject.block', code: true, prose: true },
  variables: { key: 'editorHelper.subject.toggle', code: true, prose: false },
};
const CODE_SECTIONS = new Set(['regex', 'triggers', 'variables']);

function subject(focus: EditorFocus): Subject {
  const { field, item, section } = focus;
  const codeField = !!field && (field.language !== 'cbs' || CODE_SECTIONS.has(section));
  if (focus.selection)
    return { key: 'editorHelper.subject.selection', code: codeField, prose: !codeField };
  if (item && section === 'greetings')
    return {
      key: item.index === 0 ? 'editorHelper.subject.firstMessage' : 'editorHelper.subject.greeting',
      code: false,
      prose: true,
    };
  const known = item ? ITEM_SUBJECTS[section] : undefined;
  if (known) return known;
  if (field)
    return {
      key:
        field.language === 'lua'
          ? 'editorHelper.subject.lua'
          : field.language === 'html'
            ? 'editorHelper.subject.html'
            : 'editorHelper.subject.field',
      code: codeField,
      prose: !codeField,
    };
  return { key: 'editorHelper.subject.section', code: false, prose: true };
}

export const EDITOR_HELPER_SUGGESTION_LIMIT = 4;

export function editorHelperSubject(focus: EditorFocus) {
  return t(subject(focus).key, { label: focus.field?.label ?? focus.item?.label ?? '' });
}

export function editorHelperSuggestions(focus: EditorFocus): string[] {
  const about = subject(focus);
  const target = editorHelperSubject(focus);
  const flagged = !!focus.diagnostic || !!focus.diagnostics?.length;
  const checkable = about.code || !!focus.field?.usesCbs;
  const requests = [
    focus.diagnostic
      ? t('editorHelper.fixThisError')
      : flagged
        ? t('editorHelper.fixErrors', { target })
        : '',
    focus.section === 'lore' && focus.item && !focus.selection
      ? t('editorHelper.checkLoreKeys', { target })
      : '',
    about.code ? t('editorHelper.explain', { target }) : '',
    checkable && !flagged ? t('editorHelper.check', { target }) : '',
    about.prose ? t('editorHelper.polish', { target }) : '',
    about.prose ? t('editorHelper.shorten', { target }) : '',
    about.prose && !focus.selection ? t('editorHelper.continue', { target }) : '',
  ];
  return requests.filter(Boolean).slice(0, EDITOR_HELPER_SUGGESTION_LIMIT);
}
