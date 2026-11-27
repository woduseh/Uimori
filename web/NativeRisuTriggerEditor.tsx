import { useI18n } from './i18n.js';
import { UiError, formatUiMessage, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useRef, useState } from 'react';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import { AddIcon } from './ui-icons.js';
import { IconButton } from './IconButton.js';
import { CodeField } from './CodeField.js';
import { parseJsonInput } from './json-input.js';
import { codeFieldName } from './code-field-reveal.js';
import { NativeDeleteDialog } from './NativeDeleteDialog.js';
import { useStudioItem } from './EditorStudio.js';
import { EditorHelperItemAction } from './EditorHelperAction.js';
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
  focus = null,
}: {
  focus?: { index: number; epoch: number } | null;
  value: unknown[];
  onChange: (entries: unknown[]) => void;
  draftPath: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  prepareSave?: (model: ResourceModel, entries: unknown[]) => ResourceModel;
}) {
  const { t } = useI18n();

  const [selected, setSelected] = useState(focus?.index ?? 0);
  const focused = useRef(focus?.epoch);
  useEffect(() => {
    if (!focus || focused.current === focus.epoch) return;
    focused.current = focus.epoch;
    setSelected(focus.index);
  }, [focus]);
  const [draft, setDraft] = useBufferedEditorState<{
    index: number;
    text: string;
  } | null>(draftPath, null);
  const [error, setError] = useState<UiMessage | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [removals, setRemovals] = useState(0);
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
  useStudioItem(
    entry === undefined ? null : index,
    entry === undefined ? '' : triggerTitle(entry, index)
  );
  useUnappliedEditorField(draftPath, pending);
  useEditorSavePreparation(draftPath, (model) => {
    if (!draft) return model;
    const parsed = parseJsonInput(draft.text, 'native.text_754e9dc1ea');
    if (!record(parsed) || draft.index >= value.length)
      throw new UiError(uiMessage('native.text_754e9dc1ea'));
    if (!prepareSave) throw new UiError(uiMessage('native.text_2bf65e9272'));
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
  function triggerTitle(item: unknown, i: number) {
    return record(item) && typeof item.comment === 'string' && item.comment
      ? item.comment
      : t('native.triggerNumber', { number: i + 1 });
  }
  function remove(target: number) {
    setRemoving(null);
    onChange(value.filter((_, i) => i !== target));
    setRemovals((count) => count + 1);
    setSelected(Math.max(0, target - 1));
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
            setError(null);
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
              if (index >= value.length) throw new UiError(uiMessage('native.text_782c2d04b2'));
              const parsed = parseJsonInput(raw, 'native.text_30b7bf9cb8');
              if (!record(parsed)) throw new UiError(uiMessage('native.text_30b7bf9cb8'));
              replace(parsed);
              setDraft(null);
              setError(null);
            } catch (caught) {
              setError(toUiMessage(caught, 'native.text_b0acf3aee7'));
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
            setError(null);
          }}
        >
          {t('native.text_d688879ebd')}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {formatUiMessage(error)}
        </p>
      )}
    </div>
  );

  return (
    <section className="native-trigger-editor" aria-label={t('native.text_7895dc3794')}>
      <div className="native-trigger-heading">
        <h3>{t('native.text_7ff77a77f6')}</h3>
        <IconButton
          className="ghost"
          icon={AddIcon}
          size={18}
          label={t('native.text_6d5ba8d015')}
          disabled={disabled || pending}
          onClick={() => {
            onChange([
              ...value,
              {
                comment: t('native.newLua'),
                type: 'start',
                conditions: [],
                effect: [{ type: 'triggerlua', code: '' }],
              },
            ]);
            setSelected(value.length);
          }}
        />
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
                {triggerTitle(item, i)}
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
                <label key={`${removals}:${effectIndex}`}>
                  {effects.length > 1
                    ? t('native.luaNumber', { number: effectIndex + 1 })
                    : t('native.text_8601ddaaf9')}
                  <CodeField
                    language="lua"
                    name={codeFieldName('triggers', index, `effect.${effectIndex}`)}
                    aria-label={
                      effects.length > 1
                        ? t('native.luaNumber', { number: effectIndex + 1 })
                        : t('native.text_8601ddaaf9')
                    }
                    rows={14}
                    spellCheck={false}
                    font="mono"
                    disabled={disabled || pending}
                    value={effect.code as string}
                    onChange={(code) =>
                      replace({
                        ...entry,
                        effect: effects.map((item, i) =>
                          i === effectIndex ? { ...item, code } : item
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
          <EditorHelperItemAction index={index} label={triggerTitle(entry, index)} />
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
            onClick={() =>
              lua && effects.every((effect) => !String(effect.code).trim())
                ? remove(index)
                : setRemoving(index)
            }
          >
            {t('native.text_28e82332d9')}
          </button>
        </div>
      )}
      <NativeDeleteDialog
        target={removing === null ? null : triggerTitle(value[removing], removing)}
        action={t('native.text_28e82332d9')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) remove(removing);
        }}
      />
    </section>
  );
}
