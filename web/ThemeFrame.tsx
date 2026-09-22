import DOMPurify from 'dompurify';
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_THEME_TEMPLATE, THEME_SLOTS } from '../core/themes.js';
import { ThemeContext } from './ThemeContext.js';

/** Native slot projection leaves React's body/action nodes in place, even when layouts change. */
export function themeTemplate(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(html || DEFAULT_THEME_TEMPLATE, {
    // Names live inside this ShadowRoot, not in document named properties.
    SANITIZE_DOM: false,
    ADD_TAGS: ['slot', 'style'],
    ADD_ATTR: ['name'],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'form'],
  });
  if (DOMPurify.removed.length)
    throw new Error(
      '레이아웃에 지원하지 않는 HTML이 있어요. 스크립트·이벤트 속성·iframe·form 대신 슬롯과 CSS를 사용해 주세요.'
    );
  const slots = [...template.content.querySelectorAll('slot')];
  for (const name of THEME_SLOTS) {
    if (slots.filter((slot) => slot.name === name).length !== 1)
      throw new Error(`레이아웃에 <slot name="${name}"></slot>이 정확히 하나 필요해요.`);
  }
  if (
    slots.some(
      (slot) => slot.name && !THEME_SLOTS.includes(slot.name as (typeof THEME_SLOTS)[number])
    )
  )
    throw new Error('알 수 없는 레이아웃 슬롯이 있어요.');
  if (slots.filter((slot) => !slot.name).length > 1)
    throw new Error('기본 슬롯은 하나만 사용할 수 있어요.');
  if (!slots.some((slot) => !slot.name)) template.content.append(document.createElement('slot'));
  return template.content;
}
export function ThemeFrame({ children }: { children: ReactNode }) {
  const theme = useContext(ThemeContext)?.active;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const html = theme?.templateHtml ?? '';
  const css = theme?.templateCss ?? '';
  useLayoutEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      ':host{display:block;min-width:0}slot{display:contents}::slotted(*){min-width:0}\n' + css;
    try {
      root.replaceChildren(style, themeTemplate(html));
      setError('');
    } catch (cause) {
      // An invalid imported layout cannot hide the reader and its recovery controls.
      style.textContent = ':host{display:block;min-width:0}slot{display:contents}';
      root.replaceChildren(style, themeTemplate(''));
      setError((cause as Error).message);
    }
    // React removes the host. Do not collapse live content between layout replacements.
  }, [html, css]);
  return (
    <>
      {error && (
        <p className="error" role="alert">
          테마 레이아웃 대신 기본 화면을 표시해요. {error}
        </p>
      )}
      <div ref={host} className="theme-frame" data-uimori-part="scene-frame">
        {children}
      </div>
    </>
  );
}
