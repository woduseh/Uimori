import { t, translateMessage, useI18n, message as uiMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { TransientNotice } from './TransientNotice.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_LORE_CONTEXT,
  type LoreContextDefaults,
  type LoreContextPolicy,
} from '../core/lore-context.js';
import { promptEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
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
  useI18n();
  const [saved, setSaved] = useState<LoreContextDefaults | null>(null);
  const [draft, setDraft] = useState<LoreContextDefaults | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const value: LoreContextDefaults = await callEndpoint(
        promptEndpoints.readLoreContextDefaults
      );
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
      const accepted: LoreContextDefaults = await callEndpoint(
        promptEndpoints.updateLoreContextDefaults,
        { expectedRevision: draft.revision, ...policyOf(draft) }
      );
      setSaved(accepted);
      setDraft(structuredClone(accepted));
      setMessage(uiMessage('settings.m197'));
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
      <section className="settings-section settings-loading-region" aria-label={t('settings.m198')}>
        <LoadingState
          presentation="region"
          loading={!error}
          error={translateMessage(error)}
          label={t('settings.m199')}
          onRetry={() => void load()}
        />
      </section>
    );
  return (
    <section className="settings-section" aria-label={t('settings.m198')}>
      <fieldset disabled={busy} className="lore-context-fields">
        <LoreContextPolicyEditor
          value={policyOf(draft)}
          onChange={(policy) => {
            setDraft({ revision: draft.revision, ...policy });
            setMessage('');
          }}
          onPendingChange={setInvalid}
          defaults={DEFAULT_LORE_CONTEXT}
          resetLabel={t('settings.m201')}
          profileRevision={draft.revision}
          footerAction={
            <SaveButton
              type="button"
              label={t('settings.m202')}
              text={t('settings.m203')}
              aria-busy={busy}
              disabled={!dirty || invalid || busy}
              onClick={save}
            />
          }
        />
      </fieldset>
      <TransientNotice content={message} />
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </section>
  );
}
