import { SelectionCheckbox } from './BooleanControls.js';
import { useI18n, translateMessage } from './i18n.js';
import type { ResourceModel } from '../core/resource-editing.js';
import { useEffect, useMemo, useState } from 'react';
import { NativeCollectionEditor } from './NativeCollectionEditor.js';
import {
  useBufferedEditorState,
  useUnappliedEditorField,
  useEditorSavePreparation,
} from './resource-editor.js';
import {
  parseNativeRegexJson,
  patchNativeRegex,
  readNativeRegexFlags,
  regexRecord,
  regexText,
  setNativeRegexOrder,
  toggleNativeRegexAction,
  toggleNativeRegexFlag,
} from './native-risu-regex.js';
import './native-risu-regex.css';

export function NativeRisuRegexEditor({
  value,
  onChange,
  draftPath,
  onPendingChange,
  prepareSave,
  disabled = false,
}: {
  value: unknown[];
  onChange: (value: unknown[]) => void;
  draftPath: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  prepareSave?: (model: ResourceModel, entries: unknown[]) => ResourceModel;
}) {
  const { t } = useI18n();
  const types: Record<string, string> = {
    editinput: t('native.text_0ae9cde486'),
    editoutput: t('native.text_4727582f89'),
    editprocess: t('native.text_f1a07b7429'),
    editdisplay: t('native.text_97582665ce'),
    edittrans: t('native.text_57eaefa3f9'),
    disabled: t('native.text_fae2014b52'),
  };
  const normalFlags = [
    ['g', t('native.text_7c70beb221')],
    ['i', t('native.text_0c871722d6')],
    ['m', t('native.text_c272face5d')],
    ['s', t('native.text_7fde404c08')],
    ['u', t('native.text_acb521417b')],
  ] as const;
  const actions = [
    ['move_top', t('native.text_1a22c50a97')],
    ['move_bottom', t('native.text_59519f80ca')],
    ['cbs', t('native.text_7e73177899')],
    ['no_end_nl', t('native.text_9caf464827')],
  ] as const;
  // Retain the existing preset raw-field key so unfinished JSON survives this UI upgrade.
  const formatted = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [raw, setRaw] = useBufferedEditorState(draftPath, formatted, {
    syncPristineInitial: true,
  });
  const [error, setError] = useState('');
  const pending = raw !== formatted;
  useUnappliedEditorField(draftPath, pending);
  useEditorSavePreparation(draftPath, (model) => {
    if (!pending) return model;
    if (!prepareSave) throw new Error('정규식 JSON을 폼에 반영해 주세요.');
    return prepareSave(model, parseNativeRegexJson(raw));
  });
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  const [rawOpen, setRawOpen] = useState(pending);
  useEffect(() => {
    if (pending) setRawOpen(true);
  }, [pending]);

  function write(next: unknown[]) {
    try {
      onChange(next);
      setRaw(JSON.stringify(next, null, 2));
      setError('');
    } catch (caught) {
      setError((caught as Error).message);
    }
  }
  return (
    <section className="native-regex-editor" aria-label={t('native.text_840a850378')}>
      <fieldset className="native-regex-fields" disabled={disabled || pending}>
        <NativeCollectionEditor
          label={t('native.text_fc7e4f6228')}
          items={value.map((entry, index) => ({
            title: regexRecord(entry)
              ? regexText(entry.comment) || t('native.regexNumber', { number: index + 1 })
              : t('native.itemNumber', { number: index + 1 }),
            subtitle: regexRecord(entry)
              ? (types[regexText(entry.type)] ?? t('native.text_b46d5ef612'))
              : t('native.text_f07553a49b'),
          }))}
          onAdd={() =>
            write([...value, { comment: '새 정규식', type: 'editinput', in: '', out: '' }])
          }
          onMove={(index, delta) => {
            const next = [...value];
            [next[index], next[index + delta]] = [next[index + delta], next[index]];
            write(next);
          }}
          onReorder={(from, to) => {
            const next = [...value];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            write(next);
          }}
          onRemove={(index) => write(value.filter((_, i) => index !== i))}
        >
          {(index) => {
            const entry = value[index];
            if (!regexRecord(entry)) return <p className="muted">{t('native.text_79e318b649')}</p>;
            const edit = (patch: Record<string, unknown>) =>
              write(value.map((item, i) => (i === index ? patchNativeRegex(entry, patch) : item)));
            const flag = regexText(entry.flag);
            const parsed = readNativeRegexFlags(flag);
            const type = regexText(entry.type);
            const unsupported = parsed.actions.filter(
              (action) => !action.startsWith('order ') && !actions.some(([key]) => key === action)
            );
            return (
              <div className="native-regex-form">
                <div className="native-field-row">
                  <label>
                    {t('native.text_9aa18e5071')}
                    <input
                      aria-label={t('native.text_d8d276f70c')}
                      value={regexText(entry.comment)}
                      onChange={(e) => edit({ comment: e.target.value })}
                    />
                  </label>
                  <label>
                    {t('native.text_81c4f73cf0')}
                    <select
                      aria-label={t('native.text_f4b93cdf02')}
                      value={type}
                      onChange={(e) => edit({ type: e.target.value })}
                    >
                      {!Object.hasOwn(types, type) && (
                        <option value={type}>
                          {t('native.unsupportedType', {
                            type: type || t('native.text_5c1a705c22'),
                          })}
                        </option>
                      )}
                      {Object.entries(types).map(([key, title]) => (
                        <option key={key} value={key}>
                          {title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  {t('native.text_6b5f44ef65')}
                  <textarea
                    className="native-regex-find"
                    aria-label={t('native.text_605efd02b3')}
                    rows={3}
                    spellCheck={false}
                    value={regexText(entry.in ?? entry.find)}
                    onChange={(e) => edit({ in: e.target.value })}
                  />
                </label>
                <label>
                  {t('native.text_dce02ee0f0')}
                  <textarea
                    className="native-regex-replacement"
                    aria-label={t('native.text_0ed674a38e')}
                    rows={7}
                    spellCheck={false}
                    value={regexText(entry.out ?? entry.replace)}
                    onChange={(e) => edit({ out: e.target.value })}
                  />
                </label>
                <label className="check">
                  <SelectionCheckbox
                    checked={entry.ableFlag === true}
                    onChange={(e) =>
                      edit({
                        ableFlag: e.target.checked,
                        ...(e.target.checked && !flag ? { flag: 'g' } : {}),
                      })
                    }
                  />
                  {t('native.text_3debd57307')}
                </label>
                {entry.ableFlag === true && (
                  <div className="native-regex-flag-fields">
                    <div
                      className="native-regex-flags"
                      role="group"
                      aria-label={t('native.text_b1af299201')}
                    >
                      {normalFlags.map(([key, title]) => (
                        <button
                          type="button"
                          key={key}
                          aria-pressed={parsed.flags.includes(key)}
                          onClick={() => edit({ flag: toggleNativeRegexFlag(flag, key) })}
                        >
                          {title} ({key})
                        </button>
                      ))}
                    </div>
                    <details className="native-advanced">
                      <summary>{t('native.text_48e487befd')}</summary>
                      <div className="native-regex-actions">
                        {actions.map(([key, title]) => (
                          <label className="check" key={key}>
                            <SelectionCheckbox
                              checked={parsed.actions.includes(key)}
                              onChange={() => edit({ flag: toggleNativeRegexAction(flag, key) })}
                            />
                            {title}
                          </label>
                        ))}
                      </div>
                      <label>
                        {t('native.text_e5b51f4933')}
                        <input
                          aria-label={t('native.text_18fec02cf1')}
                          type="number"
                          step={1}
                          value={parsed.order}
                          onChange={(e) => {
                            if (Number.isSafeInteger(e.target.valueAsNumber))
                              edit({ flag: setNativeRegexOrder(flag, e.target.valueAsNumber) });
                          }}
                        />
                      </label>
                      <label>
                        {t('native.text_ce80b34836')}
                        <input
                          aria-label={t('native.text_8ec54ac45b')}
                          value={flag}
                          spellCheck={false}
                          onChange={(e) => edit({ flag: e.target.value })}
                        />
                      </label>
                    </details>
                  </div>
                )}
                {(type === 'edittrans' || (!Object.hasOwn(types, type) && type !== 'disabled')) && (
                  <p className="muted">{t('native.text_977c8a35ea')}</p>
                )}
                {entry.ableFlag === true && unsupported.length > 0 && (
                  <p className="muted">
                    {t('native.unsupportedFlags', { flags: unsupported.join(', ') })}
                  </p>
                )}
                <div className="native-regex-secondary-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      write([
                        ...value.slice(0, index + 1),
                        {
                          ...structuredClone(entry),
                          comment: `${regexText(entry.comment) || '정규식'} 사본`,
                        },
                        ...value.slice(index + 1),
                      ])
                    }
                  >
                    {t('native.text_fe5438dade')}
                  </button>
                </div>
              </div>
            );
          }}
        </NativeCollectionEditor>
      </fieldset>
      <details
        className="native-regex-raw native-advanced"
        open={rawOpen}
        onToggle={(e) => setRawOpen(e.currentTarget.open)}
      >
        <summary>{t('native.text_5fff7f258f')}</summary>
        <label>
          {t('native.text_a3a610d085')}
          <textarea
            aria-label={t('native.text_a3a610d085')}
            rows={12}
            spellCheck={false}
            disabled={disabled}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>
        {pending && <p className="muted">{t('native.text_dd964b88ac')}</p>}
        <div className="form-actions">
          <button
            type="button"
            disabled={disabled || !pending}
            onClick={() => {
              try {
                write(parseNativeRegexJson(raw));
              } catch (caught) {
                setError((caught as Error).message);
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
              setRaw(JSON.stringify(value, null, 2));
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
      </details>
    </section>
  );
}
