import { createRoot } from 'react-dom/client';
import { StoryUi } from '../../web/StoryUi.js';
import type { StoryUiSegment } from '../../core/story-ui.js';

export function mountStoryUi(
  element: HTMLElement,
  style?: import('../../core/story-ui-style.js').StoryUiStyle
) {
  const segment = {
    kind: 'ui',
    id: 'story-ui-0',
    start: 0,
    end: 1,
    expression: '<a2ui></a2ui>',
    surfaceId: 'main',
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'main',
          catalogId: 'urn:uimori:story-ui:1',
          components: [
            { id: 'root', component: 'Column', children: ['tabs', 'field'] },
            {
              id: 'tabs',
              component: 'Tabs',
              tabs: [
                { title: '첫째', child: 'one' },
                { title: '둘째', child: 'two' },
              ],
            },
            { id: 'one', component: 'Text', text: '첫 화면' },
            { id: 'two', component: 'Text', text: '다음 화면' },
            { id: 'field', component: 'TextField', label: '이름', value: { '@path': '/name' } },
          ],
        },
      },
    ],
  } as StoryUiSegment;
  createRoot(element).render(
    <StoryUi segment={segment as Extract<StoryUiSegment, { kind: 'ui' }>} style={style} />
  );
}

export async function mountReader(
  element: HTMLElement,
  source: import('../../core/types.js').Source,
  jobs: import('../../core/types.js').Job[] = []
) {
  const { SourceReader } = await import('../../web/SourceReader.js');
  createRoot(element).render(
    <SourceReader
      source={source}
      index={0}
      latest
      jobs={jobs}
      assets={[]}
      refresh={async () => {}}
      onError={() => {}}
      onFork={async () => {}}
    />
  );
}

export async function mountStreaming(
  element: HTMLElement,
  text: string,
  style?: import('../../core/story-ui-style.js').StoryUiStyle
) {
  const { StreamingStoryText } = await import('../../web/StreamingResponse.js');
  const root = createRoot(element);
  const show = (value: string) => root.render(<StreamingStoryText text={value} style={style} />);
  show(text);
  return show;
}

export function mountCharts(element: HTMLElement) {
  const segment = {
    kind: 'ui',
    id: 'charts',
    start: 0,
    end: 1,
    expression: '<a2ui></a2ui>',
    surfaceId: 'main',
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'main',
          catalogId: 'urn:uimori:story-ui:1',
          components: [
            { id: 'root', component: 'Column', children: ['line', 'bar'] },
            {
              id: 'line',
              component: 'LineChart',
              title: '온도 변화',
              items: [
                { label: '밤', value: -10 },
                { label: '낮', value: 20 },
              ],
            },
            {
              id: 'bar',
              component: 'BarChart',
              title: '수지',
              items: [
                { label: '손실', value: -10 },
                { label: '이익', value: 20 },
              ],
            },
          ],
        },
      },
    ],
  } as StoryUiSegment;
  createRoot(element).render(
    <StoryUi segment={segment as Extract<StoryUiSegment, { kind: 'ui' }>} />
  );
}
