import { themeMessageSheet } from './theme-message-style.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { createReadingDecorator } from './reading-dom.js';
import { risuActionKey, type PreparedRisuMessage } from './risu-message.js';
import surfaceCss from './risu-message-surface.css?inline';

export type RisuAction = (kind: 'trigger' | 'button', name: string) => Promise<void>;
export type RisuActionState = { busy: boolean; issue: string };
const styles = new WeakMap<Document, CSSStyleSheet>();

type CardControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLDetailsElement;
function authoredControls(content: HTMLElement) {
  const controls = new Map<string, { node: CardControl; defaults: string }>();
  const duplicates = new Set<string>();
  for (const node of content.querySelectorAll<CardControl>('input,textarea,select,details')) {
    const id = node.id || node.getAttribute('risu-id');
    const name = node.getAttribute('name');
    if (!id && !name) continue;
    if (node instanceof HTMLInputElement && node.type === 'file') continue;
    const key = JSON.stringify([
      node.tagName,
      id ? ['id', id] : ['name', name],
      node instanceof HTMLInputElement ? node.type : '',
      node instanceof HTMLInputElement && node.type === 'radio' ? node.value : '',
    ]);
    const defaults = JSON.stringify(
      node instanceof HTMLInputElement
        ? [node.defaultValue, node.defaultChecked]
        : node instanceof HTMLTextAreaElement
          ? node.defaultValue
          : node instanceof HTMLSelectElement
            ? [
                node.multiple,
                [...node.options].map((option) => [option.value, option.defaultSelected]),
              ]
            : node.open
    );
    if (controls.has(key) || duplicates.has(key)) {
      controls.delete(key);
      duplicates.add(key);
    } else controls.set(key, { node, defaults });
  }
  return controls;
}

function rememberControls(previous: ReturnType<typeof authoredControls>, focused: Element | null) {
  const snapshots = [...previous].map(([key, saved]) => ({
    key,
    ...saved,
    scrollTop: saved.node.scrollTop,
    scrollLeft: saved.node.scrollLeft,
    selection:
      saved.node instanceof HTMLInputElement || saved.node instanceof HTMLTextAreaElement
        ? ([
            saved.node.selectionStart,
            saved.node.selectionEnd,
            saved.node.selectionDirection,
          ] as const)
        : null,
  }));
  return (next: ReturnType<typeof authoredControls>) => {
    for (const saved of snapshots) {
      const { key } = saved;
      const replacement = next.get(key);
      // Authored value changes take priority, even within the same display revision.
      if (!replacement || replacement.defaults !== saved.defaults) continue;
      const old = saved.node;
      const node = replacement.node;
      if (old instanceof HTMLInputElement && node instanceof HTMLInputElement) {
        node.value = old.value;
        node.checked = old.checked;
      } else if (old instanceof HTMLTextAreaElement && node instanceof HTMLTextAreaElement) {
        node.value = old.value;
      } else if (old instanceof HTMLSelectElement && node instanceof HTMLSelectElement) {
        [...old.options].forEach((option, index) => {
          node.options[index]!.selected = option.selected;
        });
      } else if (old instanceof HTMLDetailsElement && node instanceof HTMLDetailsElement) {
        node.open = old.open;
      }
      if (old === focused) {
        node.focus({ preventScroll: true });
        if (
          (old instanceof HTMLInputElement || old instanceof HTMLTextAreaElement) &&
          (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
          saved.selection?.[0] !== null &&
          saved.selection
        ) {
          node.setSelectionRange(
            saved.selection[0],
            saved.selection[1],
            saved.selection[2] ?? undefined
          );
        }
      }
      node.scrollTop = saved.scrollTop;
      node.scrollLeft = saved.scrollLeft;
    }
  };
}

/** A single message tree. Updates never re-parse HTML just to change reading or action state. */
export function mountRisuMessageSurface(
  host: HTMLElement,
  initial: PreparedRisuMessage,
  onState: (state: RisuActionState) => void
) {
  let prepared = initial;
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  let sheet = styles.get(host.ownerDocument);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(surfaceCss);
    styles.set(host.ownerDocument, sheet);
  }
  root.adoptedStyleSheets = [sheet, themeMessageSheet(host.ownerDocument)];
  const authorStyle = document.createElement('style');
  authorStyle.textContent = prepared.css;
  const content = document.createElement('div');
  content.className = 'risu-message-content';
  content.dataset.risuDisabled = 'true';
  content.innerHTML = prepared.html;
  root.replaceChildren(authorStyle, content);
  const slots = new Map<string, HTMLSlotElement>();
  const findBoundaries = () =>
    new Map(
      [...content.querySelectorAll<HTMLElement>('[data-uimori-illustration-after]')].map((node) => [
        node.dataset.uimoriIllustrationAfter!,
        node.tagName === 'CODE' ? node.closest('pre')! : node,
      ])
    );
  let boundaries = findBoundaries();
  let controls = authoredControls(content);
  let reading = createReadingDecorator(content);
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
    updateMessage(next: PreparedRisuMessage, preserveControls: boolean) {
      authorStyle.textContent = next.css;
      if (prepared.html !== next.html) {
        const restore = preserveControls
          ? rememberControls(controls, root.activeElement)
          : undefined;
        content.innerHTML = next.html;
        const nextControls = authoredControls(content);
        restore?.(nextControls);
        controls = nextControls;
        boundaries = findBoundaries();
        slots.clear();
        reading = createReadingDecorator(content);
      }
      prepared = next;
    },
    updateIllustrations(anchors: string[]) {
      const requested = new Set(anchors);
      for (const [anchor, slot] of slots) {
        if (!requested.has(anchor)) {
          slot.remove();
          slots.delete(anchor);
        }
      }
      for (const anchor of requested) {
        const boundary = boundaries.get(anchor);
        if (!boundary || slots.has(anchor)) continue;
        const slot = document.createElement('slot');
        slot.name = `illustration-${anchor}`;
        boundary.after(slot);
        slots.set(anchor, slot);
      }
    },
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
      root.removeEventListener('click', click, true);
      // The host owns the DOM lifetime; a content refresh replaces it atomically.
    },
  };
}
