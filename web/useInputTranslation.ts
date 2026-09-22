import { useLayoutEffect, useRef, useState } from 'react';
import {
  inputTranslationLanguage,
  type InputTranslationLanguage,
  type InputTranslationResult,
} from '../core/input-translation.js';
import { api } from './api.js';

type DraftIdentity = { key: string; epoch: number; revision: number; text: string };
type Original = { id: string; text: string };
type Candidate = { text: string; source: string };
type Options = {
  draftKey: string;
  epoch: number;
  chatId: string;
  branchId?: string;
  readDraft: () => DraftIdentity;
  writeDraft: (text: string) => void;
  available: () => boolean;
};
const languageKey = 'uimori:input-translation-language';
const originalKey = (key: string) => `input-translation:${key}`;
function readOriginal(key: string): Original | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(originalKey(key)) ?? 'null');
    if (value && typeof value.id === 'string' && typeof value.text === 'string') return value;
  } catch {
    // Recovery is optional; a failed storage read does not replace the input.
  }
  return null;
}
function saveOriginal(key: string, value: Original | null) {
  try {
    if (value) sessionStorage.setItem(originalKey(key), JSON.stringify(value));
    else sessionStorage.removeItem(originalKey(key));
  } catch {
    // The active editor still holds the undo text when session storage is unavailable.
  }
}
function initialLanguage(): InputTranslationLanguage {
  try {
    return inputTranslationLanguage(localStorage.getItem(languageKey))?.code ?? 'en';
  } catch {
    return 'en';
  }
}

export function useInputTranslation(options: Options) {
  const current = useRef(options);
  current.current = options;
  const [language, setLanguage] = useState(initialLanguage);
  const [original, setOriginal] = useState<Original | null>(() => readOriginal(options.draftKey));
  const originalRef = useRef({ key: options.draftKey, value: original });
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);

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
    setError('');
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
    saveOriginal(key, value);
    setOriginal(value);
  }
  async function translate() {
    if (pending.current || !current.current.available()) return;
    const scope = current.current;
    const captured = scope.readDraft();
    if (!captured.text.trim() || captured.key !== scope.draftKey) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setCandidate(null);
    try {
      const result = await api<InputTranslationResult>(
        `/chats/${encodeURIComponent(scope.chatId)}/input-translation`,
        { text: captured.text, targetLanguage: language, branchId: scope.branchId },
        'POST',
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
        setError(cause instanceof Error ? cause.message : '입력을 번역하지 못했어요.');
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
    setError('');
    setLanguage(next.code);
    try {
      localStorage.setItem(languageKey, next.code);
    } catch {
      // Language selection remains usable without persistent preferences.
    }
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
    setError('');
  }
  function applyCandidate() {
    if (!candidate || !current.current.available()) return;
    // Undo recovers the input this explicit replacement displaces, not an older stale draft.
    remember(current.current.readDraft().text);
    current.current.writeDraft(candidate.text);
    setCandidate(null);
  }
  /** Invalidate a late result at send intent, but keep undo through failed/uncertain admission. */
  function beginSend() {
    cancel();
    setCandidate(null);
    setError('');
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
  };
}
export type InputTranslationState = ReturnType<typeof useInputTranslation>;
