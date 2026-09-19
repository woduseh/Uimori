import type { RisuImageHandoff } from '../core/risu-image-handoff.js';
import { SelectionCheckbox } from './BooleanControls.js';

export function RisuImageHandoffFields({
  policy,
  selected,
  onChange,
  disabled = false,
}: {
  policy: RisuImageHandoff;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <details className="full risu-import-preview">
      <summary>이미지 선택·삽입을 Uimori에 맡기기 ({policy.ranges.length}개 범위)</summary>
      <p className="muted">
        채팅의 자동 이미지 배치가 켜졌을 때만 선택한 지시를 작문 입력에서 빼고 이미지 선택 모델에
        전달해요. 원문은 유지해요. 인식한 태그: {policy.tagTemplates.join(', ')}
      </p>
      {!policy.ranges.length && (
        <p>이미지 표시 태그는 찾았지만 안전하게 분리할 지시 범위를 찾지 못했어요.</p>
      )}
      {policy.ranges.map((range) => (
        <details key={range.id}>
          <summary>
            {range.field} · {range.start}–{range.end}
            {range.confidence === 'candidate'
              ? ' · 직접 확인이 필요한 후보'
              : ' · 구분된 이미지 지시'}
          </summary>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto' }}>
            {range.text}
          </pre>
          <label>
            <SelectionCheckbox
              disabled={disabled}
              checked={selected.includes(range.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, range.id]
                    : selected.filter((id) => id !== range.id)
                )
              }
            />{' '}
            이 범위를 이미지 선택에 사용
          </label>
        </details>
      ))}
    </details>
  );
}
