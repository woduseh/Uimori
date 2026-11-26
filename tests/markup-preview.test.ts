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
