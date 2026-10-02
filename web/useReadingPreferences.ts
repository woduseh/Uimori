import {
  readingScrollport,
  readerLocation,
  THEME_BODY_SCROLL_SELECTOR,
} from './theme-body-scroll.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readingPositionElements } from './reader-dom.js';
import { readPresentationSetting, writePresentationSetting } from './presentation-settings.js';
import {
  normalizeReadability,
  READABILITY_STORAGE_KEY,
  type ReadabilitySettings,
} from './reading-preferences.js';

function readPreferences() {
  try {
    return normalizeReadability(
      JSON.parse(readPresentationSetting(READABILITY_STORAGE_KEY) ?? 'null')
    );
  } catch {
    return normalizeReadability(null);
  }
}

type ReadingPosition = { element: HTMLElement; scrollport: HTMLElement; top: number };
function readingPositions(): ReadingPosition[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-reader-scrollport], .helper-messages, ${THEME_BODY_SCROLL_SELECTOR}`
    ),
  ]
    .filter((scrollport) => scrollport.getClientRects().length > 0)
    .flatMap((scrollport) => {
      const viewport = scrollport.getBoundingClientRect();
      const element =
        readingPositionElements(scrollport).find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return (
            readingScrollport(candidate) === scrollport &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom
          );
        }) ??
        (scrollport.matches('[data-reader-scrollport]') &&
        scrollport.querySelector(THEME_BODY_SCROLL_SELECTOR)
          ? readerLocation(scrollport)?.source
          : undefined);
      return element ? [{ element, scrollport, top: element.getBoundingClientRect().top }] : [];
    });
}

/** Owns only browser presentation, including keeping the visible source/message in place. */
export function useReadingPreferences(font: string, fontSize: number, width: number) {
  const [settings, setSettings] = useState(readPreferences);
  const positions = useRef<ReadingPosition[]>([]);
  const changeLayout = useCallback((change: () => void) => {
    positions.current = readingPositions();
    change();
  }, []);
  const update = useCallback(
    (next: ReadabilitySettings) => changeLayout(() => setSettings(normalizeReadability(next))),
    [changeLayout]
  );
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.readingFont = font;
    root.style.setProperty(
      '--reading-font-family',
      font === 'serif'
        ? 'Georgia, "Batang", "Noto Serif CJK KR", serif'
        : getComputedStyle(root).fontFamily
    );
    root.style.setProperty('--reading', `${fontSize}px`);
    root.style.setProperty('--reading-width', `${width}px`);
    if (settings.lineHeight === null) root.style.removeProperty('--reading-line-height');
    else root.style.setProperty('--reading-line-height', String(settings.lineHeight));
    if (settings.paragraphSpacing === null) {
      root.style.removeProperty('--reading-paragraph-gap');
      delete root.dataset.readingParagraphSpacing;
    } else {
      root.style.setProperty('--reading-paragraph-gap', `${settings.paragraphSpacing}em`);
      root.dataset.readingParagraphSpacing = 'custom';
    }
    for (const { element, scrollport, top } of positions.current) {
      if (element.isConnected && scrollport.isConnected)
        scrollport.scrollTop += element.getBoundingClientRect().top - top;
    }
    positions.current = [];
  }, [font, fontSize, width, settings]);
  useEffect(() => {
    writePresentationSetting(READABILITY_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);
  useEffect(() => writePresentationSetting('uimori:font', font), [font]);
  useEffect(() => writePresentationSetting('uimori:font-size', String(fontSize)), [fontSize]);
  useEffect(() => writePresentationSetting('uimori:reading-width', String(width)), [width]);
  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if (event.key !== READABILITY_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.storageArea === localStorage) changeLayout(() => setSettings(readPreferences()));
      } catch {
        // Browser storage can be disabled while this page is open.
      }
    };
    window.addEventListener('storage', receive);
    return () => window.removeEventListener('storage', receive);
  }, [changeLayout]);
  return { settings, update, changeLayout };
}
