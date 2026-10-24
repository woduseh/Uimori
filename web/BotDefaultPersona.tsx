import { t, useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState } from 'react';
import type { BotDefaults, BotPersonaDefault } from '../core/bot-defaults.js';
import type { Content, Library } from '../core/product.js';
import { api } from './api.js';
import { ContentPicker } from './ContentPicker.js';
import { Dialog } from './Dialog.js';
import { refValue } from './content-ref.js';
import { SaveButton } from './SaveButton.js';

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
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const lock = useRef(false);
  const path = `/bots/${encodeURIComponent(bot.id)}/defaults`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry repeats the initial read while the dialog stays open.
  useEffect(() => {
    let alive = true;
    setError('');
    void api<BotDefaults>(path)
      .then((value) => {
        if (!alive) return;
        setSaved(value);
        setMode(value.persona.mode);
        setPersonaId(value.persona.mode === 'persona' ? value.persona.persona.id : '');
      })
      .catch((cause) => {
        if (alive) setError((cause as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [path, loadAttempt]);
  const selected = library.contents.find((item) => item.id === personaId);
  async function save() {
    if (!saved || lock.current || (mode === 'persona' && !selected)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api<BotDefaults>(
        path,
        {
          expectedRevision: saved.revision,
          persona:
            mode === 'persona' && selected
              ? { mode, persona: { id: selected.id, revision: selected.revision } }
              : { mode },
        },
        'PATCH'
      );
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
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
        <p>{t('library.botPersonaHint', { title: bot.title })}</p>
        {!saved && (
          <LoadingState
            presentation="placeholder"
            loading={!error}
            error={translateMessage(error)}
            errorLabel={t('library.couldNotLoadTheDefaultPersona')}
            label={t('library.loadingDefaults')}
            onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
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
        <p className="muted">{t('library.newChatsUseYourExplicitChoiceIncluding')}</p>
        {saved && error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
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
