import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy } from 'lucide-react';
import { IconButton } from './IconButton.js';
import { Prose } from './Prose.js';
import { t, useI18n } from './i18n.js';

function CodeCopy({ text, index }: { text: string; index: number }) {
  useI18n();
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <>
      <IconButton
        icon={state === 'copied' ? Check : Copy}
        label={t(state === 'copied' ? 'helpers.m008' : 'helperConversation.copyCode', { index })}
        disabled={state === 'copying'}
        size={16}
        onClick={async () => {
          setState('copying');
          try {
            if (!navigator.clipboard) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(text);
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      />
      <span className="sr-only" role="status">
        {state === 'copied' ? t('helpers.m010') : ''}
      </span>
      {state === 'failed' && (
        <span className="error" role="alert">
          {t('helpers.m011')}
        </span>
      )}
    </>
  );
}

/** Helper-only controls decorate code hosts without changing Markdown or manuscript coordinates. */
export function HelperMessageProse({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<{ host: HTMLElement; text: string; language: string }[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new answer replaces Prose's compiled DOM.
  useLayoutEffect(() => {
    const blocks = [...(root.current?.querySelectorAll<HTMLElement>('pre > code') ?? [])];
    const next = blocks.map((code) => {
      const host = document.createElement('div');
      host.className = 'helper-code-toolbar';
      code.parentElement!.before(host);
      return {
        host,
        text: code.textContent ?? '',
        language: [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) ?? '',
      };
    });
    setSlots(next);
    return () => {
      for (const slot of next) slot.host.remove();
    };
  }, [text]);
  return (
    <div ref={root} className="helper-prose">
      <Prose text={text} />
      {slots.map((slot, index) =>
        createPortal(
          <>
            <span className="helper-code-language">{slot.language}</span>
            <CodeCopy text={slot.text} index={index + 1} />
          </>,
          slot.host,
          String(index)
        )
      )}
    </div>
  );
}
