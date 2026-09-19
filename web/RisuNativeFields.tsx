import { detectRisuImageHandoff } from '../core/risu-image-handoff.js';
import { RisuImageHandoffFields } from './RisuImageHandoffFields.js';
import { useEffect, useState } from 'react';
import type { RisuContent } from '../core/risu-content.js';
import {
  nativeRisuBackground,
  nativeRisuExtension,
  nativeRisuLore,
  nativeRisuRegex,
  nativeRisuTriggers,
  validateRisuContentSource,
  type RisuContentSource,
} from '../core/risu-native.js';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
import { PackagePortraitEditor } from './PackagePortraitEditor.js';
import { PackageFeaturesEditor } from './PackageFeaturesEditor.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
type SourcePart = 'greetings' | 'lore' | 'regex' | 'triggers' | 'card' | 'module';

/** Native authoring never edits the derived package DSL. Unknown Risu fields stay in their document. */
export function RisuNativeFields({
  value,
  onChange,
  onDraftChange,
  onPortraitBusy,
}: {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDraftChange: (dirty: boolean) => void;
  onPortraitBusy: (busy: boolean) => void;
}) {
  const native = value.nativeRisu;
  const standalone = !Object.keys(native.card).length && !!native.module;
  const [part, setPart] = useState<SourcePart>('lore');
  const [draft, setDraft] = useBufferedEditorState<{ part: SourcePart; text: string } | null>(
    'package.native.source',
    null
  );
  const [error, setError] = useState('');
  const [modulesDirty, setModulesDirty] = useState(false);
  useUnappliedEditorField('package.native.source', !!draft);
  useEffect(() => {
    onDraftChange(!!draft || modulesDirty);
  }, [draft, modulesDirty, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);
  const update = (next: RisuContentSource) => {
    const name = string(standalone ? next.module?.name : next.card.name);
    onChange({
      ...value,
      title: name,
      nativeRisu: next,
      imageHandoff: detectRisuImageHandoff(next, value.imageHandoff),
    });
  };
  const field = (key: string, next: string) =>
    update({
      ...native,
      ...(standalone
        ? { module: { ...native.module, [key]: next } }
        : { card: { ...native.card, [key]: next } }),
    });
  const extension = (key: string, next: string) =>
    update({
      ...native,
      card: {
        ...native.card,
        extensions: {
          ...object(native.card.extensions),
          risuai: { ...nativeRisuExtension(native), [key]: next },
        },
      },
    });
  const selectedPart = draft?.part ?? part;
  const source = {
    greetings: native.card.alternate_greetings ?? [],
    lore: nativeRisuLore(native),
    regex: native.module
      ? (native.module.regex ?? [])
      : (nativeRisuExtension(native).customScripts ?? []),
    triggers: native.module
      ? (native.module.trigger ?? [])
      : (nativeRisuExtension(native).triggerscript ?? []),
    card: native.card,
    module: native.module ?? {},
  }[selectedPart];
  function applyJson() {
    if (!draft) return;
    try {
      const parsed: unknown = JSON.parse(draft.text);
      const next = structuredClone(native);
      if (draft.part === 'card' || draft.part === 'module') {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('JSON 객체를 입력해 주세요.');
        next[draft.part] = parsed as Record<string, unknown>;
      } else {
        if (!Array.isArray(parsed)) throw new Error('JSON 배열을 입력해 주세요.');
        if (draft.part === 'greetings') {
          if (parsed.some((item) => typeof item !== 'string'))
            throw new Error('시작문은 문자열 배열로 입력해 주세요.');
          next.card.alternate_greetings = parsed;
        } else {
          if (parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item)))
            throw new Error('각 항목은 JSON 객체여야 해요.');
          if (draft.part === 'lore') {
            if (next.module?.lorebook != null || standalone)
              next.module = { ...next.module, lorebook: parsed };
            else
              next.card.character_book = { ...object(next.card.character_book), entries: parsed };
          } else if (next.module)
            next.module[draft.part === 'regex' ? 'regex' : 'trigger'] = parsed;
          else
            next.card.extensions = {
              ...object(next.card.extensions),
              risuai: {
                ...nativeRisuExtension(next),
                [draft.part === 'regex' ? 'customScripts' : 'triggerscript']: parsed,
              },
            };
        }
      }
      update(validateRisuContentSource(next));
      setDraft(null);
      setError('');
    } catch (caught) {
      setError((caught as Error).message);
    }
  }
  return (
    <div className="library-basic-fields full">
      <p className="muted">
        Risu 원문을 편집해요. 저장하면 본문·시작문·로어 목록이 함께 갱신돼요. CBS와 Lua는 원래
        문법을 그대로 사용해요.
      </p>
      <PackagePortraitEditor value={value} onChange={onChange} onDirtyChange={onPortraitBusy} />
      <label className="full">
        이름
        <input
          aria-label="Risu 자료 이름"
          value={string(standalone ? native.module?.name : native.card.name)}
          maxLength={200}
          required
          onChange={(event) => field('name', event.target.value)}
        />
      </label>
      {standalone ? (
        <label className="full">
          모듈 설명
          <textarea
            rows={4}
            value={string(native.module?.description)}
            onChange={(event) => field('description', event.target.value)}
          />
        </label>
      ) : (
        <>
          {(
            [
              ['description', '캐릭터 설정', 10],
              ['personality', '성격', 4],
              ['scenario', '상황', 4],
              ['first_mes', '기본 시작문', 10],
              ['mes_example', '대화 예시', 5],
              ['creator_notes', '제작자 코멘트', 4],
            ] as const
          ).map(([key, label, rows]) => (
            <label className="full" key={key}>
              {label}
              <textarea
                aria-label={label}
                rows={rows}
                value={string(native.card[key])}
                onChange={(event) => field(key, event.target.value)}
              />
            </label>
          ))}
          <details className="full">
            <summary>카드 프롬프트·배경·기본 변수</summary>
            {(
              [
                ['system_prompt', '카드 시스템 프롬프트'],
                ['post_history_instructions', '후처리 지침'],
              ] as const
            ).map(([key, label]) => (
              <label className="full" key={key}>
                {label}
                <textarea
                  rows={5}
                  value={string(native.card[key])}
                  onChange={(event) => field(key, event.target.value)}
                />
              </label>
            ))}
            <label className="full">
              배경 HTML / CSS
              <textarea
                rows={8}
                value={nativeRisuBackground(native)}
                onChange={(event) => extension('backgroundHTML', event.target.value)}
              />
            </label>
            <label className="full">
              기본 변수
              <textarea
                rows={5}
                value={string(nativeRisuExtension(native).defaultVariables)}
                onChange={(event) => extension('defaultVariables', event.target.value)}
              />
            </label>
          </details>
        </>
      )}
      <PackageFeaturesEditor value={value} onChange={onChange} onDirtyChange={setModulesDirty} />
      <label className="full">
        로어 선택 방식
        <select
          value={value.loreActivation?.mode ?? 'model'}
          onChange={(event) =>
            onChange({
              ...value,
              loreActivation: {
                ...value.loreActivation,
                mode: event.target.value as 'model' | 'discoverable',
              },
            })
          }
        >
          <option value="model">JEV 관련성 판단</option>
          <option value="discoverable">필요할 때 모델이 읽기</option>
        </select>
      </label>
      {value.imageHandoff && (
        <RisuImageHandoffFields
          policy={value.imageHandoff}
          selected={value.imageHandoff.ranges
            .filter((range) => range.enabled)
            .map((range) => range.id)}
          onChange={(ids) =>
            onChange({
              ...value,
              imageHandoff: {
                ...value.imageHandoff!,
                ranges: value.imageHandoff!.ranges.map((range) => ({
                  ...range,
                  enabled: ids.includes(range.id),
                })),
              },
            })
          }
        />
      )}
      <details className="full" open={!!draft}>
        <summary>시작문·로어·스크립트 원문 편집</summary>
        <p className="muted">
          로어 {nativeRisuLore(native).length}개 · 정규식 {nativeRisuRegex(native).length}개 ·
          트리거 {nativeRisuTriggers(native).length}개. JSON을 적용한 다음 변경사항을 저장해 주세요.
        </p>
        <label className="full">
          편집 대상
          <select
            aria-label="Risu 원문 편집 대상"
            value={selectedPart}
            disabled={!!draft}
            onChange={(event) => setPart(event.target.value as SourcePart)}
          >
            {!standalone && <option value="greetings">대체 시작문</option>}
            <option value="lore">로어</option>
            <option value="regex">정규식</option>
            <option value="triggers">트리거 / Lua</option>
            {!standalone && <option value="card">카드 전체 JSON</option>}
            {native.module && <option value="module">모듈 전체 JSON</option>}
          </select>
        </label>
        <textarea
          className="full"
          aria-label="Risu 원문 JSON"
          rows={18}
          spellCheck={false}
          value={draft?.text ?? JSON.stringify(source, null, 2)}
          onChange={(event) => setDraft({ part: selectedPart, text: event.target.value })}
        />
        <div className="form-actions">
          <button type="button" disabled={!draft} onClick={applyJson}>
            JSON 적용
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!draft}
            onClick={() => {
              setDraft(null);
              setError('');
            }}
          >
            JSON 수정 취소
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </details>
    </div>
  );
}
