import { TransientNotice } from './TransientNotice.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IllustrationReferenceRole, IllustrationReferences } from '../core/illustration.js';
import { api } from './api.js';
import { SaveButton } from './SaveButton.js';
import { RefreshIcon } from './ui-icons.js';
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
  onSaveHandlerChange,
  onError,
}: {
  chatId: string;
  refreshKey: string | number;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  onError: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roles, setRoles] = useState<Record<string, IllustrationReferenceRole | ''>>({});
  const [dirty, setDirty] = useState(false);
  const dirtyDraft = useRef(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const lock = useRef(false);
  const load = useCallback(async () => {
    setLoadError('');
    try {
      const value = await api<Loaded>(
        `/chats/${encodeURIComponent(chatId)}/illustration-references`
      );
      setLoaded(value);
      return value;
    } catch (error) {
      setLoadError((error as Error).message);
      return null;
    }
  }, [chatId]);
  const refresh = useCallback(async () => {
    const value = await load();
    // Role edits made while the read was pending still own the draft.
    if (value && !dirtyDraft.current)
      setRoles(Object.fromEntries(value.candidates.map((item) => [item.ref, item.role ?? ''])));
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reader asset changes reload candidates; a dirty draft keeps its roles.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, async () => (!loaded ? false : save()));
  if (!loaded)
    return (
      <section className="illustration-references" aria-label="삽화 참조 이미지">
        <h4>삽화 참조 이미지</h4>
        <LoadingState
          compact
          loading={!loadError}
          error={loadError}
          label="삽화 참조 이미지를 불러오는 중이에요…"
          errorLabel="삽화 참조 이미지를 불러오지 못했어요."
          onRetry={() => void refresh()}
        />
      </section>
    );
  const selected = loaded.candidates.filter((item) => roles[item.ref]);
  const save = async () => {
    if (lock.current) return false;
    if (!dirty) return true;
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
      dirtyDraft.current = false;
      setDirty(false);
      setMessage('삽화 참조 이미지를 저장했어요. 다음 삽화 요청부터 사용해요.');
      return true;
    } catch (error) {
      onError((error as Error).message);
      return false;
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
      {loadError && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() => void refresh()}
            >
              <RefreshIcon size={18} aria-hidden="true" /> 다시 불러오기
            </button>
          }
        >
          삽화 참조 이미지를 새로 불러오지 못했어요. 기존 선택은 유지했어요. {loadError}
        </NoticeBanner>
      )}
      {!loaded.candidates.length && (
        <p className="muted">이 채팅에 등록한 이미지나 장착한 자료의 이미지가 없어요.</p>
      )}
      <div className="asset-grid illustration-reference-options">
        {loaded.candidates.map((item) => (
          <figure key={item.ref}>
            <img src={item.url} alt={item.title} loading="lazy" />
            <figcaption>{item.title}</figcaption>
            <select
              aria-label={`${item.title} 참조 역할`}
              value={roles[item.ref] ?? ''}
              disabled={saving || (!roles[item.ref] && selected.length >= 8)}
              onChange={(event) => {
                dirtyDraft.current = true;
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
      <TransientNotice message={message} />
    </section>
  );
}
