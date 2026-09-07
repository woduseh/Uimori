import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { Prose, safeProseLink } from '../web/Prose.js';
import { SourceReader } from '../web/SourceReader.js';
import { splitSource } from '../core/auxiliary.js';
import type { Job, Source } from '../core/types.js';

const render = (text: string) => renderToStaticMarkup(createElement(Prose, { text }));

describe('safe prose rendering', () => {
  test('renders headings, emphasis, quotes, lists and line breaks with semantic elements', () => {
    const html = render(
      '# 실제 원고 제목\n\n**강조**와 *기울임*\n다음 줄\n\n> 인용한 문장\n> 이어지는 문장\n\n- 하나\n- 둘\n\n3. 셋\n4. 넷'
    );
    expect(html).toContain('<h1>실제 원고 제목</h1>');
    expect(html).toContain('<strong>강조</strong>');
    expect(html).toContain('<em>기울임</em>');
    expect(html).toContain('<br/>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ul><li>하나</li><li>둘</li></ul>');
    expect(html).toContain('<ol start="3"><li>셋</li><li>넷</li></ol>');
  });

  test('escapes raw HTML, blocks executable links and never requests Markdown images', () => {
    const html = render(
      '<script>window.pwned=true</script>\n<img src=x onerror=alert(1)>\n<svg onload=alert(1)></svg>\n\n[실행](javascript:alert) ![외부 이미지](https://example.com/track.png)\n[안전한 링크](https://example.com/story)'
    );
    expect(html).not.toMatch(/<(?:script|img|svg)\b/u);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('![외부 이미지](https://example.com/track.png)');
    expect(html).toContain(
      '<a href="https://example.com/story" rel="noreferrer noopener">안전한 링크</a>'
    );
  });

  test('allows only attribute-free ruby and keeps other HTML literal', () => {
    const html = render(
      '<ruby>物語<rt>이야기</rt></ruby>\n<ruby><rb>港</rb><rp>(</rp><rt>항구</rt><rp>)</rp></ruby>\n<ruby onclick="alert(1)">위험<rt>표기</rt></ruby>'
    );
    expect(html).toContain('<ruby>物語<rp>(</rp><rt>이야기</rt><rp>)</rp></ruby>');
    expect(html).toContain('<ruby>港<rp>(</rp><rt>항구</rt><rp>)</rp></ruby>');
    expect(html.match(/<ruby>/gu)).toHaveLength(2);
    expect(html).toContain('&lt;ruby onclick=&quot;alert(1)&quot;&gt;');
  });

  test('keeps fenced code, protected placeholders, template syntax and machine identifiers literal', () => {
    const html = render(
      '```json\n{"assetRef":"harbor_01","mode":"READY"}\n\n<script>literal</script>\n```\n\n`**literal**` {{**user**}} [[p_ab12_1]] asset:harbor_01 SOME_ENUM'
    );
    expect(html).toContain(
      '<pre><code>{&quot;assetRef&quot;:&quot;harbor_01&quot;,&quot;mode&quot;:&quot;READY&quot;}\n\n&lt;script&gt;literal&lt;/script&gt;</code></pre>'
    );
    expect(html).toContain('<code>**literal**</code>');
    expect(html).toContain('{{**user**}} [[p_ab12_1]] asset:harbor_01 SOME_ENUM');
    expect(html).not.toContain('<strong>');
  });

  test('rejects unsafe and ambiguous URL schemes without accepting control-character obfuscation', () => {
    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,hi',
      '//example.com',
      '/\\example.com',
      'https:\\example.com',
    ])
      expect(safeProseLink(value)).toBeUndefined();
    for (const value of [
      'https://example.com',
      'http://example.com/story',
      'mailto:writer@example.com',
      '/help',
      '#scene',
    ])
      expect(safeProseLink(value)).toBe(value);
  });

  test('renders a long source without interpreting unsupported syntax as HTML', () => {
    const html = render(
      Array.from(
        { length: 300 },
        (_, index) =>
          `문단 ${index}: **기억**과 바람을 따라 걷는다. <x-state mode="READY">asset:harbor_01</x-state>`
      ).join('\n\n')
    );
    expect(html.match(/<p>/gu)).toHaveLength(300);
    expect(html).not.toContain('<x-state');
  });
});

