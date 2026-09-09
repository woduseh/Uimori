import { Switch } from './BooleanControls.js';
import { useEffect, useState } from 'react';
import type { ContentPackage } from '../core/content-package.js';
import { validateSourceSegmentPolicy, type SourceSegmentRule } from '../core/source-segments.js';

export function SourceSegmentsEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: ContentPackage;
  onChange: (value: ContentPackage) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [rules, setRules] = useState<SourceSegmentRule[]>(() =>
      structuredClone(value.sourceSegments?.rules ?? [])
    ),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  // Parent validation clones the package while unrelated module drafts are applied.
  // Reset only when this package or its saved segment definition actually changes.
  const definitionKey = JSON.stringify({ id: value.id, rules: value.sourceSegments?.rules ?? [] });
  useEffect(() => {
    setRules((JSON.parse(definitionKey) as { rules: SourceSegmentRule[] }).rules);
    setDirty(false);
    setError('');
  }, [definitionKey]);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const change = (next: SourceSegmentRule[]) => {
    setRules(next);
    setDirty(true);
    setError('');
  };
  const update = (index: number, part: Partial<SourceSegmentRule>) =>
    change(rules.map((rule, i) => (i === index ? { ...rule, ...part } : rule)));
  function add() {
    let index = rules.length + 1;
    while (rules.some((rule) => rule.id === `aside-${index}`)) index++;
    change([
      ...rules,
      {
        id: `aside-${index}`,
        kind: 'aside',
        open: `[[aside-${index}]]`,
        close: `[[/aside-${index}]]`,
        match: 'line',
        label: '별도 이야기',
      },
    ]);
  }
  function apply() {
    try {
      const sourceSegments = rules.length
        ? validateSourceSegmentPolicy({ version: 1, rules }, value.controls)
        : undefined;
      onChange({ ...value, sourceSegments });
      setDirty(false);
      setError('');
    } catch (caught) {
      setError((caught as Error).message);
    }
  }
  return (
    <section className="package-stack">
      <h3>별도 본문 구간</h3>
      <p className="muted">
        구분자로 둘러싼 본문을 접어서 표시할 수 있어요. 다음 요청에서 제외해도 원문과 번역에는
        보존돼요. 생성 지침은 이 자료의 지침에서 작성해 주세요.
      </p>
      {rules.map((rule, index) => (
        <fieldset className="package-entry" key={index}>
          <legend>{rule.label || `구간 ${index + 1}`}</legend>
          <label>
            구간 이름
            <input
              value={rule.label}
              onChange={(event) => update(index, { label: event.target.value })}
            />
          </label>
          <label>
            구간 ID
            <input
              value={rule.id}
              onChange={(event) => update(index, { id: event.target.value })}
            />
          </label>
          <label>
            시작 표식
            <input
              value={rule.open}
              onChange={(event) => update(index, { open: event.target.value })}
            />
          </label>
          <label>
            끝 표식
            <input
              value={rule.close}
              onChange={(event) => update(index, { close: event.target.value })}
            />
          </label>
          <label>
            표식 위치
            <select
              value={rule.match}
              onChange={(event) =>
                update(index, {
                  match: event.target.value as SourceSegmentRule['match'],
                  ...(event.target.value === 'inline' ? { title: false } : {}),
                })
              }
            >
              <option value="line">독립된 줄</option>
              <option value="inline">본문 안</option>
            </select>
          </label>
          <label>
            구간 역할
            <select
              value={rule.kind}
              onChange={(event) =>
                update(index, { kind: event.target.value as SourceSegmentRule['kind'] })
              }
            >
              <option value="aside">별도 이야기</option>
              <option value="annotation">주석·평가</option>
            </select>
          </label>
          <label>
            <Switch
              checked={rule.title ?? false}
              disabled={rule.match === 'inline'}
              onChange={(event) => update(index, { title: event.target.checked })}
            />
            시작 표식 뒤의 글을 제목으로 사용
          </label>
          <label>
            <Switch
              checked={rule.expanded ?? false}
              onChange={(event) => update(index, { expanded: event.target.checked })}
            />
            처음부터 펼쳐 표시
          </label>
          <label>
            <Switch
              checked={rule.exclude ?? false}
              onChange={(event) => update(index, { exclude: event.target.checked })}
            />
            다음 요청에서 제외
          </label>
          <label>
            최근 메시지 유지 범위
            <input
              type="number"
              min={0}
              max={10000}
              placeholder="제한 없음"
              value={rule.keepLastMessages ?? ''}
              onChange={(event) =>
                update(index, {
                  keepLastMessages:
                    event.target.value === '' ? undefined : Number(event.target.value),
                })
              }
            />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() => change(rules.filter((_, i) => i !== index))}
          >
            구간 제거
          </button>
        </fieldset>
      ))}
      <div className="package-role-actions">
        <button type="button" className="secondary" disabled={rules.length >= 32} onClick={add}>
          구간 추가
        </button>
        <button type="button" disabled={!dirty} onClick={apply}>
          구간 설정을 초안에 적용
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!dirty}
          onClick={() => {
            setRules(structuredClone(value.sourceSegments?.rules ?? []));
            setDirty(false);
            setError('');
          }}
        >
          구간 초안 되돌리기
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
