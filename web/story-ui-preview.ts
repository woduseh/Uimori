import type { StoryUiSegment } from '../core/story-ui.js';

export const storyUiPreview = {
  kind: 'ui',
  id: 'theme-preview',
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
        // One of each surface an authored theme most often restyles.
        components: [
          { id: 'root', component: 'Frame', title: '오래된 정원', subtitle: '기록', child: 'body' },
          {
            id: 'body',
            component: 'Column',
            children: ['text', 'theirs', 'mine', 'stats', 'tabs', 'field', 'button'],
          },
          { id: 'text', component: 'Text', text: '문 너머에서 바람이 불어와요.' },
          { id: 'theirs', component: 'Message', text: '거기 누구 있어요?', sender: '정원사' },
          { id: 'mine', component: 'Message', text: '길을 잃었어요.', side: 'right' },
          { id: 'stats', component: 'Row', children: ['stat', 'gauge'] },
          { id: 'stat', component: 'Stat', label: '남은 등불', value: 3 },
          { id: 'gauge', component: 'Gauge', label: '기력', value: 62, min: 0, max: 100 },
          {
            id: 'tabs',
            component: 'Tabs',
            tabs: [
              { title: '지도', child: 'map' },
              { title: '수첩', child: 'notes' },
            ],
          },
          { id: 'map', component: 'Text', text: '북쪽 온실까지 두 갈래 길이 있어요.' },
          { id: 'notes', component: 'Text', text: '분수대의 물은 마시지 말 것.' },
          { id: 'field', component: 'TextField', label: '메모', value: { '@path': '/note' } },
          {
            id: 'button',
            component: 'Button',
            child: 'buttonText',
            action: { event: { name: 'enter' } },
          },
          { id: 'buttonText', component: 'Text', text: '온실로 들어간다' },
        ],
      },
    },
  ],
} as Extract<StoryUiSegment, { kind: 'ui' }>;
