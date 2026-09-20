import { useEffect, useState } from 'react';
import { NativeCollectionEditor } from './NativeCollectionEditor.js';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
import {
  addNativeToggleLine,
  editNativeToggleLine,
  moveNativeToggleLine,
  nativeToggleGroupWarnings,
  nativeToggleTypes,
  parseNativeToggleLines,
  removeNativeToggleLine,
  type NativeToggleDefinition,
  type NativeToggleType,
} from './native-risu-toggle-editor.js';
import './native-risu-toggle-editor.css';

const typeNames: Record<NativeToggleType, string> = {
  toggle: '켜기 / 끄기',
  select: '선택 목록',
  text: '한 줄 입력',
  textarea: '여러 줄 입력',
  divider: '구분선',
  caption: '안내 문구',
  group: '그룹 시작',
  groupEnd: '그룹 끝',
};

export function NativeRisuToggleEditor({
  value,
  onChange,
  draftPath = 'nativeRisuPreset.customPromptTemplateToggle',
  onPendingChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  draftPath?: string;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useBufferedEditorState(draftPath, value, { syncPristineInitial: true });
  const pending = raw !== value;
  useUnappliedEditorField(draftPath, pending);
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  const [rawOpen, setRawOpen] = useState(pending);
  useEffect(() => {
    if (pending) setRawOpen(true);
  }, [pending]);
  const [newType, setNewType] = useState<NativeToggleType>('toggle');
  const [error, setError] = useState('');
  const lines = parseNativeToggleLines(value);
  const warnings = nativeToggleGroupWarnings(lines);
  const unknown = lines.filter((line) => !line.definition && line.raw.trim()).length;

  function write(next: () => string) {
    try {
      const text = next();
      onChange(text);
      setRaw(text);
      setError('');
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <section className="native-toggle-editor" aria-label="토글 정의 편집기">
      {unknown > 0 && <p className="muted">해석하지 못한 {unknown}개 줄은 원문 그대로 보존해요.</p>}
      {warnings.map((warning) => (
        <p className="muted" key={warning}>
          {warning}
        </p>
      ))}
      <fieldset className="native-toggle-fields" disabled={disabled || pending}>
        <label className="native-toggle-add-type">
          추가할 항목 종류
          <select
            aria-label="추가할 토글 종류"
            value={newType}
            onChange={(event) => setNewType(event.target.value as NativeToggleType)}
          >
            {nativeToggleTypes.map((type) => (
              <option key={type} value={type}>
                {typeNames[type]}
              </option>
            ))}
          </select>
        </label>
        <NativeCollectionEditor
          label="토글 정의"
          items={lines.map((line, index) => ({
            title:
              line.definition?.label ||
              line.definition?.key ||
              (line.definition ? typeNames[line.definition.type] : line.raw.trim() || '빈 줄'),
            subtitle: `${index + 1}행 · ${line.definition ? typeNames[line.definition.type] : '원문 보존'}`,
          }))}
          onAdd={() => write(() => addNativeToggleLine(value, newType))}
          onMove={(index, delta) => write(() => moveNativeToggleLine(value, index, delta))}
          onRemove={(index) => write(() => removeNativeToggleLine(value, index))}
        >
          {(index) => {
            const line = lines[index];
            const item = line?.definition;
            if (!item)
              return (
                <div className="native-toggle-form">
                  <p className="muted">이 줄은 아래 원문 편집에서 수정할 수 있어요.</p>
                  <pre>{line?.raw || '(빈 줄)'}</pre>
                </div>
              );
            const edit = (patch: Partial<NativeToggleDefinition>) =>
              write(() => editNativeToggleLine(value, index, patch));
            const control = ['toggle', 'select', 'text', 'textarea'].includes(item.type);
            return (
              <div className="native-toggle-form">
                <label>
                  항목 종류
                  <select
                    aria-label="토글 항목 종류"
                    value={item.type}
                    onChange={(event) => edit({ type: event.target.value as NativeToggleType })}
                  >
                    {nativeToggleTypes
                      .filter(
                        (type) =>
                          ['toggle', 'select', 'text', 'textarea'].includes(type) === control
                      )
                      .map((type) => (
                        <option key={type} value={type}>
                          {typeNames[type]}
                        </option>
                      ))}
                  </select>
                </label>
                {(control || item.key !== '') && (
                  <label>
                    변수 키
                    <input
                      aria-label="토글 변수 키"
                      value={item.key}
                      onChange={(event) => edit({ key: event.target.value })}
                    />
                  </label>
                )}
                {item.type !== 'groupEnd' && (
                  <label>
                    표시 이름 / 문구
                    <input
                      aria-label="토글 표시 이름"
                      value={item.label}
                      onChange={(event) => edit({ label: event.target.value })}
                    />
                  </label>
                )}
                {item.type === 'select' && (
                  <label>
                    선택지 · 쉼표로 구분
                    <input
                      aria-label="토글 선택지"
                      value={item.options}
                      onChange={(event) => edit({ options: event.target.value })}
                    />
                    <small className="muted">
                      순서와 빈 선택지를 그대로 유지해요. 채팅 값은 0부터 시작하는 선택지 번호예요.
                    </small>
                  </label>
                )}
                <details>
                  <summary>이 항목의 원문</summary>
                  <pre>{line.raw}</pre>
                  {control && (
                    <p className="muted">
                      프롬프트 참조: <code>{`{{getglobalvar::toggle_${item.key}}}`}</code>
                    </p>
                  )}
                </details>
              </div>
            );
          }}
        </NativeCollectionEditor>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <details
        className="native-toggle-raw"
        open={rawOpen}
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary>토글 정의 원문</summary>
        <label>
          한 줄에 한 항목
          <textarea
            aria-label="토글 정의 원문"
            value={raw}
            disabled={disabled}
            rows={12}
            spellCheck={false}
            onChange={(event) => setRaw(event.target.value)}
          />
        </label>
        {pending && (
          <p className="muted">
            적용하지 않은 원문이 있어요. 원문을 적용하면 목록 편집을 계속할 수 있어요.
          </p>
        )}
        <button type="button" disabled={disabled || !pending} onClick={() => write(() => raw)}>
          원문 적용
        </button>
      </details>
    </section>
  );
}
