import { useEffect, useState } from 'react';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
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
  disabled = false,
}: {
  value: unknown[];
  onChange: (entries: unknown[]) => void;
  draftPath: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
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
        트리거 원문 JSON
        <textarea
          aria-label="트리거 원문 JSON"
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
      {pending && (
        <p className="muted">JSON을 적용하거나 되돌리면 항목 전환과 저장을 계속할 수 있어요.</p>
      )}
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
          트리거 적용
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
          입력 되돌리기
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  return (
    <section className="native-trigger-editor" aria-label="Lua · 트리거 편집기">
      <div className="native-trigger-heading">
        <div>
          <h3>Lua · 트리거</h3>
          <p className="muted">동작 원문은 Risu 문법과 실행 순서를 유지해요.</p>
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
          <AddIcon size={18} aria-hidden="true" /> 항목 추가
        </button>
      </div>
      {value.length > 0 && (
        <>
          <select
            aria-label="트리거 선택"
            disabled={disabled || pending}
            value={index}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {value.map((item, i) => (
              <option key={i} value={i}>
                {record(item) && typeof item.comment === 'string' && item.comment
                  ? item.comment
                  : `트리거 ${i + 1}`}
              </option>
            ))}
          </select>
          {record(entry) && (
            <label>
              이름
              <input
                aria-label="트리거 이름"
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
                  {effects.length > 1 ? `Lua 원문 ${effectIndex + 1}` : 'Lua 원문'}
                  <textarea
                    aria-label={effects.length > 1 ? `Lua 원문 ${effectIndex + 1}` : 'Lua 원문'}
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
                <summary>실행 조건과 순서 · 원문 편집</summary>
                {jsonEditor}
              </details>
            </>
          ) : (
            jsonEditor
          )}
        </>
      )}
      {value.length === 0 && !pending && (
        <p className="empty-state">등록된 Lua · 트리거가 없어요.</p>
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
            위로
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || pending || index >= value.length - 1}
            onClick={() => move(1)}
          >
            아래로
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
            항목 삭제
          </button>
        </div>
      )}
    </section>
  );
}
