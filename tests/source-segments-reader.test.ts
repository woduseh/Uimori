import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Source } from '../core/types.js';
import { parseSourceSegments, type SegmentSource } from '../core/source-segments.js';
import { SourceSegmentsReader } from '../web/SourceSegmentsReader.js';
import { SourceSegmentBody } from '../web/SourceReader.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

const source = (text: string): SegmentSource => ({
  sourceRevision: 'synthetic-source',
  text,
  sourceHash: createHash('sha256').update(text).digest('hex'),
});

test('segment reader escapes HTML and never executes raw portrait markup or grants actor knowledge', () => {
  const raw = source(
    'Main.\n@hsTitle: <img src=x onerror=bad()>\n⟦Tower @ Dawn @ Unknown⟧\n[hsPortrait: <script>portraitBad()</script>]\n<script>window.BAD=1</script>\n@hs\nAfter.'
  );
  const before = structuredClone(raw),
    policy = createSourceSegmentFixture({ expanded: true });
  const parsed = parseSourceSegments(raw, policy);
  const html = renderToStaticMarkup(createElement(SourceSegmentsReader, { source: raw, policy }));
  expect(html).toContain('source-aside-segment');
  expect(html).toContain('open=""');
  expect(html).toContain('&lt;img');
  expect(html).toContain('&lt;script&gt;window.BAD=1');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('portraitBad()');
  expect(html).toContain('연결된 이미지를 표시할 수 없어요.');
  expect(html).toContain('등장인물에게 정보가 전달되지는');
  expect(raw).toEqual(before);
  expect(parseSourceSegments(raw, createSourceSegmentFixture({ expanded: false }))).toEqual(parsed);
});

test.each(['revision', 'hash'])(
  'reader refuses a translation attached to a stale source %s',
  (field) => {
    const raw = source('Main.\n@hsTitle: Original title\nOriginal aside.\n@hs\nAfter.'),
      policy = createSourceSegmentFixture();
    const aside = parseSourceSegments(raw, policy).segments[1];
    const translation = {
      sourceRevision: raw.sourceRevision,
      sourceHash: raw.sourceHash,
      segments: { [aside.id]: { title: 'STALE_TITLE', body: 'STALE_BODY' } },
    };
    if (field === 'revision') translation.sourceRevision = 'other-source';
    else translation.sourceHash = 'b'.repeat(64);
    const html = renderToStaticMarkup(
      createElement(SourceSegmentsReader, { source: raw, policy, translation })
    );
    expect(html).toContain('다른 원문 버전');
    expect(html).toContain('Original title');
    expect(html).toContain('Original aside.');
    expect(html).not.toContain('STALE_TITLE');
    expect(html).not.toContain('STALE_BODY');
  }
);

test('source reader keeps translated main and aside order, localized scene labels and original source identity', () => {
  const raw = source(
      'The reader enters the harbor.\r\n@hsTitle: Quiet Bell\r\n⟦Tower @ Dawn @ Mira⟧\r\nMira imagines a bell.\r\n@hs\r\nThe reader hears waves.'
    ),
    before = structuredClone(raw);
  const record = { id: raw.sourceRevision, hash: raw.sourceHash, text: raw.text } as Source;
  const translationText = raw.text
    .replace('The reader enters the harbor.', '독자가 항구에 들어와요.')
    .replace('Quiet Bell', '고요한 종')
    .replace('Tower @ Dawn @ Mira', '탑 @ 새벽 @ 미라')
    .replace('Mira imagines a bell.', '미라는 종을 상상해요.')
    .replace('The reader hears waves.', '독자는 파도를 들어요.');
  const props = {
    source: record,
    config: createSourceSegmentFixture(),
    blocks: [{ anchor: 'all', start: 0, end: raw.text.length }],
    inline: () => [],
  };
  const html = renderToStaticMarkup(
    createElement(SourceSegmentBody, { ...props, translationText })
  );
  expect(html).toContain('translation-text');
  expect(html.indexOf('독자가 항구')).toBeLessThan(html.indexOf('고요한 종'));
  expect(html.indexOf('고요한 종')).toBeLessThan(html.indexOf('미라는 종을 상상'));
  expect(html.indexOf('미라는 종을 상상')).toBeLessThan(html.indexOf('독자는 파도를'));
  expect(html).toContain('<dd>탑</dd>');
  expect(html).toContain('<dd>새벽</dd>');
  expect(html).not.toContain('@hsTitle:');
  expect(raw).toEqual(before);
  const broken = renderToStaticMarkup(
    createElement(SourceSegmentBody, {
      ...props,
      translationText: translationText.replace('@hsTitle:', ''),
    })
  );
  expect(broken).toContain('구간 경계를 확인할 수 없어');
  expect(broken).toContain('source-text');
  expect(broken).toContain('The reader enters the harbor.');
  expect(broken).not.toContain('독자가 항구에');
});

test('malformed original markers remain visible with diagnostics and an invalid policy falls back to original prose', () => {
  const raw = source('Main.\n@hsTitle: Never closed\noriginal secret.');
  const policy = createSourceSegmentFixture();
  const html = renderToStaticMarkup(createElement(SourceSegmentsReader, { source: raw, policy }));
  expect(html).toContain('SEGMENT_UNCLOSED');
  expect(html).toContain('@hsTitle: Never closed');
  expect(html).toContain('original secret.');
  const invalid = structuredClone(policy);
  invalid.rules[0].close = invalid.rules[0].open;
  const fallback = renderToStaticMarkup(
    createElement(SourceSegmentsReader, { source: raw, policy: invalid })
  );
  expect(fallback).toContain('구간 정보를 확인할 수 없어 원문 그대로');
  expect(fallback).toContain('@hsTitle: Never closed');
});