test('reader defaults to Korean, preserves source identity and many-to-one translation anchors without commands', () => {
  const text = '# 실제 제목\n\n첫 번째 문단.\n\n두 번째 문단.';
  const source: Source = {
    editRevision: 0,
    id: 'source-test',
    runId: 'run-test',
    chatId: 'chat-test',
    parentRevision: null,
    text,
    hash: createHash('sha256').update(text).digest('hex'),
  };
  source.blocks = splitSource(source);
  const original = structuredClone(source);
  const job: Job = {
    id: 'translation-test',
    chatId: source.chatId,
    sourceRevision: source.id,
    sourceHash: source.hash,
    kind: 'translation',
    status: 'completed',
    attempt: 1,
    error: null,
    result: {
      mock: true,
      sourceRevision: source.id,
      sourceHash: source.hash,
      segments: [
        {
          anchors: source.blocks.map((block) => block.anchor),
          text: '## 한국어 번역\n\n합쳐진 문단.',
        },
      ],
    },
  };
  let commands = 0;
  const html = renderToStaticMarkup(
    createElement(SourceReader, {
      source,
      index: 0,
      jobs: [job],
      assets: [],
      request: '요청 원문',
      refresh: async () => {
        commands++;
      },
      onError: () => {},
      onFork: async () => {
        commands++;
      },
    })
  );
  expect(html).toContain('data-testid="translation-text"');
  expect(html).toContain(
    `data-block-anchor="${source.blocks.map((block) => block.anchor).join(' ')}"`
  );
  expect(html).toContain('<h2>한국어 번역</h2>');
  expect(html).toContain('요청 원문');
  expect(html).not.toContain('data-testid="job-translation"');
  expect(source).toEqual(original);
  expect(commands).toBe(0);
});

test('reader shows only the latest matching translation and never a version selector', () => {
  const source: Source = {
    id: 'latest-source',
    runId: 'run',
    chatId: 'chat',
    parentRevision: null,
    text: 'Original text',
    hash: 'current',
    editRevision: 0,
  };
  const job = (id: string, revision: number, text: string, hash = source.hash): Job => ({
    id,
    revision,
    chatId: source.chatId,
    sourceRevision: source.id,
    sourceHash: hash,
    kind: 'translation',
    status: 'completed',
    attempt: 1,
    error: null,
    result: { mock: false, manual: true, sourceRevision: source.id, sourceHash: hash, text },
  });
  const html = renderToStaticMarkup(
    createElement(SourceReader, {
      source,
      index: 0,
      jobs: [
        job('old', 1, 'OLD_TRANSLATION'),
        job('new', 2, 'LATEST_TRANSLATION'),
        job('stale', 3, 'STALE_TRANSLATION', 'old-hash'),
      ],
      assets: [],
      refresh: async () => {},
      onError: () => {},
      onFork: async () => {},
    })
  );
  expect(html).toContain('LATEST_TRANSLATION');
  expect(html).toContain('직접 수정한 번역');
  expect(html).not.toContain('OLD_TRANSLATION');
  expect(html).not.toContain('STALE_TRANSLATION');
  expect(html).not.toContain('번역 버전');
  expect(html).not.toContain('<select');
  expect(html).not.toContain('다시 번역');
  expect(html).toContain('원문 수정');
  expect(html).toContain('번역 수정');
});

test('reader without a current translation renders the original even when translation is preferred', () => {
  const source: Source = {
    id: 'missing-source',
    runId: 'run',
    chatId: 'chat',
    parentRevision: null,
    text: 'UNTRANSLATED_ORIGINAL',
    hash: 'current',
    editRevision: 0,
  };
  const html = renderToStaticMarkup(
    createElement(SourceReader, {
      source,
      index: 0,
      jobs: [],
      assets: [],
      refresh: async () => {
        throw new Error('must not request on render');
      },
      onError: () => {},
      onFork: async () => {},
    })
  );
  expect(html).toContain('data-testid="source-text"');
  expect(html).toContain('UNTRANSLATED_ORIGINAL');
  expect(html).not.toContain('data-testid="translation-text"');
  expect(html).toContain('번역 보기');
});
