import { createElement, StrictMode, useState } from 'react';
import { useReadingPreferences } from '../../web/useReadingPreferences.js';
import { ReadingPreferencesContext } from '../../web/ReadingPreferencesContext.js';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RisuMessageSurface } from '../../web/RisuMessageSurface.js';
import { DEFAULT_READABILITY, type ReadabilitySettings } from '../../web/reading-preferences.js';
import { prepareRisuMessage } from '../../web/risu-message.js';
import { mountRisuMessageSurface, type RisuActionState } from '../../web/risu-message-surface.js';
import { selectedReaderText, readingPositionElements } from '../../web/reader-dom.js';

const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function check(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
const prose = (body: string) => `<div class="risu-chat-text">${body}</div>`;
const style = (node: Element, key: string) => getComputedStyle(node).getPropertyValue(key);
const settings = (values: Partial<ReadabilitySettings> = {}): ReadabilitySettings => ({
  ...DEFAULT_READABILITY,
  ...values,
});

/** Shared by the repository's Playwright test and the offline browser evidence runner. */
export async function runSurfaceRegressions(mount: HTMLElement): Promise<string[]> {
  const passed: string[] = [];
  const cleanup: (() => void)[] = [];
  const host = () => {
    const node = document.createElement('div');
    node.className = 'risu-message-surface';
    mount.append(node);
    return node;
  };
  const surface = (html: string, css = '') => {
    const states: RisuActionState[] = [];
    const node = host();
    const value = mountRisuMessageSurface(node, prepareRisuMessage(html, css), (state) =>
      states.push(state)
    );
    cleanup.push(() => {
      value.destroy();
      node.remove();
    });
    value.updateReading(settings());
    value.updateAction({ revision: '0', disabled: false, action: async () => {} });
    return { ...value, host: node, states };
  };
  const run = async (name: string, test: () => void | Promise<void>) => {
    try {
      await test();
      passed.push(name);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    } finally {
      window.getSelection()?.removeAllRanges();
      while (cleanup.length) cleanup.pop()!();
      mount.replaceChildren();
    }
  };
  const rootStyle = document.documentElement.style.cssText;
  const appStyle = document.createElement('style');
  appStyle.textContent =
    'label {display:flex; flex-direction:column; font-size:42px} button {background:red}';
  document.head.append(appStyle);
  document.documentElement.style.setProperty('--reading', '18px');
  document.documentElement.style.setProperty('--text', '#123456');
  document.documentElement.style.setProperty('--accent', '#3344bb');
  document.documentElement.style.setProperty('--reading-font-family', 'sans-serif');
  try {
    await run('CSS and duplicate IDs stay local to each message', () => {
      const html = prose(
        '<style>label{display:inline;font-size:13px} button{font:12px monospace} #panel{display:none} #name:checked~#panel{display:block}</style><input id="name" type="checkbox"><label for="name">Toggle</label><div id="panel">Panel</div><button>Author</button>'
      );
      const a = surface(html),
        b = surface(html);
      check(a.root.getElementById('name'), 'sanitizer removed an author ID');
      (b.root.querySelector('label') as HTMLElement).click();
      check(
        (b.root.getElementById('name') as HTMLInputElement).checked,
        'second label did not toggle its input'
      );
      check(
        !(a.root.getElementById('name') as HTMLInputElement).checked,
        'second label changed first input'
      );
      check(
        style(b.root.getElementById('panel')!, 'display') === 'block',
        'sibling selector was broken'
      );
      check(style(b.root.querySelector('label')!, 'font-size') === '13px', 'app label CSS leaked');
      check(
        style(b.root.querySelector('button')!, 'font-size') === '12px',
        'base CSS overrode author typography'
      );
      check(
        a.root.adoptedStyleSheets[0] === b.root.adoptedStyleSheets[0],
        'base stylesheet not shared'
      );
      check(document.querySelectorAll('iframe').length === 0, 'message created an iframe');
    });
    await run('Reading quotes cross emphasis nodes and preserve author widgets', () => {
      const s = surface(
        prose(
          '<p data-uimori-prose>그녀가 말했다. “정말 <strong>같이</strong> 갈 거야?” 나는 고개를 끄덕였다. ‘기다릴게.’</p><details open><summary>“상태창”</summary><p>“위젯”</p><input value="unsaved"></details>'
        )
      );
      const paragraph = s.root.querySelector('p')!;
      const before = paragraph.textContent;
      const strong = paragraph.querySelector('strong');
      const input = s.root.querySelector('input') as HTMLInputElement;
      input.value = 'Keep me';
      s.updateReading(settings({ emphasis: 'strong', dialogueBreaks: true, thoughtBreaks: true }));
      check(
        s.root.querySelectorAll('[data-quote-role="dialogue"]').length === 3,
        'split inline quote missing'
      );
      check(
        s.root.querySelectorAll('.reading-quote-break-before').length === 2,
        'quote start breaks wrong'
      );
      check(
        s.root.querySelectorAll('.reading-quote-break-after').length === 1,
        'quote end breaks wrong'
      );
      check(s.root.querySelectorAll('details .reading-quote').length === 0, 'widget was decorated');
      check(paragraph.querySelector('strong') === strong, 'author emphasis node replaced');
      check(
        paragraph.textContent === before && input.value === 'Keep me',
        'saved display text or input changed'
      );
      for (let i = 0; i < 6; i++) {
        s.updateReading(settings({ emphasis: 'subtle', dialogueBreaks: true }));
        s.updateReading(settings());
      }
      check(s.root.querySelectorAll('.reading-quote').length === 0, 'reset left reading wrappers');
      check(paragraph.textContent === before, 'decoration duplicated or lost text');
      check(s.root.querySelector('details')!.open, 'details state reset');
    });
    await run('Code links ruby URLs and author HTML are not quote inputs', () => {
      const s = surface(
        prose(
          '<p data-uimori-prose>“본문” <code>“code”</code> <a href="#x">“link”</a> <ruby>“ruby”<rt>“rt”</rt></ruby> https://example.invalid/\'x\' {{getvar::"y"}}</p><div class="panel"><p data-uimori-prose>“panel”</p></div>'
        )
      );
      s.updateReading(settings({ emphasis: 'strong' }));
      check(
        s.root.querySelectorAll('.reading-quote').length === 1,
        'protected content was treated as prose'
      );
      check(
        s.root.querySelector('.panel p')?.hasAttribute('data-uimori-prose') === false,
        'authored panel retained automatic marker'
      );
    });
    await run('Nested roles and adjacent dialogue break boundaries are retained', () => {
      const s = surface(
        prose('<p data-uimori-prose>그는 “나는 ‘생각’한다.” “다음 대사.”라고 말했다.</p>')
      );
      s.updateReading(settings({ emphasis: 'subtle', dialogueBreaks: true, thoughtBreaks: true }));
      check(
        s.root.querySelectorAll('[data-quote-role="thought"]').length === 1,
        'nested role missing'
      );
      check(
        s.root.querySelectorAll('[data-quote-role="thought"].reading-quote-break').length === 0,
        'nested quote broke line'
      );
      check(
        s.root.querySelectorAll('.reading-quote-break-before').length === 1,
        'adjacent quotes added double break'
      );
      check(
        s.root.querySelectorAll('.reading-quote-break-after').length === 2,
        'dialogue boundaries missing'
      );
    });
    await run('Typography and paragraph spacing change without replacing controls', () => {
      const s = surface(
        prose(
          '<style>p {font-size:12px;line-height:1.2}</style><p data-uimori-prose>첫 문단</p><p data-uimori-prose>마지막 문단</p><input value="Draft"><p class="widget" style="font-size:12px">Widget</p>'
        )
      );
      const p = s.root.querySelector('p')!;
      const widget = s.root.querySelector('.widget')!;
      const input = s.root.querySelector('input')!;
      const originalMargin = style(p, 'margin-bottom');
      document.documentElement.style.setProperty('--reading', '26px');
      s.updateReading(settings({ lineHeight: 2.2, paragraphSpacing: 1.5 }));
      check(style(p, 'font-size') === '26px', 'reading size did not win on app prose');
      check(Math.abs(parseFloat(style(p, 'line-height')) - 57.2) < 0.1, 'line height missing');
      check(style(p, 'margin-bottom') === '39px', 'paragraph spacing missing');
      check(style(widget, 'font-size') === '12px', 'author UI size was overwritten');
      check(s.root.querySelector('input') === input, 'spacing remounted input');
      s.updateReading(settings());
      document.documentElement.style.setProperty('--reading', '18px');
      check(style(p, 'margin-bottom') === originalMargin, 'spacing reset left override');
      document.documentElement.style.setProperty('--reading-font-family', 'serif');
      document.documentElement.style.setProperty('--text', '#abcdef');
      check(style(p, 'font-family') === 'serif', 'font did not propagate');
      check(style(p, 'color') === 'rgb(171, 205, 239)', 'theme did not propagate');
      document.documentElement.style.setProperty('--reading-font-family', 'sans-serif');
    });
    await run(
      'Actions lock through reading changes and unlock only at a new revision',
      async () => {
        const s = surface(
          '<button risu-trigger="one">One</button><button risu-btn="two">Two</button>'
        );
        const calls: string[] = [];
        const action = async (kind: string, name: string) => {
          calls.push(`${kind}:${name}`);
        };
        s.updateAction({ revision: '0', disabled: false, action });
        const buttons = s.root.querySelectorAll('button');
        buttons[0]!.click();
        buttons[1]!.click();
        await tick();
        check(calls.join(',') === 'trigger:one', 'double action accepted');
        s.updateReading(settings({ emphasis: 'strong' }));
        buttons[1]!.click();
        await tick();
        check(calls.length === 1, 'settings unlocked successful action');
        s.updateAction({ revision: '1', disabled: false, action });
        buttons[1]!.click();
        await tick();
        check(calls.join(',') === 'trigger:one,button:two', 'new revision did not unlock');
        s.updateAction({ revision: '2', disabled: true, action });
        buttons[0]!.click();
        await tick();
        check(calls.length === 2, 'disabled control still invoked action');
        s.updateAction({ revision: '2', disabled: false, action });
        buttons[0]!.setAttribute('risu-trigger', 'not-prepared');
        buttons[0]!.click();
        await tick();
        check(calls.length === 2, 'unprepared action was dispatched');
      }
    );
    await run('Failures retry and stale failures cannot clear a newer action lock', async () => {
      const s = surface('<button risu-btn="go">Go</button>');
      const button = s.root.querySelector('button')!;
      s.updateAction({
        revision: '0',
        disabled: false,
        action: () => {
          throw new Error('sync failure');
        },
      });
      button.click();
      await tick();
      check(
        s.content.dataset.risuDisabled === 'false' && s.states.at(-1)?.issue,
        'synchronous failure did not release'
      );
      let rejectOld!: (reason: Error) => void;
      s.updateAction({
        revision: '0',
        disabled: false,
        action: () =>
          new Promise<void>((_, reject) => {
            rejectOld = reject;
          }),
      });
      button.click();
      await tick();
      s.updateAction({ revision: '1', disabled: false, action: async () => {} });
      button.click();
      await tick();
      rejectOld(new Error('stale'));
      await tick();
      check(
        s.content.dataset.risuDisabled === 'true' && s.states.at(-1)?.busy,
        'stale rejection unlocked newer action'
      );
      check(!s.states.at(-1)?.issue, 'stale error leaked into current revision');
    });
    await run('Unmount before a queued action suppresses execution', async () => {
      const s = surface('<button risu-trigger="go">Go</button>');
      let calls = 0;
      s.updateAction({
        revision: '0',
        disabled: false,
        action: async () => {
          calls++;
        },
      });
      s.root.querySelector('button')!.click();
      s.destroy();
      await tick();
      check(calls === 0, 'removed message executed queued action');
    });
    await run('React reading and revision updates keep the DOM and unsaved UI', async () => {
      const reactHost = document.createElement('section');
      mount.append(reactHost);
      const root = createRoot(reactHost);
      cleanup.push(() => root.unmount());
      const html = prose(
        '<p data-uimori-prose>서술 “대사” 끝.</p><details open><summary>State</summary><input value="initial"></details><button risu-btn="go">Go</button>'
      );
      const render = (revision: string, reading: ReadabilitySettings) =>
        flushSync(() =>
          root.render(
            createElement(
              StrictMode,
              null,
              createElement(RisuMessageSurface, {
                html,
                reading,
                revisionKey: revision,
                onAction: async () => {},
              })
            )
          )
        );
      render('0', settings());
      const host = reactHost.querySelector('.risu-message-surface')!;
      const shadow = host.shadowRoot!;
      const input = shadow.querySelector('input')!;
      input.value = 'Do not lose';
      shadow.querySelector('details')!.open = false;
      const content = shadow.querySelector('.risu-message-content');
      render('0', settings({ emphasis: 'strong', paragraphSpacing: 2 }));
      render('1', settings({ emphasis: 'subtle', dialogueBreaks: true }));
      check(
        host.shadowRoot === shadow && shadow.querySelector('.risu-message-content') === content,
        'read/revision update reparsed HTML'
      );
      check(
        shadow.querySelector('input') === input && input.value === 'Do not lose',
        'React update lost input'
      );
      check(!shadow.querySelector('details')!.open, 'React update reset details');
      await tick();
    });
    await run('Selection and reading anchors cross only the owning shadow host', () => {
      const block = document.createElement('section');
      block.dataset.blockAnchor = 'source-1';
      mount.append(block);
      const s = surface(
        prose('<p data-uimori-prose>선택한 본문</p><p data-uimori-prose>다음 문단</p>')
      );
      block.append(s.host);
      const p = s.root.querySelector('p')!;
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      check(selectedReaderText(block) === '선택한 본문', 'shadow selection was rejected');
      const other = document.createElement('section');
      mount.append(other);
      check(selectedReaderText(other) === '', 'other source selection was accepted');
      const anchors = readingPositionElements(mount);
      check(
        anchors.length === 2 && anchors[0] === p,
        'shadow paragraphs unavailable to scroll restoration'
      );
    });
    await run('A fixed toolbar reserves height and its local label still works', async () => {
      const s = surface(
        prose(
          '<style>.toolbar{position:fixed;top:35px;right:12px;display:flex;flex-direction:column;gap:8px}.toolbar label{display:block;width:48px;height:48px}.closed{position:fixed;right:-560px;top:80px;width:520px;height:100vh}</style><p>Choose</p><div class="toolbar"><label for="settings">1</label><label for="settings">2</label><label for="settings">3</label><label for="settings">4</label><label for="settings">5</label></div><input hidden id="settings" type="checkbox"><aside class="closed"><button>Hidden</button></aside>'
        )
      );
      await tick();
      await tick();
      check(
        Math.abs(s.host.getBoundingClientRect().height - 307) < 1,
        `unexpected toolbar height ${s.host.getBoundingClientRect().height}`
      );
      const toolbar = s.root.querySelector('.toolbar')!.getBoundingClientRect();
      check(
        toolbar.bottom <= s.host.getBoundingClientRect().bottom + 1,
        'fixed toolbar was clipped'
      );
      (s.root.querySelector('label') as HTMLElement).click();
      check(
        (s.root.getElementById('settings') as HTMLInputElement).checked,
        'fixed toolbar label broken'
      );
      check(
        document.documentElement.scrollWidth <= innerWidth + 1,
        'closed offscreen panel widened the app'
      );
    });
    await run('The real reading preference hook restores a visible shadow paragraph', () => {
      const reactHost = document.createElement('section');
      mount.append(reactHost);
      const root = createRoot(reactHost);
      cleanup.push(() => root.unmount());
      let resize = (_size: number) => {};
      let restyle = (_value: ReadabilitySettings) => {};
      const html = prose(
        Array.from(
          { length: 35 },
          (_, index) =>
            `<p data-uimori-prose>${index}번째 문단. 서술문이 이어진다. “함께 걸어가자.” 그녀는 고개를 끄덕였다.</p>`
        ).join('')
      );
      function Harness() {
        const [size, setSize] = useState(18);
        const preferences = useReadingPreferences('sans', size, 760);
        resize = (next) => preferences.changeLayout(() => setSize(next));
        restyle = preferences.update;
        return createElement(
          ReadingPreferencesContext.Provider,
          { value: preferences.settings },
          createElement(
            'section',
            {
              'data-reader-scrollport': '',
              style: { height: 260, overflow: 'auto', overflowAnchor: 'none' },
            },
            createElement(
              'div',
              { 'data-block-anchor': 'story' },
              createElement(RisuMessageSurface, { html, onAction: async () => {} })
            )
          )
        );
      }
      flushSync(() => root.render(createElement(Harness)));
      const scrollport = reactHost.querySelector<HTMLElement>('[data-reader-scrollport]')!;
      scrollport.scrollTop = 700;
      const top = scrollport.getBoundingClientRect().top;
      const paragraph = readingPositionElements(scrollport).find(
        (element) => element.getBoundingClientRect().bottom > top
      )!;
      const offset = paragraph.getBoundingClientRect().top;
      flushSync(() => resize(26));
      check(
        Math.abs(paragraph.getBoundingClientRect().top - offset) < 1.1,
        'font resize lost reading position'
      );
      check(style(paragraph, 'font-size') === '26px', 'hook font value did not reach prose');
      flushSync(() =>
        restyle(settings({ emphasis: 'strong', dialogueBreaks: true, paragraphSpacing: 2 }))
      );
      check(
        Math.abs(paragraph.getBoundingClientRect().top - offset) < 1.1,
        'quote or spacing update lost reading position'
      );
      flushSync(() => resize(18));
      flushSync(() => restyle(settings()));
    });
    await run('Author CSS remains text and basic no-author-script behavior is retained', () => {
      const s = surface(
        '<style>.card{color:rgb(12,34,56);background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E")}</style><p class="card">Card</p><button onclick="window.surfaceInjected=true" risu-btn="ok">Go</button><script>window.surfaceInjected=true</script><iframe></iframe>',
        '</style><script>window.surfaceInjected=true</script><style>'
      );
      check(
        s.root.querySelectorAll('script,iframe,[onclick]').length === 0,
        'active author HTML survived'
      );
      check(
        style(s.root.querySelector('.card')!, 'color') === 'rgb(12, 34, 56)',
        'author style lost'
      );
      check(
        style(s.root.querySelector('.card')!, 'background-image').includes('data:image/svg+xml'),
        'SVG CSS lost'
      );
      check(!('surfaceInjected' in window), 'CSS entered HTML parser');
      const prepared = prepareRisuMessage(
        '<img src="https://example.invalid/image.png"><a href="https://example.invalid">Link</a>'
      );
      check(
        prepared.html.includes('https://example.invalid/image.png'),
        'trusted resource policy unexpectedly stripped source'
      );
    });
    return passed;
  } finally {
    document.documentElement.style.cssText = rootStyle;
    appStyle.remove();
    while (cleanup.length) cleanup.pop()!();
    mount.replaceChildren();
  }
}
