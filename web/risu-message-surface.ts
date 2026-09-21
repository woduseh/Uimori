import type { ReadabilitySettings } from './reading-preferences.js';
import { createReadingDecorator } from './reading-dom.js';
import { risuActionKey, type PreparedRisuMessage } from './risu-message.js';
import { reserveFixedControls } from './risu-message-layout.js';
import surfaceCss from './risu-message-surface.css?inline';

export type RisuAction = (kind: 'trigger' | 'button', name: string) => Promise<void>;
export type RisuActionState = { busy: boolean; issue: string };
const styles = new WeakMap<Document, CSSStyleSheet>();

/** A single message tree. Updates never re-parse HTML just to change reading or action state. */
export function mountRisuMessageSurface(
  host: HTMLElement,
  prepared: PreparedRisuMessage,
  onState: (state: RisuActionState) => void
) {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  let sheet = styles.get(host.ownerDocument);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(surfaceCss);
    styles.set(host.ownerDocument, sheet);
  }
  root.adoptedStyleSheets = [sheet];
  const authorStyle = document.createElement('style');
  authorStyle.textContent = prepared.css;
  const content = document.createElement('div');
  content.className = 'risu-message-content';
  content.dataset.risuDisabled = 'true';
  content.innerHTML = prepared.html;
  root.replaceChildren(authorStyle, content);
  const reading = createReadingDecorator(content);
  const releaseLayout = reserveFixedControls(host, content);
  let action: RisuAction | undefined;
  let disabled = true;
  let locked = false;
  let revision = '';
  let generation = 0;
  let alive = true;
  const setDisabled = () => {
    content.dataset.risuDisabled = String(disabled || locked);
  };
  const click = (event: Event) => {
    const node = event.target instanceof Element ? event.target : null;
    const target = node?.closest('[risu-trigger],[risu-btn]');
    if (!target || !content.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    const kind = target.hasAttribute('risu-trigger') ? 'trigger' : 'button';
    const name = target.getAttribute(kind === 'trigger' ? 'risu-trigger' : 'risu-btn') ?? '';
    if (!action || disabled || locked || !prepared.actions.has(risuActionKey(kind, name))) return;
    const execute = action;
    const current = generation;
    locked = true;
    setDisabled();
    onState({ busy: true, issue: '' });
    void Promise.resolve()
      .then(() => {
        if (alive && current === generation) return execute(kind, name);
      })
      .catch(() => {
        if (!alive || current !== generation) return;
        locked = false;
        setDisabled();
        onState({ busy: false, issue: '봇의 선택을 반영하지 못했어요. 다시 시도해 주세요.' });
      });
    // Success remains locked until the server's new source/variable revision arrives.
  };
  root.addEventListener('click', click, true);
  return {
    root,
    content,
    updateAction(next: { action: RisuAction; disabled: boolean; revision: string }) {
      action = next.action;
      disabled = next.disabled;
      if (revision !== next.revision) {
        revision = next.revision;
        generation++;
        locked = false;
        onState({ busy: false, issue: '' });
      }
      setDisabled();
    },
    updateReading(settings: ReadabilitySettings) {
      if (settings.lineHeight === null) content.style.removeProperty('--reading-line-height');
      else content.style.setProperty('--reading-line-height', String(settings.lineHeight));
      if (settings.paragraphSpacing === null) {
        content.style.removeProperty('--reading-paragraph-gap');
        delete content.dataset.uimoriSpacing;
      } else {
        content.style.setProperty('--reading-paragraph-gap', `${settings.paragraphSpacing}em`);
        content.dataset.uimoriSpacing = 'custom';
      }
      reading.update(settings);
    },
    destroy() {
      alive = false;
      generation++;
      releaseLayout();
      root.removeEventListener('click', click, true);
      root.replaceChildren();
      root.adoptedStyleSheets = [];
    },
  };
}
