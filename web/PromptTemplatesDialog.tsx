import { useI18n, translateMessage } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { useEffect, useRef, useState } from 'react';
import type { PromptPreset, PromptRole } from '../core/product.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { AddIcon } from './ui-icons.js';
import './prompt-templates.css';

type PromptTemplateSummary = {
  id: string;
  title: string;
  role: PromptRole;
  description: string;
};
export type PromptTemplate = PromptTemplateSummary & Pick<PromptPreset, 'program' | 'values'>;

export function PromptTemplatesDialog({
  open,
  busy,
  onClose,
  onAdd,
  onAdded,
  onError,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onAdd: (id: string) => Promise<PromptPreset | null>;
  onAdded: (preset: PromptPreset) => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<PromptTemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [adding, setAdding] = useState<PromptTemplateSummary | null>(null);
  const [failure, setFailure] = useState<{
    template: PromptTemplateSummary;
    message: string;
  } | null>(null);
  const lock = useRef(false);
  const current = useRef({ open, onAdded, onError });
  current.current = { open, onAdded, onError };
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry refreshes the same catalog while the dialog stays open.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setTemplates(null);
    setLoadError('');
    setFailure(null);
    void api<PromptTemplateSummary[]>('/prompt-templates')
      .then((items) => {
        if (active) setTemplates(items);
      })
      .catch((error: Error) => {
        if (active) setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [open, loadAttempt]);
  async function add(template: PromptTemplateSummary) {
    if (lock.current || busy) return;
    lock.current = true;
    setAdding(template);
    setFailure(null);
    try {
      const preset = await onAdd(template.id);
      // Closing this picker does not cancel a save already requested, or replace another editor.
      if (preset && current.current.open) current.current.onAdded(preset);
    } catch (error) {
      const message = (error as Error).message;
      if (current.current.open) setFailure({ template, message });
      else current.current.onError(message);
    } finally {
      lock.current = false;
      setAdding(null);
    }
  }
  const pending = busy || adding !== null;
  return (
    <Dialog
      open={open}
      title={t('prompts.uiBuiltInPrompts')}
      className="prompt-templates-dialog"
      onClose={onClose}
    >
      {loadError || templates === null ? (
        <LoadingState
          presentation="placeholder"
          loading={!loadError}
          error={translateMessage(loadError)}
          errorLabel={t('prompts.uiUnableToLoadBuiltInPrompts')}
          label={t('prompts.uiLoadingBuiltInPrompts')}
          onRetry={() => setLoadAttempt((n) => n + 1)}
        />
      ) : (
        <ul className="prompt-template-list" aria-label={t('prompts.uiBuiltInPromptList')}>
          {templates.map((template) => (
            <li key={template.id} className="prompt-template-row">
              <div className="prompt-template-copy">
                <h3>{template.title}</h3>
                <span className="muted">
                  {template.role === 'translation'
                    ? t('prompts.uiTranslation')
                    : t('prompts.uiWriting')}
                </span>
                <p>{translateMessage(template.description)}</p>
              </div>
              <button
                type="button"
                className="secondary"
                aria-label={t('prompts.addNamed', { name: template.title })}
                disabled={pending}
                onClick={() => void add(template)}
              >
                <AddIcon size={18} aria-hidden="true" />
                {t('prompts.addToMyPrompts')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <LoadingState
          presentation="inline"
          label={t('prompts.addingNamed', { name: adding.title })}
        />
      )}
      {failure && (
        <div className="prompt-templates-error">
          <NoticeBanner
            tone="error"
            actions={
              <button
                type="button"
                className="secondary"
                disabled={pending}
                aria-label={t('prompts.retryNamed', { name: failure.template.title })}
                onClick={() => void add(failure.template)}
              >
                {t('prompts.uiRetry')}
              </button>
            }
          >
            {t('prompts.addFailed', { error: translateMessage(failure.message) })}
          </NoticeBanner>
        </div>
      )}
    </Dialog>
  );
}
