import { useEffect, useState } from 'react';
import {
  createNativeRisuPresetProgram,
  nativeRisuPresetSource,
} from '../core/risu-native-preset.js';
import {
  validatePromptProgram,
  type PromptProgram,
  type PromptValue,
} from '../core/prompt-program.js';
import { PromptControlFields } from './PromptControlFields.js';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';

const text = (value: unknown) => (typeof value === 'string' ? value : '');
export function NativeRisuPresetEditor({
  program,
  onChange,
  onPendingDraftChange,
  values = {},
  onValuesChange,
}: {
  program: PromptProgram;
  onChange: (program: PromptProgram) => void;
  onPendingDraftChange?: (pending: boolean) => void;
  values?: Record<string, PromptValue>;
  onValuesChange?: (values: Record<string, PromptValue>) => void;
}) {
  const source = program.nativeRisuPreset!.preset;
  const [error, setError] = useState('');
  const [toggleDraft, setToggleDraft] = useBufferedEditorState(
    'prompt.native.toggles',
    text(source.customPromptTemplateToggle)
  );
  const [defaultDraft, setDefaultDraft] = useBufferedEditorState(
    'prompt.native.defaults',
    text(source.templateDefaultVariables)
  );
  const [regexDraft, setRegexDraft] = useBufferedEditorState(
    'prompt.native.regex',
    JSON.stringify(source.regex ?? source.presetRegex ?? [], null, 2)
  );
  const [pending, setPending] = useBufferedEditorState('prompt.native.pending', false);
  useUnappliedEditorField('prompt.native.source', pending);
  useEffect(() => {
    onPendingDraftChange?.(pending);
  }, [pending, onPendingDraftChange]);
  useEffect(() => () => onPendingDraftChange?.(false), [onPendingDraftChange]);
  const items = source.promptTemplate as Record<string, unknown>[];
  function update(patch: Record<string, unknown>) {
    try {
      const native = nativeRisuPresetSource({
        ...source,
        customPromptTemplateToggle: toggleDraft,
        templateDefaultVariables: defaultDraft,
        regex: Object.hasOwn(patch, 'regex') ? patch.regex : JSON.parse(regexDraft),
        ...patch,
      });
      const next = validatePromptProgram({ ...program, ...createNativeRisuPresetProgram(native) });
      onChange(next);
      setError('');
      setPending(false);
    } catch (caught) {
      setError((caught as Error).message);
      setPending(true);
    }
  }
  function item(index: number, patch: Record<string, unknown>) {
    update({
      promptTemplate: items.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    });
  }
  function move(index: number, delta: number) {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    update({ promptTemplate: next });
  }
  return (
    <section aria-label="Risu 프롬프트 원본 편집" className="native-risu-preset-editor">
      <p>Risu의 프롬프트 구성과 CBS를 그대로 편집해요. 모델 선택은 모델 설정에서 관리해요.</p>
      {error && <p role="alert">{error} · 입력은 유지했어요. 저장하려면 형식을 확인해 주세요.</p>}
      {!!program.controls.length && onValuesChange && (
        <fieldset>
          <legend>프리셋 기본 옵션</legend>
          <PromptControlFields
            program={program}
            values={values}
            onChange={(id, value) => onValuesChange({ ...values, [id]: value })}
          />
        </fieldset>
      )}
      {items.map((entry, index) => (
        <details key={index}>
          <summary>
            {index + 1}. {text(entry.name) || text(entry.type)}
          </summary>
          <div className="prompt-editor-row">
            <label>
              블록 이름
              <input
                aria-label={`${index + 1}번 블록 이름`}
                value={text(entry.name)}
                onChange={(event) => item(index, { name: event.target.value })}
              />
            </label>
            <label>
              종류
              <select
                aria-label={`${index + 1}번 블록 종류`}
                value={text(entry.type)}
                onChange={(event) => item(index, { type: event.target.value })}
              >
                {[
                  'plain',
                  'description',
                  'persona',
                  'lorebook',
                  'chat',
                  'authornote',
                  'postEverything',
                  'memory',
                  'cache',
                  'jailbreak',
                  'cot',
                ].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            {!['chat', 'memory', 'cache'].includes(text(entry.type)) && (
              <label>
                역할
                <select
                  aria-label={`${index + 1}번 블록 역할`}
                  value={text(entry.role ?? entry.role2) || 'system'}
                  onChange={(event) =>
                    item(index, {
                      [['plain', 'jailbreak', 'cot'].includes(text(entry.type)) ? 'role' : 'role2']:
                        event.target.value,
                    })
                  }
                >
                  <option value="system">시스템</option>
                  <option value="user">사용자</option>
                  <option value="bot">캐릭터</option>
                  <option value="assistant">어시스턴트</option>
                </select>
              </label>
            )}
          </div>
          {['plain', 'jailbreak', 'cot'].includes(text(entry.type)) ? (
            <label>
              프롬프트 본문
              <textarea
                aria-label={`${index + 1}번 프롬프트 본문`}
                rows={12}
                value={text(entry.text)}
                onChange={(event) => item(index, { text: event.target.value })}
              />
            </label>
          ) : (
            !['chat', 'cache', 'memory'].includes(text(entry.type)) && (
              <label>
                감싸는 문구 (CBS · {'{{slot}}'})
                <textarea
                  aria-label={`${index + 1}번 감싸는 문구`}
                  rows={4}
                  value={text(entry.innerFormat)}
                  onChange={(event) => item(index, { innerFormat: event.target.value })}
                />
              </label>
            )
          )}
          {entry.type === 'chat' && (
            <div className="prompt-editor-row">
              <label>
                시작 위치
                <input
                  type="number"
                  value={Number(entry.rangeStart ?? 0)}
                  onChange={(event) => item(index, { rangeStart: Number(event.target.value) })}
                />
              </label>
              <label>
                끝 위치
                <input
                  value={String(entry.rangeEnd ?? 'end')}
                  onChange={(event) =>
                    item(index, {
                      rangeEnd: event.target.value === 'end' ? 'end' : Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          )}
          <div>
            <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>
              위로
            </button>
            <button
              type="button"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              아래로
            </button>
            <button
              type="button"
              onClick={() => update({ promptTemplate: items.filter((_, i) => i !== index) })}
            >
              블록 삭제
            </button>
          </div>
        </details>
      ))}
      <button
        type="button"
        onClick={() =>
          update({
            promptTemplate: [
              ...items,
              { type: 'plain', role: 'system', text: '', name: '새 프롬프트' },
            ],
          })
        }
      >
        프롬프트 블록 추가
      </button>
      <details>
        <summary>토글과 기본 변수</summary>
        <label>
          Risu 토글 정의
          <textarea
            aria-label="Risu 토글 정의"
            rows={6}
            value={toggleDraft}
            onChange={(event) => {
              setToggleDraft(event.target.value);
              update({ customPromptTemplateToggle: event.target.value });
            }}
          />
        </label>
        <label>
          채팅 변수 기본값
          <textarea
            aria-label="Risu 기본 변수"
            rows={6}
            value={defaultDraft}
            onChange={(event) => {
              setDefaultDraft(event.target.value);
              update({ templateDefaultVariables: event.target.value });
            }}
          />
        </label>
      </details>
      <details>
        <summary>정규식 스크립트</summary>
        <label>
          Risu 정규식 원본 JSON
          <textarea
            aria-label="Risu 정규식 원본 JSON"
            rows={16}
            value={regexDraft}
            onChange={(event) => {
              setRegexDraft(event.target.value);
              try {
                const regex = JSON.parse(event.target.value);
                update({ regex });
              } catch {
                setError('정규식 JSON 형식을 확인해 주세요.');
                setPending(true);
              }
            }}
          />
        </label>
      </details>
    </section>
  );
}
