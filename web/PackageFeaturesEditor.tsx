import { useEffect, useRef, useState } from 'react';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import type { Content, Library } from '../core/product.js';
import type { PackageModuleRef } from '../core/package-features.js';
import { SourceSegmentsEditor } from './SourceSegmentsEditor.js';
import { ContentAvatar } from './ContentAvatar.js';
import { ContentPicker } from './ContentPicker.js';
import { api } from './api.js';
import './package-authoring.css';

const referenceKey = (ref: PackageModuleRef | null | undefined) =>
  ref ? `${ref.id}@${ref.revision}` : '';
type ReferenceStatus = { content?: Content; error?: string };

export function PackageFeaturesEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: ContentPackage;
  onChange: (value: ContentPackage) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null),
    [statuses, setStatuses] = useState<Record<string, ReferenceStatus>>({});
  const [selected, setSelected] = useState('');
  const [segmentsDirty, setSegmentsDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reload, setReload] = useState(0);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const actionVersion = useRef(0),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      actionVersion.current++;
    };
  }, []);
  const refsKey = JSON.stringify(value.modules ?? []);
  const scope = `${value.id}@${value.revision}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Switching packages invalidates actions and clears only the previous package's local drafts.
  useEffect(() => {
    actionVersion.current++;
    setBusy(false);
    setSegmentsDirty(false);
    setSelected('');
  }, [scope]);
  useEffect(() => {
    onDirtyChange?.(segmentsDirty || busy);
  }, [segmentsDirty, busy, onDirtyChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit reload retries the available module lists for this package.
  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.allSettled([api<Library>('/library?view=summary')])
      .then((results) => {
        if (!active) return;
        const [contents] = results;
        if (contents.status === 'fulfilled') setLibrary(contents.value);
        if (results.some((result) => result.status === 'rejected'))
          setError('자료 목록을 불러오지 못했어요. 다시 조회해 주세요.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [value.id, reload]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Module selections, package switches and explicit reloads govern reads, not draft object identity.
  useEffect(() => {
    let active = true;
    const refs = value.modules ?? [];
    Promise.all(
      refs.map(async (ref) => {
        try {
          const content = await api<Content>(`/content/${encodeURIComponent(ref.id)}`);
          return [
            referenceKey(ref),
            content.package ? { content } : { error: '연결한 자료가 공통 패키지가 아니에요.' },
          ] as const;
        } catch {
          return [referenceKey(ref), { error: '연결한 자료를 찾거나 읽을 수 없어요.' }] as const;
        }
      })
    ).then((items) => {
      if (active) setStatuses(Object.fromEntries(items));
    });
    return () => {
      active = false;
    };
  }, [value.id, refsKey, reload]);

  const currentAction = (request: number, scope: string) =>
    alive.current &&
    actionVersion.current === request &&
    `${latest.current.value.id}@${latest.current.value.revision}` === scope;
  async function act(work: (request: number, id: string) => Promise<void>) {
    if (busy) return;
    const request = ++actionVersion.current,
      id = scope;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(request, id);
    } catch (caught) {
      if (currentAction(request, id)) setError((caught as Error).message);
    } finally {
      if (currentAction(request, id)) setBusy(false);
    }
  }
  function update(part: Partial<ContentPackage>): boolean {
    try {
      latest.current.onChange(validateContentPackage({ ...latest.current.value, ...part }));
      setError('');
      setNotice('자료 초안에 반영했어요. 저장하면 다음 실행부터 사용해요.');
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    }
  }
  async function addModule() {
    const item = library?.contents.find((content) => referenceKey(content) === selected);
    if (!item) return;
    await act(async (request, id) => {
      const content = await api<Content>(`/content/${encodeURIComponent(item.id)}`);
      if (!currentAction(request, id)) return;
      if (!content.package) throw new Error('공통 패키지인 자료만 연결할 수 있어요.');
      const current = latest.current.value;
      if (content.id === current.id || current.modules?.some((ref) => ref.id === content.id))
        throw new Error('자기 자신이나 이미 연결한 자료는 추가할 수 없어요.');
      if (
        update({
          modules: [...(current.modules ?? []), { id: content.id, revision: content.revision }],
        })
      )
        setSelected('');
    });
  }
  return (
    <div className="package-stack package-authoring-editor" aria-label="패키지 모듈과 기능 편집">
      <section className="package-stack">
        <h3>함께 사용하는 모듈</h3>
        <p className="muted">
          이 자료를 장착하면 아래 모듈을 함께 사용해요. 여러 자료가 같은 모듈을 요구해도 한 번만
          포함하며 채팅별 선택값을 사용해요.
        </p>
        {(value.modules ?? []).map((ref) => {
          const status = statuses[referenceKey(ref)];
          return (
            <fieldset className="package-entry" key={ref.id}>
              <legend>{status?.content?.title ?? ref.id}</legend>
              <ContentAvatar content={status?.content} title={status?.content?.title ?? ref.id} />
              <small>현재 저장된 모듈을 사용해요.</small>
              {status?.error && (
                <p className="error" role="alert">
                  {status.error} 자료를 다시 확인하거나 참조를 해제해 주세요.
                </p>
              )}
              <div className="package-role-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    update({ modules: value.modules?.filter((item) => item.id !== ref.id) });
                  }}
                >
                  모듈 참조 해제
                </button>
              </div>
            </fieldset>
          );
        })}
        <ContentPicker
          library={library ?? { contents: [], connections: [], models: [], assets: [] }}
          value={selected}
          onChange={setSelected}
          role="module"
          label="연결할 공통 모듈"
          disabled={busy || loading || !library}
          excludeIds={[value.id, ...(value.modules ?? []).map((ref) => ref.id)]}
        />
        <button
          type="button"
          className="secondary"
          disabled={!selected || busy}
          onClick={() => void addModule()}
        >
          필수 모듈 연결
        </button>
        <small>서재에서 모듈을 수정하면 다음 실행부터 최신 내용을 사용해요.</small>
      </section>
      <SourceSegmentsEditor value={value} onChange={onChange} onDirtyChange={setSegmentsDirty} />
      {loading && <p role="status">자료와 기능 목록을 확인하는 중이에요…</p>}
      {busy && <p role="status">선택한 자료를 확인하는 중이에요…</p>}
      <button
        type="button"
        className="secondary"
        disabled={busy || loading}
        onClick={() => {
          setError('');
          setReload((current) => current + 1);
        }}
      >
        자료와 기능 목록 새로고침
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
