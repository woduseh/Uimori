import type { HelperContextReference } from '../core/helper.js';
import { t, useI18n } from './i18n.js';
import { referenceKey } from './helper-mentions.js';

export function helperReferenceKindLabel(ref: HelperContextReference): string {
  if (ref.kind === 'scene') return t('helpers.mentionKindScene');
  if (ref.kind === 'outline') return t('helpers.mentionKindOutline');
  if (ref.kind === 'prompt-preset') return t('helpers.mentionKindPrompt');
  if (ref.role === 'bot') return t('helpers.mentionKindBot');
  if (ref.role === 'persona') return t('helpers.mentionKindPersona');
  if (ref.role === 'module') return t('helpers.mentionKindModule');
  return t('helpers.mentionKindResource');
}

export function helperReferenceLabel(ref: HelperContextReference): string {
  if (ref.kind === 'scene') {
    if (ref.sceneNumber !== undefined)
      return ref.title
        ? t('helpers.mentionSceneNamed', { number: ref.sceneNumber, title: ref.title })
        : t('helpers.mentionScene', { number: ref.sceneNumber });
    return ref.title || t('helpers.mentionKindScene');
  }
  return ref.title || helperReferenceKindLabel(ref);
}

export function HelperMentionMenu({
  items,
  selectedIndex,
  loading,
  onSelect,
  onHover,
}: {
  items: HelperContextReference[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (item: HelperContextReference) => void;
  onHover: (index: number) => void;
}) {
  useI18n();
  return (
    <div
      className="helper-mention-menu"
      role="listbox"
      aria-label={t('helpers.mentionListLabel')}
      data-testid="helper-mention-menu"
      data-keyboard-overlay=""
    >
      {items.length ? (
        items.map((item, index) => (
          <button
            key={referenceKey(item)}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            className="helper-mention-option"
            data-selected={index === selectedIndex || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(item);
            }}
            onMouseEnter={() => onHover(index)}
          >
            <span className="helper-mention-kind">{helperReferenceKindLabel(item)}</span>
            <span className="helper-mention-title">{helperReferenceLabel(item)}</span>
          </button>
        ))
      ) : (
        <p className="helper-mention-empty" role="status">
          {t(loading ? 'helpers.mentionLoading' : 'helpers.mentionEmpty')}
        </p>
      )}
    </div>
  );
}
