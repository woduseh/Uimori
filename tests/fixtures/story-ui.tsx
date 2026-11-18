import { createRoot } from 'react-dom/client';
import { StoryUi } from '../../web/StoryUi.js';
import type { StoryUiSegment } from '../../core/story-ui.js';

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
  style?: import('../../core/story-ui-style.js').StoryUiStyle,
  runId?: string
) {
  const { StreamingStoryText } = await import('../../web/StreamingResponse.js');
  const root = createRoot(element);
  const show = (value: string) =>
    root.render(<StreamingStoryText text={value} style={style} runId={runId} />);
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

export function mountPreset(
  element: HTMLElement,
  style: import('../../core/story-ui-style.js').StoryUiStyle
) {
  const titles = {
    default: '현장 기록',
    'east-asian': '운림서원 순찰록',
    fantasy: '왕립 길드의 의뢰',
    modern: '팀 업무 현황',
    period: '경성 조사 일지',
    'blue-archive': '샬레 업무 보고',
    idol: '오늘의 레슨 일정',
    neon: '제7구역 관제',
    horror: '폐병원 조사 기록',
    tactical: '작전 상황판',
    romance: '둘만의 교환 일기',
    pop: '방과 후 작전 회의',
  };
  const segment = {
    kind: 'ui',
    id: 'blue',
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
            {
              id: 'root',
              component: 'Column',
              children: ['title', 'tabs', 'field', 'table', 'button'],
            },
            { id: 'title', component: 'Text', text: titles[style] },
            {
              id: 'tabs',
              component: 'Tabs',
              tabs: [
                { title: '임무 정보', child: 'one' },
                { title: '활동 기록', child: 'two' },
              ],
            },
            {
              id: 'one',
              component: 'Text',
              text: '오늘의 순찰 구역을 확인해 주세요.',
            },
            { id: 'two', component: 'Text', text: '오늘의 활동 기록이에요.' },
            {
              id: 'field',
              component: 'TextField',
              label: '조사 메모',
              value: { '@path': '/note' },
            },
            {
              id: 'table',
              component: 'DataTable',
              title: '임무 현황',
              columns: ['구역', '상태'],
              rows: [
                ['중앙 광장', '확인 완료'],
                ['도서관', '순찰 중'],
              ],
            },
            {
              id: 'button',
              component: 'Button',
              child: 'buttonText',
              action: { event: { name: 'confirm' } },
            },
            { id: 'buttonText', component: 'Text', text: '확인' },
          ],
        },
      },
    ],
  } as StoryUiSegment;
  createRoot(element).render(
    <StoryUi segment={segment as Extract<StoryUiSegment, { kind: 'ui' }>} style={style} />
  );
}

/** Stored blocks rendered against the app's own tokens, for composition and design review. */
export async function mountGallery(
  element: HTMLElement,
  sources: string[],
  style?: import('../../core/story-ui-style.js').StoryUiStyle
) {
  await import('../../web/style.css');
  const { parseStoryUi } = await import('../../core/story-ui.js');
  createRoot(element).render(
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 16, fontSize: 18 }}>
      {sources.map((source, index) => {
        const segment = parseStoryUi(source)[0];
        if (segment.kind !== 'ui') throw new Error(`Gallery block ${index} did not compile`);
        return <StoryUi key={segment.expression} segment={segment} style={style} />;
      })}
    </div>
  );
}
