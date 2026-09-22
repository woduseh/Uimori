import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_LORE_CONTEXT,
  type LoreContextDefaults,
  type LoreContextPolicy,
} from '../core/lore-context.js';
import { api } from './api.js';
import { LoreContextPolicyEditor } from './LoreContextPolicyEditor.js';
import { SaveButton } from './SaveButton.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import './settings-actions.css';

const policyOf = ({ revision: _revision, ...policy }: LoreContextDefaults): LoreContextPolicy =>
  policy;

export function LoreContextDefaultsEditor({
  onDirtyChange,
  onSaveHandlerChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
}) {
  const [saved, setSaved] = useState<LoreContextDefaults | null>(null);
  const [draft, setDraft] = useState<LoreContextDefaults | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const value = await api<LoreContextDefaults>('/lore-context-defaults');
      setSaved(value);
      setDraft(structuredClone(value));
      setInvalid(false);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const dirty = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  useEffect(() => onDirtyChange(dirty || invalid || busy), [busy, dirty, invalid, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const save = async () => {
    if (!draft || invalid || busy) return false;
    if (!dirty) return true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const accepted = await api<LoreContextDefaults>(
        '/lore-context-defaults',
        { expectedRevision: draft.revision, ...policyOf(draft) },
        'PUT'
      );
      setSaved(accepted);
      setDraft(structuredClone(accepted));
      setMessage('로어 문맥 기본값을 저장했어요. 이후 만드는 새 채팅부터 사용해요.');
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsSaveHandler(onSaveHandlerChange, save);
  if (!draft)
    return (
      <section className="settings-section" aria-label="로어 문맥 기본값">
        <p role="status">{error || '로어 문맥 기본값을 불러오는 중이에요…'}</p>
        {error && (
          <button type="button" className="secondary" onClick={() => void load()}>
            다시 불러오기
          </button>
        )}
      </section>
    );
  return (
    <section className="settings-section" aria-label="로어 문맥 기본값">
      <p className="muted">
        새 채팅을 만들 때 이 값을 복사해요. 이미 만든 채팅의 정책과 과거 실행은 바뀌지 않아요.
      </p>
      <fieldset disabled={busy} className="control-grid">
        <LoreContextPolicyEditor
          value={policyOf(draft)}
          onChange={(policy) => {
            setDraft({ revision: draft.revision, ...policy });
            setMessage('');
          }}
          onPendingChange={setInvalid}
          defaults={DEFAULT_LORE_CONTEXT}
          resetLabel="초기값 적용"
          profileRevision={draft.revision}
        />
        <div className="form-actions settings-save-actions full">
          <SaveButton
            type="button"
            label="로어 문맥 기본값 저장"
            aria-busy={busy}
            disabled={!dirty || invalid}
            onClick={save}
          />
        </div>
      </fieldset>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
