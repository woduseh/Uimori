import { createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Prose } from '../../web/Prose.js';
import { SourceReader } from '../../web/SourceReader.js';
import { ReadingPreferencesContext } from '../../web/ReadingPreferencesContext.js';
import { DEFAULT_READABILITY, type ReadabilitySettings } from '../../web/reading-preferences.js';
import { createReadingMarkdown } from '../../core/reading-markdown.js';
import type { Source } from '../../core/types.js';
import { prepareRisuMessage } from '../../web/risu-message.js';
import { mountRisuMessageSurface } from '../../web/risu-message-surface.js';
import { captureReaderLocation } from '../../web/useReadingSync.js';
import '../../web/reading-prose.css';

const tick = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
const enabled: ReadabilitySettings = {
  ...DEFAULT_READABILITY,
  emphasis: 'strong',
  dialogueBreaks: true,
};

/** Exercises the actual DOM owner, not a second server-rendered implementation. */
export async function runReadingRegressions(mount: HTMLElement) {
  const root = createRoot(mount);
  const passed: string[] = [];
  const render = (text: string, reading = enabled) =>
    flushSync(() => root.render(createElement(Prose, { text, reading })));
  const plainText = () => mount.querySelector('.reading-markdown-content')!.textContent;
  try {
    const cases = [
      '서술. “정말 **괜찮아**?” *그녀는 「네」라고 답했다.*',
      '“첫째 줄”\n“둘째 줄”\n마지막 줄.',
      '서술\n“대사”\n다음 서술',
      '「그가 『기다려』라고 말했다. ‘생각이다.’」',
      '“<ruby>港<rt>‘항구’</rt></ruby>에 <u>함께</u> 가자.”',
    ];
    for (const text of cases) {
      render(text, DEFAULT_READABILITY);
      const before = plainText();
      const paragraph = mount.querySelector('p');
      const ruby = mount.querySelector('ruby');
      render(text);
      check(plainText() === before, 'reading settings changed visible text');
      check(mount.querySelector('p') === paragraph, 'reading settings replaced the paragraph');
      check(mount.querySelector('.reading-quote'), 'complete quotation was not decorated');
      if (ruby) {
        check(mount.querySelector('ruby') === ruby, 'ruby identity was replaced');
        check(
          ruby.parentElement?.matches('.reading-quote[data-quote-role="dialogue"]'),
          'outer quote did not style the whole ruby'
        );
        check(!ruby.querySelector('.reading-quote'), 'ruby pronunciation entered quote analysis');
      }
      render(text, DEFAULT_READABILITY);
      check(!mount.querySelector('.reading-quote'), 'disabling decoration left owned spans');
      check(plainText() === before, 'clearing decoration changed visible text');
    }
    passed.push('prose settings preserve text, Markdown nodes, ruby and reversibility');
    render('“끝나지 않은 「인용」\n\n“첫 문단\n\n둘째 문단”');
    check(!mount.querySelector('.reading-quote'), 'unfinished or cross-paragraph quote was paired');
    const protectedText =
      '```json\n{"말":"값"}\n```\n\n`“inline code”` {{"값":"원본"}} [[p_ab12_1]]\n\n<ruby>“漢字”<rt>‘읽기’</rt></ruby>\n\n<x-note title="대사처럼 보여도 속성">태그</x-note>\n\n[“링크 제목”](https://example.com) ![“이미지 제목”](https://example.com/image.png)';
    render(protectedText);
    check(!mount.querySelector('.reading-quote'), 'protected syntax entered quotation analysis');
    check(!mount.querySelector('img, x-note, script'), 'unapproved HTML or image was emitted');
    passed.push('unclosed quotes, code, links, attributes and external images remain protected');
    for (const prefix of ['', '{{"가린 대사":"그대로"}} ']) {
      const text = `${prefix}${'{{'.repeat(120_000)} 뒤 “늦은 대사”`;
      render(text, DEFAULT_READABILITY);
      const before = plainText();
      render(text);
      check(plainText() === before, 'unfinished template decoration changed source text');
      check(
        mount.querySelectorAll('.reading-quote').length === 1 &&
          mount.querySelector('.reading-quote')?.textContent === '“늦은 대사”',
        'unfinished templates swallowed a later quotation or exposed a protected token'
      );
    }
    render('“대사” 『생각』 ‘속마음’', {
      ...enabled,
      emphasis: 'off',
      dialogueBreaks: false,
      thoughtBreaks: true,
      quoteRoles: { ...enabled.quoteRoles, doubleCorner: 'thought', curlyDouble: 'off' },
    });
    check(
      mount.querySelectorAll('[data-emphasis="off"]').length === 2,
      'role overrides lost independent thought breaks'
    );
    check(!mount.querySelector('[data-quote-role="off"]'), 'disabled role was decorated');
    const repeated = '서술. “**대사**” 「*짧은 대사*」 '.repeat(2000);
    render(repeated, DEFAULT_READABILITY);
    const before = plainText();
    render(repeated);
    check(
      mount.querySelectorAll('.reading-quote-break-before').length === 2000 &&
        mount.querySelectorAll('.reading-quote-break-after').length === 3999,
      'long adjacent quotations lost boundaries or acquired duplicate breaks'
    );
    check(
      [...mount.querySelectorAll('.reading-quote[data-quote-role="dialogue"]')]
        .map((quote) => quote.textContent)
        .join('') === '“대사”「짧은 대사」'.repeat(2000),
      'long quotation decoration lost or changed any of the 4000 quotations'
    );
    check(
      mount.querySelectorAll('strong .reading-quote').length === 2000 &&
        [...mount.querySelectorAll('strong')].every((node) => node.textContent === '대사') &&
        mount.querySelectorAll('em .reading-quote').length === 2000 &&
        [...mount.querySelectorAll('em')].every((node) => node.textContent === '짧은 대사'),
      'long quotations lost their bold or italic text'
    );
    check(plainText() === before, 'long quote decoration lost content');
    passed.push('role overrides and long emphasis quotations retain their meaning');
    const anchoredText = '앞 “대사” 뒤';
    const blocks = [{ anchor: 'saved-anchor', start: 0, end: anchoredText.length }];
    const showAnchored = (text: string, reading = enabled) =>
      flushSync(() =>
        root.render(
          createElement(Prose, {
            text,
            reading,
            blocks,
            afterBlock: () => createElement('figure', { 'data-test-portal': '' }, 'IMAGE'),
          })
        )
      );
    showAnchored(anchoredText);
    for (let turn = 0; turn < 3; turn++) {
      await tick();
      await tick();
      check(
        mount.querySelector('.reading-quote'),
        'slot/parent rerender removed initial reading decoration'
      );
      check(
        mount.querySelector('[data-test-portal]'),
        'slot/parent rerender detached the illustration portal'
      );
      showAnchored(anchoredText);
    }
    showAnchored(anchoredText, { ...enabled, emphasis: 'subtle' });
    await tick();
    check(
      mount.querySelector('[data-emphasis="subtle"]') && mount.querySelector('[data-test-portal]'),
      'settings update removed decoration or portal'
    );
    showAnchored('앞 “교체” 뒤');
    await tick();
    await tick();
    check(
      mount.querySelector('.reading-quote')?.textContent === '“교체”' &&
        mount.querySelector('[data-test-portal]'),
      'content replacement lost the new decoration or portal'
    );
  } finally {
    flushSync(() => root.unmount());
  }

  const md = createReadingMarkdown('native');
  const raw =
    '서술 “<ruby>港<rt>‘항구’</rt></ruby>에 <u>가자</u><br>함께.” 뒤.\n\n`<ruby>港<rt>항구</rt></ruby>`\n\nBefore <button>“action”</button><input value="draft"> after.\n\n' +
    `앞 “바깥” {{“가림”}} ${'{{'.repeat(120_000)} 뒤 “늦은 native” https://example.com/'path' [[p_ab12_1]]`;
  const html = `<div class="risu-chat-text">${md.render(raw)}</div>`;
  const surface = mountRisuMessageSurface(mount, prepareRisuMessage(html), () => {});
  try {
    const input = surface.root.querySelector('input')!;
    input.value = 'preserved draft';
    input.focus();
    const ruby = surface.root.querySelector('ruby')!;
    const templateParagraph = surface.root.querySelector('.risu-chat-text > p:last-child')!;
    const templateText = templateParagraph.textContent;
    surface.updateReading(enabled);
    check(
      templateParagraph.textContent === templateText &&
        [...templateParagraph.querySelectorAll('.reading-quote')]
          .map((quote) => quote.textContent)
          .join('|') === '“바깥”|“늦은 native”',
      'native completed templates, unfinished tails, anchors or URLs changed quote roles or text'
    );
    check(
      ruby.parentElement?.matches('.reading-quote[data-quote-role="dialogue"]'),
      'native raw ruby paragraph missed reading provenance'
    );
    check(
      surface.root.querySelector('u .reading-quote'),
      'safe underline blocked paragraph decoration'
    );
    check(
      !surface.root.querySelector('button .reading-quote, code .reading-quote'),
      'native authored control/code was decorated'
    );
    check(
      input.value === 'preserved draft' && surface.root.activeElement === input,
      'native control state/focus changed'
    );
    surface.updateReading(DEFAULT_READABILITY);
    check(!surface.root.querySelector('.reading-quote'), 'native decoration did not clear');
    check(surface.root.querySelector('ruby') === ruby, 'native ruby was recreated');
    passed.push(
      'raw native Markdown passes compiler, sanitizer and surface without changing controls'
    );
  } finally {
    surface.destroy();
  }
  await tick();
  return passed;
}

