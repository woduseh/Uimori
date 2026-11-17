import { createRoot } from 'react-dom/client';
import { parseStoryUi } from '../../core/story-ui.js';
import { StoryUi } from '../../web/StoryUi.js';

export function mountImages(element: HTMLElement, source: string) {
  const segment = parseStoryUi(source)[0];
  if (segment.kind !== 'ui') throw new Error('Expected a compiled image list');
  createRoot(element).render(<StoryUi segment={segment} />);
}
