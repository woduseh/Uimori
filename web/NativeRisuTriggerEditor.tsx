import { useI18n, translateMessage } from './i18n.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useState } from 'react';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import { AddIcon } from './ui-icons.js';
import './native-risu-trigger.css';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function NativeRisuTriggerEditor({
  value,
  onChange,
  draftPath,
  onPendingChange,
  prepareSave,
  disabled = false,
}: {
  value: unknown[];
  onChange: (entries: unknown[]) => void;
  draftPath: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  prepareSave?: (model: ResourceModel, entries: unknown[]) => ResourceModel;
}) {
  const { t } = useI18n();

  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useBufferedEditorState<{ index: number; text: string } | null>(
    draftPath,
    null
  );
  const [error, setError] = useState('');
  const pending = draft !== null;
  const index = draft?.index ?? Math.min(selected, Math.max(0, value.length - 1));
  const entry = value[index];
  const effects = record(entry) && Array.isArray(entry.effect) ? entry.effect : [];
  const lua =
    effects.length > 0 &&
    effects.every(
      (effect) => record(effect) && effect.type === 'triggerlua' && typeof effect.code === 'string'
    );
  const raw = draft?.text ?? JSON.stringify(entry, null, 2) ?? '';
  useUnappliedEditorField(draftPath, pending);
  useEditorSavePreparation(draftPath, (model) => {
    if (!draft) return model;
    const parsed: unknown = JSON.parse(draft.text);
    if (!record(parsed) || draft.index >= value.length)
      throw new Error('트리거 JSON 객체를 확인해 주세요.');
    if (!prepareSave) throw new Error('트리거 JSON을 폼에 반영해 주세요.');
    return prepareSave(
      model,
      value.map((item, i) => (i === draft.index ? parsed : item))
    );
  });
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

  function replace(next: unknown) {
    onChange(value.map((item, i) => (i === index ? next : item)));
  }
  function move(delta: number) {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
    setSelected(index + delta);
  }
  const jsonEditor = (
    <div className="native-trigger-json">
      <label>
        {t('native.text_14a5c18b9e')}
        <textarea
          aria-label={t('native.text_14a5c18b9e')}
          rows={14}
          spellCheck={false}
          disabled={disabled}
          value={raw}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text === JSON.stringify(entry, null, 2) ? null : { index, text });
            setError('');
          }}
        />
      </label>
      {pending && <p className="muted">{t('native.text_1109f0e44c')}</p>}
      <div className="form-actions">
        <button
          type="button"
          disabled={disabled || !pending}
          onClick={() => {
            try {
              if (index >= value.length)
                throw new Error(
                  '편집하던 항목을 찾을 수 없어요. 입력을 되돌린 뒤 다시 확인해 주세요.'
                );
              const parsed: unknown = JSON.parse(raw);
              if (!record(parsed)) throw new Error('트리거는 JSON 객체로 입력해 주세요.');
              replace(parsed);
              setDraft(null);
              setError('');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'JSON을 확인해 주세요.');
            }
          }}
        >
          {t('native.text_5c02cb8d1c')}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={disabled || !pending}
          onClick={() => {
            setDraft(null);
            setError('');
          }}
        >
          {t('native.text_d688879ebd')}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {translateMessage(error)}
        </p>
      )}
    </div>
  );

  return (
    <section className="native-trigger-editor" aria-label={t('native.text_7895dc3794')}>
      <div className="native-trigger-heading">
        <div>
          <h3>{t('native.text_7ff77a77f6')}</h3>
          <p className="muted">{t('native.text_33506f6f0f')}</p>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={disabled || pending}
          onClick={() => {
            onChange([
              ...value,
              {
                comment: '새 Lua',
                type: 'start',
                conditions: [],
                effect: [{ type: 'triggerlua', code: '' }],
              },
            ]);
            setSelected(value.length);
          }}
        >
          <AddIcon size={18} aria-hidden="true" />
          {t('native.text_6d5ba8d015')}
        </button>
      </div>
      {value.length > 0 && (
        <>
          <select
            aria-label={t('native.text_b5b6dfa0bb')}
            disabled={disabled || pending}
            value={index}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {value.map((item, i) => (
              <option key={i} value={i}>
                {record(item) && typeof item.comment === 'string' && item.comment
                  ? item.comment
                  : t('native.triggerNumber', { number: i + 1 })}
              </option>
            ))}
          </select>
          {record(entry) && (
            <label>
              {t('native.text_9aa18e5071')}
              <input
                aria-label={t('native.text_cd7c147edc')}
                disabled={disabled || pending}
                value={typeof entry.comment === 'string' ? entry.comment : ''}
                onChange={(event) => replace({ ...entry, comment: event.target.value })}
              />
            </label>
          )}
          {lua && record(entry) ? (
            <>
              {effects.map((effect, effectIndex) => (
                <label key={effectIndex}>
                  {effects.length > 1
                    ? t('native.luaNumber', { number: effectIndex + 1 })
                    : t('native.text_8601ddaaf9')}
                  <textarea
                    aria-label={
                      effects.length > 1
                        ? t('native.luaNumber', { number: effectIndex + 1 })
                        : t('native.text_8601ddaaf9')
                    }
                    rows={14}
                    spellCheck={false}
                    disabled={disabled || pending}
                    value={effect.code as string}
                    onChange={(event) =>
                      replace({
                        ...entry,
                        effect: effects.map((item, i) =>
                          i === effectIndex ? { ...item, code: event.target.value } : item
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <details className="native-advanced" open={pending || undefined}>
                <summary>{t('native.text_a21e47d201')}</summary>
                {jsonEditor}
              </details>
            </>
          ) : (
            jsonEditor
          )}
        </>
      )}
      {value.length === 0 && !pending && (
        <p className="native-trigger-empty">{t('native.text_8898368573')}</p>
      )}
      {value.length === 0 && pending && jsonEditor}
      {value.length > 0 && (
        <div className="native-trigger-actions">
          <button
            type="button"
            className="ghost"
            disabled={disabled || pending || index === 0}
            onClick={() => move(-1)}
          >
            {t('native.text_08f78639fa')}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || pending || index >= value.length - 1}
            onClick={() => move(1)}
          >
            {t('native.text_d12567dd6d')}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || pending}
            onClick={() => {
              onChange(value.filter((_, i) => i !== index));
              setSelected(Math.max(0, index - 1));
            }}
          >
            {t('native.text_28e82332d9')}
          </button>
        </div>
      )}
    </section>
  );
}
