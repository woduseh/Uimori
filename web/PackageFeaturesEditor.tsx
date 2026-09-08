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
  const [revisionDrafts, setRevisionDrafts] = useState<Record<string, string>>({}),
    [segmentsDirty, setSegmentsDirty] = useState(false),
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
    setRevisionDrafts({});
    setSegmentsDirty(false);
    setSelected('');
  }, [scope]);
  useEffect(() => {
    onDirtyChange?.(Object.keys(revisionDrafts).length > 0 || segmentsDirty || busy);
  }, [revisionDrafts, segmentsDirty, busy, onDirtyChange]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pinned reference keys, package switches and explicit reloads govern reads, not draft object identity.
  useEffect(() => {
    let active = true;
    const refs = value.modules ?? [];
    Promise.all(
      refs.map(async (ref) => {
        try {
          const content = await api<Content>(
            `/revisions/content/${encodeURIComponent(ref.id)}/${ref.revision}`
          );
          return [
            referenceKey(ref),
            content.package ? { content } : { error: '고정 버전이 공통 패키지가 아니에요.' },
          ] as const;
        } catch {
          return [
            referenceKey(ref),
            { error: '고정한 자료 버전을 찾거나 읽을 수 없어요.' },
          ] as const;
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
      setNotice('자료 초안에 반영했어요. 자료를 저장하면 새 버전으로 고정돼요.');
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
      const content = await api<Content>(
        `/revisions/content/${encodeURIComponent(item.id)}/${item.revision}`
      );
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
  async function applyRevision(ref: PackageModuleRef) {
    const text = revisionDrafts[ref.id],
      revision = Number(text);
    if (!text?.trim() || !Number.isSafeInteger(revision) || revision < 1) {
      setError('1 이상의 버전 번호를 입력해 주세요.');
      return;
    }
    await act(async (request, id) => {
      const content = await api<Content>(
        `/revisions/content/${encodeURIComponent(ref.id)}/${revision}`
      );
      if (!currentAction(request, id)) return;
      if (!content.package) throw new Error('공통 패키지인 자료 버전만 연결할 수 있어요.');
      if (!latest.current.value.modules?.some((item) => referenceKey(item) === referenceKey(ref)))
        return;
      if (
        update({
          modules: latest.current.value.modules.map((item) =>
            item.id === ref.id ? { id: ref.id, revision } : item
          ),
        })
      )
        setRevisionDrafts((current) => {
          const next = { ...current };
          delete next[ref.id];
          return next;
        });
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
          const status = statuses[referenceKey(ref)],
            draft = revisionDrafts[ref.id];
          return (
            <fieldset className="package-entry" key={ref.id}>
              <legend>{status?.content?.title ?? ref.id}</legend>
              <ContentAvatar content={status?.content} title={status?.content?.title ?? ref.id} />
              <small>
                {ref.id} · 고정 버전 v{ref.revision}
              </small>
              {status?.error && (
                <p className="error" role="alert">
                  {status.error} 참조를 해제하거나 읽을 수 있는 버전으로 바꿔 주세요.
                </p>
              )}
              <label>
                고정 버전
                <input
                  aria-label={`${ref.id} 고정 버전`}
                  type="number"
                  min={1}
                  disabled={busy}
                  value={draft ?? String(ref.revision)}
                  onChange={(event) =>
                    setRevisionDrafts((current) => {
                      const next = { ...current };
                      if (event.target.value === String(ref.revision)) delete next[ref.id];
                      else next[ref.id] = event.target.value;
                      return next;
                    })
                  }
                />
              </label>
              <div className="package-role-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={draft === undefined || busy}
                  onClick={() => void applyRevision(ref)}
                >
                  버전 확인 후 적용
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={draft === undefined || busy}
                  onClick={() =>
                    setRevisionDrafts((current) => {
                      const next = { ...current };
                      delete next[ref.id];
                      return next;
                    })
                  }
                >
                  버전 초안 되돌리기
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (update({ modules: value.modules?.filter((item) => item.id !== ref.id) }))
                      setRevisionDrafts((current) => {
                        const next = { ...current };
                        delete next[ref.id];
                        return next;
                      });
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
        <small>
          선택한 버전을 고정해요. 서재에서 모듈을 수정해도 연결한 버전은 자동으로 바뀌지 않아요.
        </small>
      </section>
      <SourceSegmentsEditor value={value} onChange={onChange} onDirtyChange={setSegmentsDirty} />
      {loading && <p role="status">자료와 기능 목록을 확인하는 중이에요…</p>}
      {busy && <p role="status">선택한 자료 버전을 확인하는 중이에요…</p>}
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
