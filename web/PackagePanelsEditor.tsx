import { useEffect, useRef, useState } from 'react';
import type { ContentPackage } from '../core/content-package.js';
import {
  renderPackagePanels,
  validatePackagePanels,
  type PackagePanel,
} from '../core/package-panels.js';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
import { PackagePanelFrame } from './PackagePanelFrame.js';

const example: PackagePanel[] = [
  {
    id: 'state',
    title: '현재 상태',
    template: [
      { kind: 'text', text: '<section><h3>현재 상태</h3><pre>' },
      { kind: 'value', expression: { context: ['state'] } },
      {
        kind: 'text',
        text: '</pre><details><summary>안내</summary><p>상태와 행동에서 정의한 값을 표시해요.</p></details></section>',
      },
    ],
    css: 'section { padding: 12px; border: 1px solid #8886; border-radius: 12px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }',
  },
];
export function PackagePanelsEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: ContentPackage;
  onChange: (value: ContentPackage) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const serialized = JSON.stringify(value.panels ?? [], null, 2);
  const [draft, setDraft] = useBufferedEditorState('package.panels', serialized);
  const previous = useRef(serialized);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = draft !== serialized;
  useUnappliedEditorField('package.panels', dirty);
  useEffect(() => {
    if (previous.current !== serialized) {
      const before = previous.current;
      setDraft((current) => (current === before ? serialized : current));
      previous.current = serialized;
    }
  }, [serialized, setDraft]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const preview = renderPackagePanels(value, {
    state: value.behavior?.initialState ?? null,
    identity: { bot: { name: value.identity?.name ?? value.title }, user: { name: 'User' } },
  });
  return (
    <details className="package-stack package-panels-editor">
      <summary>커스텀 패널 ({value.panels?.length ?? 0})</summary>
      <p className="muted">
        현재 채팅에 표시할 상태창과 선택 화면을 만들어요. HTML/CSS는 패널 안에만 적용되고 버튼은 이
        자료의 사용자 행동에 연결해요.
      </p>
      <label>
        패널 JSON
        <textarea
          aria-label="패널 JSON"
          rows={14}
          spellCheck={false}
          value={draft}
          maxLength={1_000_000}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
            setNotice('');
          }}
        />
      </label>
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            try {
              const panels = validatePackagePanels(JSON.parse(draft), value);
              onChange({ ...value, panels });
              setDraft(JSON.stringify(panels, null, 2));
              setError('');
              setNotice('패널을 적용했어요. 자료를 저장하면 채팅에 사용할 수 있어요.');
            } catch (caught) {
              setError(
                `패널 형식을 확인해 주세요. 초안은 유지돼요. (${(caught as Error).message})`
              );
            }
          }}
        >
          패널 검증 후 적용
        </button>
        {!value.panels?.length && !dirty && (
          <button
            type="button"
            className="secondary"
            onClick={() => setDraft(JSON.stringify(example, null, 2))}
          >
            패널 예제 넣기
          </button>
        )}
        {dirty && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setDraft(serialized);
              setError('');
              setNotice('');
            }}
          >
            패널 편집 취소
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!!preview.length && (
        <section aria-label="패널 미리보기">
          <p className="muted">적용한 패널을 초깃값으로 미리 봐요. 행동은 실행하지 않아요.</p>
          {preview.map((panel) => (
            <PackagePanelFrame key={panel.id} panel={panel} disabled onAction={async () => {}} />
          ))}
        </section>
      )}
    </details>
  );
}
