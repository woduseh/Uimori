import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import DOMPurify from 'dompurify';
import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_THEME_TEMPLATE, THEME_SLOTS } from '../core/themes.js';
import { ThemeContext } from './ThemeContext.js';
import { NoticeBanner } from './NoticeBanner.js';

/** Native slot projection leaves React's body/action nodes in place, even when layouts change. */
export function themeTemplate(html: string): DocumentFragment {
  const template = document.createElement('template');
  // Parse as an inert fragment so leading style/script elements are not moved to a
  // document head before sanitization can preserve them or report their removal.
  template.innerHTML = html || DEFAULT_THEME_TEMPLATE;
  const fragment = DOMPurify.sanitize(template.content, {
    RETURN_DOM_FRAGMENT: true,
    // Names live inside this ShadowRoot, not in document named properties.
    SANITIZE_DOM: false,
    ADD_TAGS: ['slot', 'style'],
    ADD_ATTR: ['name'],
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'base', 'meta', 'form'],
  });
  if (DOMPurify.removed.length) throw new Error(uiMessage('visuals.m021'));
  const slots = [...fragment.querySelectorAll('slot')];
  for (const name of THEME_SLOTS) {
    if (slots.filter((slot) => slot.name === name).length !== 1)
      throw new Error(uiMessage('visuals.m022', { slot: `<slot name="${name}"></slot>` }));
  }
  if (
    slots.some(
      (slot) =>
        slot.name &&
        slot.name !== 'portrait' &&
        slot.name !== 'request-persona' &&
        !THEME_SLOTS.includes(slot.name as (typeof THEME_SLOTS)[number])
    )
  )
    throw new Error(uiMessage('visuals.m023'));
  if (
    ['portrait', 'request-persona'].some(
      (name) => slots.filter((slot) => slot.name === name).length > 1
    )
  )
    throw new Error(uiMessage('visuals.m024'));
  if (slots.filter((slot) => !slot.name).length > 1) throw new Error(uiMessage('visuals.m025'));
  if (!slots.some((slot) => !slot.name)) fragment.append(document.createElement('slot'));
  return fragment;
}
export function ThemeFrame({
  children,
  portrait,
  requestPersona,
}: {
  children: ReactNode;
  portrait?: ReactNode;
  requestPersona?: ReactNode;
}) {
  useI18n();
  const bodyLabel = t('visuals.m026');
  const theme = useContext(ThemeContext)?.active;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [hasPortrait, setHasPortrait] = useState(false);
  const [hasRequestPersona, setHasRequestPersona] = useState(false);
  const html = theme?.templateHtml ?? '';
  const css = theme?.templateCss ?? '';
  useLayoutEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      ':host{display:block;min-width:0}slot{display:contents}::slotted(*){min-width:0}\n' + css;
    try {
      const template = themeTemplate(html);
      setHasPortrait(!!template.querySelector('slot[name="portrait"]'));
      setHasRequestPersona(!!template.querySelector('slot[name="request-persona"]'));
      root.replaceChildren(style, template);
      setError('');
    } catch (cause) {
      // An invalid imported layout cannot hide the reader and its recovery controls.
      style.textContent = ':host{display:block;min-width:0}slot{display:contents}';
      setHasPortrait(false);
      setHasRequestPersona(false);
      root.replaceChildren(style, themeTemplate(''));
      setError((cause as Error).message);
    }
    // Scroll the app-owned light-DOM body so native focus, event capture and anchors still work.
    const body = host.current.querySelector<HTMLElement>('[slot="body"]');
    if (body && root.querySelector('slot[name="body"][data-uimori-body-scroll]')) {
      const previous = ['tabindex', 'role', 'aria-label'].map(
        (name) => [name, body.getAttribute(name)] as const
      );
      body.setAttribute('data-uimori-body-scroll', '');
      body.setAttribute('tabindex', '0');
      body.setAttribute('role', 'region');
      body.setAttribute('aria-label', t('visuals.m026'));
      return () => {
        body.removeAttribute('data-uimori-body-scroll');
        for (const [name, value] of previous) {
          if (value === null) body.removeAttribute(name);
          else body.setAttribute(name, value);
        }
      };
    }
    // React removes the host. Do not collapse live content between layout replacements.
  }, [html, css]);
  useLayoutEffect(() => {
    host.current?.querySelector('[data-uimori-body-scroll]')?.setAttribute('aria-label', bodyLabel);
  }, [bodyLabel]);
  return (
    <>
      {error && (
        <NoticeBanner tone="error">
          {t('visuals.themeFallback', { error: translateMessage(error) })}
        </NoticeBanner>
      )}
      <div
        ref={host}
        className="theme-frame"
        data-uimori-part="scene-frame"
        data-has-portrait={hasPortrait && !!portrait ? 'true' : 'false'}
        data-has-request-persona={hasRequestPersona && !!requestPersona ? 'true' : 'false'}
      >
        {hasPortrait && portrait && (
          <div slot="portrait" data-uimori-part="scene-portraits">
            {portrait}
          </div>
        )}
        {hasRequestPersona && requestPersona && (
          <div slot="request-persona" data-uimori-part="request-persona">
            {requestPersona}
          </div>
        )}
        {children}
      </div>
    </>
  );
}
