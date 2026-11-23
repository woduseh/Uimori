import { expect, test, vi } from 'vitest';
import { parseStoryUi } from '../core/story-ui.js';
import { normalizeStoryUiOutput } from '../server/story-ui.js';

vi.stubGlobal('HTMLElement', class {});
const { createStoryUiProcessor } = await import('../web/StoryUi.js');

test('editing a surface data model leaves the parsed segment messages unchanged', () => {
  const segment = parseStoryUi(
    normalizeStoryUiOutput(`<a2ui>
$/name = "Mira"
root = TextField("Name", value=$/name)
</a2ui>`)
  )[0];
  if (segment.kind !== 'ui') throw new Error('Expected a compiled block');
  const parsed = structuredClone(segment.messages);
  const processor = createStoryUiProcessor(segment.messages, () => {});
  const surface = processor?.getSurface(segment.surfaceId);
  expect(surface?.dataModel.get('/name')).toBe('Mira');
  surface?.dataModel.set('/name', 'Sol');
  expect(surface?.dataModel.get('/name')).toBe('Sol');
  expect(segment.messages).toEqual(parsed);
  processor?.dispose();
});
