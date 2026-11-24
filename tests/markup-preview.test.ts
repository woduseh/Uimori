import { expect, test } from 'vitest';
import { markupPreview } from '../web/markup-preview.js';

test('removes nested CBS blocks, tags and scripts from a preview', () => {
  expect(
    markupPreview(
      '{{#if {{? {{getvar::seen}} = 1}}}}<div class="a">다시 왔네</div>{{/if}}\n<p>어서 와, {{user}}.</p><script>x()</script>',
      80
    )
  ).toBe('다시 왔네 어서 와, .');
});

test('returns an empty preview when only markup remains', () => {
  expect(markupPreview('<div style="x">{{setvar::a::1}}</div><!-- note -->', 55)).toBe('');
});

test('decodes common entities and limits the length', () => {
  expect(markupPreview('A&amp;B&nbsp;&lt;C&gt; 긴 문장입니다', 7)).toBe('A&B <C>');
});
