import { expect, test } from 'vitest';
import { untaggedStoryUiSegments } from '../core/story-ui-scan.js';
import { parseStoryUi } from '../core/story-ui.js';

test('the light scanner matches the validating parser on text without Story UI tags', () => {
  for (const text of ['', '평범한 문단 😀\r\n\r\n둘째', '`<a2u` 와 ```js\ncode\n```'])
    expect(untaggedStoryUiSegments(text)).toEqual(parseStoryUi(text));
  for (const text of ['앞 <a2ui>x</a2ui>', '```uimori-ui\n{}\n```', '`<a2ui>`'])
    expect(untaggedStoryUiSegments(text)).toBeNull();
});
