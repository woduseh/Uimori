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
        components: [
          { id: 'root', component: 'Column', children: ['title', 'text', 'field'] },
          { id: 'title', component: 'Text', text: '오래된 정원' },
          { id: 'text', component: 'Text', text: '문 너머에서 바람이 불어와요.' },
          { id: 'field', component: 'TextField', label: '메모', value: { '@path': '/note' } },
        ],
      },
    },
  ],
} as Extract<StoryUiSegment, { kind: 'ui' }>;
