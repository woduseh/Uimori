import DOMPurify from 'dompurify';

export type PreparedRisuMessage = { html: string; css: string; actions: Set<string> };
export const risuActionKey = (kind: string, name: string) => JSON.stringify([kind, name]);

/** Trusted personal-card HTML, with the existing no-author-JavaScript contract preserved. */
export function prepareRisuMessage(html: string, css = ''): PreparedRisuMessage {
  if (html.length > 4_000_000 || css.length > 2_000_000)
    throw new Error('RISU_NATIVE_MESSAGE_LIMIT');
  const template = document.createElement('template');
  template.innerHTML = `<div>${html}</div>`;
  const styles = new Map<string, string>();
  // Keep CSS text out of both the sanitizer and a second HTML parse (notably SVG data URLs).
  for (const node of template.content.querySelectorAll('style')) {
    const key = crypto.randomUUID();
    const placeholder = document.createElement('span');
    styles.set(key, node.textContent ?? '');
    placeholder.dataset.risuStyle = key;
    node.replaceWith(placeholder);
  }
  template.innerHTML = DOMPurify.sanitize(template.innerHTML, {
    ADD_ATTR: ['risu-trigger', 'risu-btn', 'risu-ctrl', 'risu-id', 'risu-mark', 'data-risu-style'],
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    // IDs live in this message's ShadowRoot, not in the application's named-property scope.
    SANITIZE_DOM: false,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'base', 'meta', 'link', 'form'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'action', 'autofocus', 'nonce'],
    RETURN_TRUSTED_TYPE: false,
  });
  for (const node of template.content.querySelectorAll('[data-risu-style]')) {
    const value = styles.get(node.getAttribute('data-risu-style') ?? '');
    if (value === undefined) {
      node.remove();
      continue;
    }
    const style = document.createElement('style');
    style.textContent = value.replaceAll('<', '\\3C ');
    node.replaceWith(style);
  }
  // A Markdown paragraph nested inside an authored HTML panel is still author-owned.
  // Only the known Markdown containers between a marker and the message root are admitted.
  for (const node of template.content.querySelectorAll('[data-uimori-prose]')) {
    let parent = node.parentElement;
    while (parent && ['BLOCKQUOTE', 'UL', 'OL', 'LI'].includes(parent.tagName))
      parent = parent.parentElement;
    if (!parent?.classList.contains('risu-chat-text')) node.removeAttribute('data-uimori-prose');
  }
  const actions = new Set<string>();
  for (const node of template.content.querySelectorAll('[risu-trigger],[risu-btn]')) {
    const kind = node.hasAttribute('risu-trigger') ? 'trigger' : 'button';
    const name = node.getAttribute(kind === 'trigger' ? 'risu-trigger' : 'risu-btn') ?? '';
    if (!name || name.length > 1000) {
      node.removeAttribute('risu-trigger');
      node.removeAttribute('risu-btn');
    } else actions.add(risuActionKey(kind, name));
  }
  return { html: template.innerHTML, css, actions };
}
