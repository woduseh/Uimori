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

const types: Record<string, string> = {
  editinput: '입력문 수정',
  editoutput: '출력문 수정',
  editprocess: '요청 데이터 수정',
  editdisplay: '화면 표시 수정',
  edittrans: '번역문 수정 · 실행 미지원',
  disabled: '비활성',
};
const normalFlags = [
  ['g', '전체 일치'],
  ['i', '대소문자 무시'],
  ['m', '여러 줄'],
  ['s', '줄바꿈 포함'],
  ['u', '유니코드'],
] as const;
const actions = [
  ['move_top', '일치 내용을 맨 위로'],
  ['move_bottom', '일치 내용을 맨 아래로'],
  ['cbs', '찾을 표현식의 CBS 해석'],
  ['no_end_nl', '끝의 자동 줄바꿈 생략'],
] as const;

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
    <section className="native-regex-editor" aria-label="정규식 편집기">
      <fieldset className="native-regex-fields" disabled={disabled || pending}>
        <NativeCollectionEditor
          label="정규식"
          items={value.map((entry, index) => ({
            title: regexRecord(entry)
              ? regexText(entry.comment) || `정규식 ${index + 1}`
              : `항목 ${index + 1}`,
            subtitle: regexRecord(entry)
              ? (types[regexText(entry.type)] ?? '알 수 없는 단계')
              : '원문 확인 필요',
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
            if (!regexRecord(entry))
              return <p className="muted">고급 JSON에서 이 항목을 확인해 주세요.</p>;
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
                    이름
                    <input
                      aria-label="정규식 이름"
                      value={regexText(entry.comment)}
                      onChange={(e) => edit({ comment: e.target.value })}
                    />
                  </label>
                  <label>
                    적용 단계
                    <select
                      aria-label="정규식 적용 단계"
                      value={type}
                      onChange={(e) => edit({ type: e.target.value })}
                    >
                      {!Object.hasOwn(types, type) && (
                        <option value={type}>{type || '미지정'} · 실행 미지원</option>
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
                  찾을 표현식 · IN
                  <textarea
                    className="native-regex-find"
                    aria-label="정규식 찾을 표현식"
                    rows={3}
                    spellCheck={false}
                    value={regexText(entry.in ?? entry.find)}
                    onChange={(e) => edit({ in: e.target.value })}
                  />
                </label>
                <label>
                  바꿀 내용 · OUT
                  <textarea
                    className="native-regex-replacement"
                    aria-label="정규식 바꿀 내용"
                    rows={7}
                    spellCheck={false}
                    value={regexText(entry.out ?? entry.replace)}
                    onChange={(e) => edit({ out: e.target.value })}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={entry.ableFlag === true}
                    onChange={(e) =>
                      edit({
                        ableFlag: e.target.checked,
                        ...(e.target.checked && !flag ? { flag: 'g' } : {}),
                      })
                    }
                  />
                  사용자 지정 플래그
                </label>
                {entry.ableFlag === true && (
                  <div className="native-regex-flag-fields">
                    <div className="native-regex-flags" role="group" aria-label="일반 플래그">
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
                      <summary>고급 플래그</summary>
                      <div className="native-regex-actions">
                        {actions.map(([key, title]) => (
                          <label className="check" key={key}>
                            <input
                              type="checkbox"
                              checked={parsed.actions.includes(key)}
                              onChange={() => edit({ flag: toggleNativeRegexAction(flag, key) })}
                            />
                            {title}
                          </label>
                        ))}
                      </div>
                      <label>
                        실행 우선순위 · 큰 값부터
                        <input
                          aria-label="정규식 실행 우선순위"
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
                        플래그 원문
                        <input
                          aria-label="정규식 플래그 원문"
                          value={flag}
                          spellCheck={false}
                          onChange={(e) => edit({ flag: e.target.value })}
                        />
                      </label>
                    </details>
                  </div>
                )}
                {(type === 'edittrans' || (!Object.hasOwn(types, type) && type !== 'disabled')) && (
                  <p className="muted">
                    이 적용 단계는 Uimori에서 실행하지 않아요. 원문은 유지돼요.
                  </p>
                )}
                {entry.ableFlag === true && unsupported.length > 0 && (
                  <p className="muted">
                    실행 미지원 플래그: {unsupported.join(', ')}. 원문은 유지돼요.
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
                    정규식 복제
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
        <summary>고급 JSON 편집</summary>
        <label>
          Risu 정규식 JSON
          <textarea
            aria-label="Risu 정규식 JSON"
            rows={12}
            spellCheck={false}
            disabled={disabled}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </label>
        {pending && (
          <p className="muted">
            저장을 누르면 JSON도 함께 저장해요. 폼을 계속 편집하려면 먼저 폼에 반영해 주세요.
          </p>
        )}
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
            폼에 반영
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
            입력 되돌리기
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </details>
    </section>
  );
}
