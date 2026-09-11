import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Source } from '../core/types.js';
import { parseSourceSegments, type SegmentSource } from '../core/source-segments.js';
import { SourceSegmentsReader } from '../web/SourceSegmentsReader.js';
import { SourceSegmentBody } from '../web/SourceReader.js';
import {
  createNeutralAnnotationFixture,
  createSourceSegmentFixture,
} from './fixtures/source-segments.js';

const source = (text: string): SegmentSource => ({
  sourceRevision: 'synthetic-source',
  text,
  sourceHash: createHash('sha256').update(text).digest('hex'),
});

test('segment reader escapes HTML and never executes markup carried by a header or a reference line', () => {
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
  // An unsupported reference line is ordinary escaped body text, not a hidden or rendered asset.
  expect(html).toContain('&lt;script&gt;portraitBad()');
  expect(html).toContain('[hsPortrait:');
  expect(html).not.toContain('표시할 수 없어요');
  expect(html).not.toContain('등장인물');
  expect(raw).toEqual(before);
  expect(parseSourceSegments(raw, createSourceSegmentFixture({ expanded: false }))).toEqual(parsed);
});

test('a neutral annotation package folds its own segment without any character or portrait notice', () => {
  const raw = source('Visible prose.\n[note]Editing memo for the author.[/note]\nMore prose.');
  const policy = createNeutralAnnotationFixture();
  const html = renderToStaticMarkup(createElement(SourceSegmentsReader, { source: raw, policy }));
  expect(html).toContain('편집 메모');
  expect(html).toContain('Editing memo for the author.');
  expect(html).not.toContain('등장인물');
  expect(html).not.toContain('시점');
  expect(html).not.toContain('source-segment-scene');
});

test('source reader preserves original segment order, scene labels and source identity', () => {
  const raw = source(
    'The reader enters the harbor.\n@hsTitle: Quiet Bell\n⟦Tower @ Dawn @ Mira⟧\nMira imagines a bell.\n@hs\nThe reader hears waves.'
  );
  const before = structuredClone(raw);
  const html = renderToStaticMarkup(
    createElement(SourceSegmentBody, {
      source: { id: raw.sourceRevision, hash: raw.sourceHash, text: raw.text } as Source,
      config: createSourceSegmentFixture(),
      blocks: [{ anchor: 'all', start: 0, end: raw.text.length }],
      inline: () => [],
    })
  );
  expect(html).toContain('source-text');
  expect(html.indexOf('The reader enters')).toBeLessThan(html.indexOf('Quiet Bell'));
  expect(html.indexOf('Quiet Bell')).toBeLessThan(html.indexOf('Mira imagines'));
  expect(html.indexOf('Mira imagines')).toBeLessThan(html.indexOf('The reader hears'));
  expect(html).toContain('<dd>Tower</dd>');
  expect(html).toContain('<dd>Dawn</dd>');
  expect(html).not.toContain('@hsTitle:');
  expect(raw).toEqual(before);
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
