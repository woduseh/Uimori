import { useLayoutEffect, useRef, useState } from 'react';
import {
  inputTranslationLanguage,
  type InputTranslationLanguage,
} from '../core/input-translation.js';
import { readerEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import {
  readOptionalJson,
  readOptionalStorage,
  removeOptionalStorage,
  writeOptionalStorage,
} from './optional-storage.js';
import { storageKeys } from './storage-keys.js';
import { toUiMessage } from './api-errors.js';
import { uiMessage, type UiMessage } from './ui-message.js';

type DraftIdentity = { key: string; epoch: number; revision: number; text: string };
type Original = { id: string; text: string };
type Candidate = { text: string; source: string };
type Options = {
  draftKey: string;
  epoch: number;
  chatId: string;
  readDraft: () => DraftIdentity;
  writeDraft: (text: string) => void;
  available: () => boolean;
};
const languageKey = storageKeys.inputTranslationLanguage;
const originalKey = storageKeys.inputTranslationOriginal;
function readOriginal(key: string): Original | null {
  const value = readOptionalJson('session', originalKey(key), null) as Partial<Original> | null;
  if (value && typeof value.id === 'string' && typeof value.text === 'string')
    return value as Original;
  return null;
}
function saveOriginal(key: string, value: Original | null): boolean {
  if (value) return writeOptionalStorage('session', originalKey(key), JSON.stringify(value));
  removeOptionalStorage('session', originalKey(key));
  return true;
}
function initialLanguage(): InputTranslationLanguage {
  return inputTranslationLanguage(readOptionalStorage('local', languageKey))?.code ?? 'en';
}

export function useInputTranslation(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [language, setLanguage] = useState(initialLanguage);
  const languageRef = useRef(language);
  languageRef.current = language;
  const [original, setOriginal] = useState<Original | null>(() => readOriginal(options.draftKey));
  const originalRef = useRef({ key: options.draftKey, value: original });
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState<UiMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const codexWarning = useCodexContentWarning();

  function cancel() {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigation invalidates pending results even when returning to the same draft key.
  useLayoutEffect(() => {
    const value = readOriginal(options.draftKey);
    originalRef.current = { key: options.draftKey, value };
    setOriginal(value);
    setCandidate(null);
    setError(null);
    setBusy(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [options.draftKey, options.epoch]);

  function remember(text: string) {
    const key = current.current.draftKey;
    const previous =
      originalRef.current.key === key ? originalRef.current.value : readOriginal(key);
    const value = previous ?? { id: crypto.randomUUID(), text };
    originalRef.current = { key, value };
    if (!saveOriginal(key, value)) setError(uiMessage('chatsettings.m159'));
    setOriginal(value);
  }
  async function translate() {
    if (pending.current || !current.current.available()) return;
    const scope = current.current;
    const captured = scope.readDraft();
    const selectedLanguage = languageRef.current;
    if (!captured.text.trim() || captured.key !== scope.draftKey) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setCandidate(null);
    try {
      const proceed = await codexWarning.check(
        (signal) =>
          callEndpoint(
            readerEndpoints.preflightChatContent,
            { chatId: scope.chatId, role: 'translation', text: captured.text },
            signal
          ),
        'translation',
        controller.signal
      );
      const latestBeforeSend = current.current.readDraft();
      if (
        !proceed ||
        pending.current !== controller ||
        controller.signal.aborted ||
        !current.current.available() ||
        latestBeforeSend.key !== captured.key ||
        latestBeforeSend.epoch !== captured.epoch ||
        latestBeforeSend.revision !== captured.revision ||
        latestBeforeSend.text !== captured.text ||
        languageRef.current !== selectedLanguage
      )
        return;
      const result = await callEndpoint(
        readerEndpoints.translateInput,
        { chatId: scope.chatId, text: captured.text, targetLanguage: selectedLanguage },
        controller.signal
      );
      const latest = current.current.readDraft();
      if (
        pending.current !== controller ||
        controller.signal.aborted ||
        latest.key !== captured.key ||
        latest.epoch !== captured.epoch
      )
        return;
      if (latest.revision !== captured.revision || latest.text !== captured.text) {
        setCandidate({ text: result.text, source: captured.text });
      } else {
        remember(captured.text);
        current.current.writeDraft(result.text);
      }
    } catch (cause) {
      const latest = current.current.readDraft();
      if (
        pending.current === controller &&
        !controller.signal.aborted &&
        latest.key === captured.key &&
        latest.epoch === captured.epoch
      )
        setError(toUiMessage(cause, 'prompts.uiUnableToTranslateInput'));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  function changeLanguage(value: string) {
    const next = inputTranslationLanguage(value);
    if (!next) return;
    cancel();
    setCandidate(null);
    setError(null);
    setLanguage(next.code);
    writeOptionalStorage('local', languageKey, next.code);
  }
  function restore() {
    const value = originalRef.current.value;
    if (!value || !current.current.available()) return;
    cancel();
    current.current.writeDraft(value.text);
    saveOriginal(current.current.draftKey, null);
    originalRef.current = { key: current.current.draftKey, value: null };
    setOriginal(null);
    setCandidate(null);
    setError(null);
  }
  function applyCandidate() {
    if (!candidate || !current.current.available()) return;
    remember(current.current.readDraft().text);
    current.current.writeDraft(candidate.text);
    setCandidate(null);
  }
  function beginSend() {
    cancel();
    setCandidate(null);
    setError(null);
    return originalRef.current.value?.id;
  }
  function accepted(key: string, id: string | undefined) {
    if (!id) return;
    if (readOriginal(key)?.id === id) saveOriginal(key, null);
    if (originalRef.current.key === key && originalRef.current.value?.id === id) {
      originalRef.current = { key, value: null };
      setOriginal(null);
    }
  }
  return {
    language,
    original: original?.text ?? null,
    candidate,
    error,
    busy,
    translate,
    cancel,
    changeLanguage,
    restore,
    applyCandidate,
    dismissCandidate: () => setCandidate(null),
    beginSend,
    accepted,
    codexWarning,
  };
}
export type InputTranslationState = ReturnType<typeof useInputTranslation>;
