import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { isApplePlatform } from './ChatComposer.js';
import { t, useI18n, translateMessage, message as uiMessage, messageRef } from './i18n.js';
import { NoticeBanner } from './NoticeBanner.js';
import {
  defaultShortcutBindings,
  isModifierCode,
  sameShortcutKey,
  shortcutActionIds,
  shortcutActions,
  shortcutKeyFromEvent,
  shortcutKeyLabel,
  type ShortcutAction,
} from './shortcut-bindings.js';
import {
  resetAllShortcutBindings,
  resetShortcutBinding,
  setShortcutBinding,
  setShortcutCapturing,
  useShortcutBindings,
  useShortcutsEnabled,
} from './shortcuts.js';
import './shortcut-settings.css';

const ACTION_LABELS: Record<ShortcutAction, string> = {
  'palette.open': 'shortcuts.action.paletteOpen',
  'navigation.toggle': 'shortcuts.action.navigationToggle',
  'rightPanel.toggle': 'shortcuts.action.rightPanelToggle',
  'settings.open': 'shortcuts.action.settingsOpen',
  'editor.save': 'shortcuts.action.editorSave',
  'editor.askHelper': 'shortcuts.action.editorAskHelper',
  'search.open': 'shortcuts.action.searchOpen',
  'helper.mode': 'shortcuts.action.helperMode',
  'run.stop': 'shortcuts.action.runStop',
  'theme.safeMode': 'shortcuts.action.themeSafeMode',
};

export function ShortcutSettings() {
  useI18n();
  const bindings = useShortcutBindings();
  const enabled = useShortcutsEnabled();
  const defaults = defaultShortcutBindings();
  const apple = isApplePlatform();
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [feedback, setFeedback] = useState<{ action: ShortcutAction; message: string } | null>(
    null
  );
  const captureButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;
    setShortcutCapturing(true);
    return () => setShortcutCapturing(false);
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    captureButton.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (
        event.code === 'Escape' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setRecording(null);
        setFeedback(null);
        return;
      }
      if (isModifierCode(event.code)) return;
      const key = shortcutKeyFromEvent(event);
      if (!key) return;
      const result = setShortcutBinding(recording, key);
      if (result.ok) {
        setRecording(null);
        setFeedback(null);
        return;
      }
      if (result.reason === 'browser-reserved') {
        setFeedback({
          action: recording,
          message: uiMessage('shortcuts.errorBrowserReserved', {
            key: shortcutKeyLabel(key, apple),
          }),
        });
      } else if (result.reason === 'modifier-required') {
        setFeedback({ action: recording, message: uiMessage('shortcuts.errorModifierRequired') });
      } else if (result.reason === 'conflict') {
        setFeedback({
          action: recording,
          message: uiMessage('shortcuts.errorConflict', {
            action: messageRef(uiMessage(ACTION_LABELS[result.conflictWith])),
          }),
        });
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, apple]);

  const anyCustom = shortcutActionIds.some(
    (action) =>
      shortcutActions[action].when.rebindable &&
      !sameShortcutKey(bindings[action], defaults[action])
  );

  return (
    <div className="shortcut-settings">
      {!enabled && <NoticeBanner>{t('shortcuts.disabledNotice')}</NoticeBanner>}
      <p className="shortcut-settings-note">{t('shortcuts.localNote')}</p>
      <div className="shortcut-settings-list" role="list">
        {shortcutActionIds.map((action) => {
          const rebindable = shortcutActions[action].when.rebindable;
          const customized = rebindable && !sameShortcutKey(bindings[action], defaults[action]);
          const active = recording === action;
          const actionLabel = t(ACTION_LABELS[action]);
          const keyLabel = shortcutKeyLabel(bindings[action], apple);
          const rowError = feedback?.action === action ? feedback.message : '';
          return (
            <div key={action} className="settings-row shortcut-settings-row" role="listitem">
              <div className="settings-row-copy">
                <strong>{actionLabel}</strong>
                {action === 'run.stop' && <small>{t('shortcuts.repeatHint')}</small>}
                {!rebindable && <small>{t('shortcuts.fixedHint')}</small>}
                {rowError && (
                  <small className="shortcut-settings-error" role="alert">
                    {translateMessage(rowError)}
                  </small>
                )}
              </div>
              <div className="settings-row-control shortcut-settings-controls">
                <kbd className="shortcut-key-pill" data-recording={active || undefined}>
                  {active ? t('shortcuts.listening') : keyLabel}
                </kbd>
                {rebindable &&
                  (active ? (
                    <button
                      ref={captureButton}
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setRecording(null);
                        setFeedback(null);
                      }}
                    >
                      {t('shortcuts.cancelCapture')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      aria-label={t('shortcuts.changeAction', { action: actionLabel })}
                      onClick={() => {
                        setFeedback(null);
                        setRecording(action);
                      }}
                    >
                      {t('shortcuts.change')}
                    </button>
                  ))}
                {customized && !active && (
                  <button
                    type="button"
                    className="secondary shortcut-reset-button"
                    aria-label={t('shortcuts.resetAction', { action: actionLabel })}
                    onClick={() => {
                      resetShortcutBinding(action);
                      setFeedback(null);
                    }}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t('shortcuts.resetOne')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shortcut-settings-footer">
        <button
          type="button"
          className="secondary"
          disabled={!anyCustom}
          onClick={() => {
            setRecording(null);
            setFeedback(null);
            resetAllShortcutBindings();
          }}
        >
          <RotateCcw size={16} aria-hidden="true" />
          {t('shortcuts.resetAll')}
        </button>
      </div>
    </div>
  );
}
