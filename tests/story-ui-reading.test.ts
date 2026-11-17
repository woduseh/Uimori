import { expect, test } from 'vitest';
import { compileReadingMarkdown } from '../core/reading-markdown.js';

test('story UI occupies its original block while reading anchors remain in place', () => {
  const text = '앞 문장\n\n```uimori-ui\n{"version":1}\n```\n\n뒤 문장';
  const start = text.indexOf('```');
  const end = text.indexOf('```', start + 3) + 3;
  const blocks = [
    { anchor: 'first', start: 0, end: 4 },
    { anchor: 'ui', start, end },
    { anchor: 'last', start: text.indexOf('뒤 문장'), end: text.length },
  ];
  const result = compileReadingMarkdown(text, blocks, [], [{ id: 'scene-ui', start }]);
  expect(result.html).toContain(
    `data-story-ui-slot="scene-ui" data-prose-start="${start}" data-prose-end="${end}"`
  );
  expect(result.html).not.toContain('{&quot;version&quot;');
  expect(result.inlineAnchors).toEqual(['first', 'ui', 'last']);
  expect(result.html.indexOf('앞 문장')).toBeLessThan(result.html.indexOf('data-story-ui-slot'));
  expect(result.html.indexOf('data-story-ui-slot')).toBeLessThan(result.html.indexOf('뒤 문장'));
});
