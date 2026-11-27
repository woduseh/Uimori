import { t, useI18n } from './i18n.js';
import { uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useRef, useState } from 'react';
import type { BotDefaults, BotPersonaDefault } from '../core/bot-defaults.js';
import type { Content, Library } from '../core/product.js';
import { chatEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { ContentPicker } from './ContentPicker.js';
import { Dialog } from './Dialog.js';
import { refValue } from './content-ref.js';
import { SaveButton } from './SaveButton.js';
import { useRetryableEffect } from './useRetryableEffect.js';

export function BotDefaultPersona({
  bot,
  library,
  onClose,
}: {
  bot: Content;
  library: Library;
  onClose: () => void;
}) {
  useI18n();
  const [saved, setSaved] = useState<BotDefaults | null>(null);
  const [mode, setMode] = useState<BotPersonaDefault['mode']>('inherit');
  const [personaId, setPersonaId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
  const lock = useRef(false);
  const botId = bot.id;
  const retryLoad = useRetryableEffect(() => {
    let alive = true;
    setError(null);
    void callEndpoint(chatEndpoints.readBotDefaults, { botId })
      .then((value) => {
        if (!alive) return;
        setSaved(value);
        setMode(value.persona.mode);
        setPersonaId(value.persona.mode === 'persona' ? value.persona.persona.id : '');
      })
      .catch((cause) => {
        if (alive) setError(toUiMessage(cause));
      });
    return () => {
      alive = false;
    };
  }, [botId]);
  const selected = library.contents.find((item) => item.id === personaId);
  async function save() {
    if (!saved || lock.current || (mode === 'persona' && !selected)) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await callEndpoint(chatEndpoints.updateBotDefaults, {
        botId,
        expectedRevision: saved.revision,
        persona:
          mode === 'persona' && selected
            ? { mode, persona: { id: selected.id } }
            : { mode: mode === 'none' ? 'none' : 'inherit' },
      });
      onClose();
    } catch (cause) {
      setError(toUiMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={t('library.botDefaultPersona')}
      className="bot-organize-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="bot-folder-create"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {!saved && (
          <LoadingState
            presentation="placeholder"
            loading={!error}
            error={error}
            errorLabel={uiMessage('library.couldNotLoadTheDefaultPersona')}
            label={uiMessage('library.loadingDefaults')}
            onRetry={retryLoad}
          />
        )}
        <label>
          {t('library.defaultPersona')}
          <select
            aria-label={t('library.botDefaultPersonaMode')}
            disabled={!saved || busy}
            value={mode}
            onChange={(event) => setMode(event.target.value as BotPersonaDefault['mode'])}
          >
            <option value="inherit">{t('library.defaultPersonaNotSet')}</option>
            <option value="none">{t('library.noPersona')}</option>
            <option value="persona">{t('library.choosePersona')}</option>
          </select>
        </label>
        {mode === 'persona' && (
          <>
            <ContentPicker
              library={library}
              role="persona"
              label={t('library.chooseBotSDefaultPersona')}
              value={selected ? refValue(selected) : ''}
              selectedContent={selected}
              disabled={!saved || busy}
              onChange={(value) => setPersonaId(value.slice(0, value.lastIndexOf('@')))}
            />
            {personaId && !selected && (
              <p role="status">{t('library.theSavedPersonaWasDeletedChooseAnother')}</p>
            )}
          </>
        )}
        {saved && error && <NoticeBanner tone="error">{error}</NoticeBanner>}
        <SaveButton
          disabled={!saved || busy || (mode === 'persona' && !selected)}
          label={t('library.saveDefaultPersona')}
          text={t('shared.save')}
          aria-busy={busy}
        />
      </form>
    </Dialog>
  );
}