export async function mountSource(
  mount: HTMLElement,
  source: Source,
  options: Partial<
    Pick<ComponentProps<typeof SourceReader>, 'jobs' | 'assets' | 'imageOwner' | 'hasPackages'>
  > = {}
) {
  const root = createRoot(mount);
  const reader = document.createElement('div');
  reader.id = 'reader';
  reader.dataset.readerScrollport = '';
  Object.assign(reader.style, {
    height: '280px',
    overflow: 'auto',
    width: '360px',
    lineHeight: '1.8',
    fontSize: '18px',
  });
  const container = document.createElement('div');
  reader.append(container);
  mount.append(reader);
  const sourceRoot = createRoot(container);
  const show = (settings: ReadabilitySettings) =>
    flushSync(() =>
      sourceRoot.render(
        createElement(
          ReadingPreferencesContext.Provider,
          { value: settings },
          createElement(SourceReader, {
            source,
            index: 0,
            jobs: [],
            assets: [],
            refresh: async () => {},
            onError: () => {},
            onFork: async () => {},
            ...options,
          })
        )
      )
    );
  show(DEFAULT_READABILITY);
  await tick();
  await tick();
  return {
    setReading: () => show(enabled),
    capture: () => captureReaderLocation(reader, source.chatId),
    destroy: () => {
      sourceRoot.unmount();
      root.unmount();
    },
  };
}
