import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Library } from '../core/product.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { LoadingState } from './LoadingState.js';
import { t, translateMessage, useI18n } from './i18n.js';
import { isModelSelectable } from './model-selection.js';
import { modelLabel } from './storyLabels.js';
import { CheckIcon, SearchIcon, SettingsIcon } from './ui-icons.js';
import './chat-model-picker.css';

/** The calling chat or role owner controls selection; the picker only presents choices. */
export function ChatModelPicker({
  open,
  scopeKey,
  library,
  selectedModelId,
  defaultModelId,
  disabled = false,
  pending = false,
  error = '',
  onSelect,
  onClose,
  onManage,
  purpose = 'chat',
  loading = false,
  onRetry,
  errorLabel,
}: {
  open: boolean;
  scopeKey: string;
  library: Library;
  selectedModelId?: string;
  defaultModelId?: string;
  disabled?: boolean;
  pending?: boolean;
  error?: string;
  onSelect: (modelId: string | undefined) => void;
  onClose: () => void;
  onManage: () => void;
  purpose?: 'chat' | 'helper';
  loading?: boolean;
  onRetry?: () => void;
  errorLabel?: string;
}) {
  useI18n();
  const [query, setQuery] = useState('');
  const choicesRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening the picker or switching chats starts a fresh search.
  useEffect(() => {
    setQuery('');
  }, [open, scopeKey]);
  const choices = library.models.filter((model) =>
    isModelSelectable(model, library.models, library.connections)
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = choices.filter((model) =>
    `${modelLabel(model, library)} ${model.modelId}`.toLocaleLowerCase().includes(needle)
  );
  const currentId = selectedModelId ?? defaultModelId;
  const current = library.models.find((model) => model.id === currentId);
  const unavailable =
    !!currentId && (!current || !isModelSelectable(current, library.models, library.connections));
  const inherited = library.models.find((model) => model.id === defaultModelId);
  const locked = disabled || pending || loading;
  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...(choicesRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-model-choice]:not(:disabled)'
      ) ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    event.stopPropagation();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % buttons.length
            : index <= 0
              ? buttons.length - 1
              : index - 1;
    buttons[next].focus();
  }
  return (
    <Dialog
      open={open}
      scopeKey={scopeKey}
      title={t(purpose === 'helper' ? 'helpers.modelPickerTitle' : 'main.modelPickerTitle')}
      onClose={onClose}
      className="chat-model-picker-dialog"
    >
      <p className="muted chat-model-picker-scope">
        {t(purpose === 'helper' ? 'helpers.modelPickerScope' : 'main.modelPickerScope')}
      </p>
      {onRetry ? (
        <LoadingState
          presentation="inline"
          loading={loading}
          error={translateMessage(error)}
          errorLabel={errorLabel}
          onRetry={onRetry}
        />
      ) : error ? (
        <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>
      ) : null}
      {unavailable && (
        <NoticeBanner>
          {t('main.modelPickerUnavailable', { model: current?.title ?? currentId ?? '' })}
        </NoticeBanner>
      )}
      <label className="chat-model-picker-search">
        <SearchIcon size={17} aria-hidden="true" />
        <input
          type="search"
          aria-label={t('main.modelPickerSearch')}
          placeholder={t('main.modelPickerSearch')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={moveFocus}
        />
      </label>
      <div className="chat-model-picker-choices" ref={choicesRef} onKeyDown={moveFocus}>
        <button
          type="button"
          className="secondary chat-model-picker-choice"
          data-model-choice
          aria-pressed={!selectedModelId}
          disabled={locked}
          onClick={() => onSelect(undefined)}
        >
          <span>
            <strong>
              {t(purpose === 'helper' ? 'helpers.modelPickerNone' : 'main.modelPickerDefault')}
            </strong>
            {purpose === 'chat' && (
              <small className="muted">
                {inherited ? modelLabel(inherited, library) : t('main.modelPickerNoDefault')}
              </small>
            )}
          </span>
          {!selectedModelId && <CheckIcon size={18} aria-hidden="true" />}
        </button>
        {visible.map((model) => {
          const connection = library.connections.find((item) => item.id === model.connectionId);
          const ambiguous = choices.some(
            (other) =>
              other.id !== model.id &&
              other.title === model.title &&
              library.connections.find((item) => item.id === other.connectionId)?.title ===
                connection?.title
          );
          return (
            <button
              key={model.id}
              type="button"
              className="secondary chat-model-picker-choice"
              data-model-choice
              aria-pressed={selectedModelId === model.id}
              disabled={locked}
              onClick={() => onSelect(model.id)}
            >
              <span>
                <strong>{model.title}</strong>
                <small className="muted">{connection?.title}</small>
                {ambiguous && <small className="muted">{model.modelId}</small>}
              </span>
              {selectedModelId === model.id && <CheckIcon size={18} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {visible.length === 0 && (
        <div className="chat-model-picker-empty">
          <p className="muted">
            {needle ? t('main.modelPickerNoResults') : t('main.modelPickerNoModels')}
          </p>
          {needle && (
            <button type="button" className="secondary" onClick={() => setQuery('')}>
              {t('main.modelPickerClearSearch')}
            </button>
          )}
        </div>
      )}
      {pending && <p role="status">{t('main.modelPickerSaving')}</p>}
      <div className="chat-model-picker-footer">
        <button type="button" className="secondary" disabled={pending} onClick={onManage}>
          <SettingsIcon size={16} aria-hidden="true" />
          {t(purpose === 'helper' ? 'helpers.modelPickerManage' : 'main.modelPickerManage')}
        </button>
      </div>
    </Dialog>
  );
}
