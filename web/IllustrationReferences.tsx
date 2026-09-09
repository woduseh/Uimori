import { useCallback, useEffect, useRef, useState } from 'react';
import type { IllustrationReferenceRole, IllustrationReferences } from '../core/illustration.js';
import { api } from './api.js';
import { SaveButton } from './SaveButton.js';
import './settings-actions.css';
import './illustrations.css';

type Candidate = {
  ref: string;
  title: string;
  url: string;
  mime: string;
  role: IllustrationReferenceRole | null;
};
type Loaded = IllustrationReferences & { candidates: Candidate[] };

/** Per-chat reference roles for Codex illustration turns; ComfyUI ignores them for now. */
export function IllustrationReferencesEditor({
  chatId,
  refreshKey,
  onDirtyChange,
  onError,
}: {
  chatId: string;
  refreshKey: string | number;
  onDirtyChange?: (dirty: boolean) => void;
  onError: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roles, setRoles] = useState<Record<string, IllustrationReferenceRole | ''>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const load = useCallback(async () => {
    try {
      const value = await api<Loaded>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`
      );
      setLoaded(value);
      return value;
    } catch (error) {
      onError((error as Error).message);
      return null;
    }
  }, [chatId, onError]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reader asset changes reload candidates; a dirty draft keeps its roles.
  useEffect(() => {
    void load().then((value) => {
      if (value && !dirty)
        setRoles(Object.fromEntries(value.candidates.map((item) => [item.ref, item.role ?? ''])));
    });
  }, [load, refreshKey]);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  if (!loaded) return null;
  const selected = loaded.candidates.filter((item) => roles[item.ref]);
  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setMessage('');
    try {
      const value = await api<IllustrationReferences>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`,
        {
          expectedRevision: loaded.revision,
          references: selected.map((item) => ({ ref: item.ref, role: roles[item.ref] })),
        },
        'PUT'
      );
      setLoaded({ ...loaded, revision: value.revision, references: value.references });
      setDirty(false);
      setMessage('삽화 참조 이미지를 저장했어요. 다음 삽화 요청부터 사용해요.');
    } catch (error) {
      onError((error as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return (
    <section
      className="illustration-references"
      aria-label="삽화 참조 이미지"
      data-testid="illustration-references"
    >
      <h4>삽화 참조 이미지</h4>
      <small>
        Codex 삽화 생성 때 함께 보내는 이미지예요. 캐릭터 디자인은 인물의 외형을, 그림체는 화풍만
        참고하도록 구분해서 보내요. 8개까지 선택하고, ComfyUI 경로에서는 아직 사용하지 않아요.
      </small>
      {!loaded.candidates.length && (
        <p className="muted">이 채팅에 등록한 이미지나 장착한 자료의 이미지가 없어요.</p>
      )}
      <div className="asset-grid">
        {loaded.candidates.map((item) => (
          <figure key={item.ref}>
            <img src={item.url} alt={item.title} loading="lazy" />
            <figcaption>{item.title}</figcaption>
            <select
              aria-label={`${item.title} 참조 역할`}
              value={roles[item.ref] ?? ''}
              disabled={saving || (!roles[item.ref] && selected.length >= 8)}
              onChange={(event) => {
                setRoles({
                  ...roles,
                  [item.ref]: event.target.value as IllustrationReferenceRole | '',
                });
                setDirty(true);
                setMessage('');
              }}
            >
              <option value="">사용 안 함</option>
              <option value="character">캐릭터 디자인</option>
              <option value="style">그림체</option>
            </select>
          </figure>
        ))}
      </div>
      <div className="form-actions settings-save-actions">
        <SaveButton
          type="button"
          label="삽화 참조 저장"
          aria-busy={saving}
          disabled={!dirty || saving}
          onClick={() => void save()}
        />
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
