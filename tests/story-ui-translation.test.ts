// biome-ignore-all lint/suspicious/noTemplateCurlyInString: A2UI interpolation is literal fixture data.
import { expect, test } from 'vitest';
import { encodeStoryUi, parseStoryUi, type StoryUiMessage } from '../core/story-ui.js';
import { prepareStoryUiTranslation } from '../core/story-ui-translation.js';

test('translates input hints and image descriptions while preserving their values and URLs', () => {
  const original = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        components: [
          { id: 'root', component: 'Column', children: ['input', 'image'] },
          {
            id: 'input',
            component: 'TextField',
            label: 'Reply',
            placeholder: 'Write a message',
            value: { '@path': '/reply' },
          },
          {
            id: 'image',
            component: 'Image',
            url: '/api/assets/portrait',
            description: 'Student portrait',
          },
        ],
        dataModel: { reply: 'Meet at noon' },
      },
    },
  ] as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(
    encodeStoryUi('<a2ui>root = Column([])</a2ui>', original)
  );
  expect(prepared.text).toContain('Write a message');
  expect(prepared.text).toContain('Student portrait');
  const restored = prepared.restore(
    prepared.text
      .replace('Write a message', '메시지를 입력하세요')
      .replace('Student portrait', '학생 사진')
  );
  expect(restored).toContain('메시지를 입력하세요');
  expect(restored).toContain('학생 사진');
  expect(restored).toContain('/api/assets/portrait');
  expect(restored).toContain('Meet at noon');
});

const messages = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'main',
      catalogId: 'urn:uimori:story-ui:1',
      components: [
        { id: 'root', component: 'Column', children: ['label', 'chart', 'button'] },
        { id: 'label', component: 'Text', text: 'Choose a route' },
        {
          id: 'chart',
          component: 'BarChart',
          title: 'Counts',
          items: [{ label: 'Spring', value: 12 }],
        },
        {
          id: 'button',
          component: 'Button',
          child: 'button_text',
          action: { event: { name: 'go', context: { destination: 'harbor' } } },
        },
        { id: 'button_text', component: 'Text', text: 'Go' },
      ],
    },
  },
] as unknown as StoryUiMessage[];
const block = encodeStoryUi('<a2ui>root = Text("original")</a2ui>', messages);

test('translation restores host-owned structure and actions with translated wording', () => {
  const prepared = prepareStoryUiTranslation(`Before\n${block}\nAfter`);
  expect(prepared.protected).toBe(true);
  expect(prepared.text).not.toContain('destination');
  const output = prepared.text
    .replace('Before', '이전')
    .replace('After', '이후')
    .replace('["Choose a route","Counts","Spring","Go"]', '["경로를 선택해요","개수","봄","출발"]');
  const restored = prepared.restore(output);
  const segment = parseStoryUi(restored).find((item) => item.kind === 'ui');
  expect(segment?.kind).toBe('ui');
  if (segment?.kind !== 'ui') throw new Error('UI missing');
  const surface = (
    segment.messages[0] as unknown as { createSurface: { components: Record<string, unknown>[] } }
  ).createSurface;
  expect(surface.components[1].text).toBe('경로를 선택해요');
  expect(surface.components[2].items).toEqual([{ label: '봄', value: 12 }]);
  expect(surface.components[3].action).toEqual({
    event: { name: 'go', context: { destination: 'harbor' } },
  });
  expect(segment.expression).toBe('<a2ui>root = Text("original")</a2ui>');
});

test('missing, duplicated or malformed placeholders fail and invalid blocks remain intact', () => {
  const invalid = '<a2ui>unfinished';
  const prepared = prepareStoryUiTranslation(`${block}\n${invalid}`);
  expect(() =>
    prepared.restore(
      prepared.text.replace(/<UIMORI_UI_TRANSLATION_0>.*?<\/UIMORI_UI_TRANSLATION_0>/u, '')
    )
  ).toThrow('OUTPUT_STORY_UI_INVALID');
  expect(() => prepared.restore(prepared.text + prepared.text)).toThrow('OUTPUT_STORY_UI_INVALID');
  expect(() => prepared.restore(prepared.text.replace('"Go"', 'null'))).toThrow(
    'OUTPUT_STORY_UI_INVALID'
  );
  expect(prepared.restore(prepared.text)).toContain(invalid);
});

test('translates display-only bindings while preserving paths shared with actions', () => {
  const bound = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        dataModel: { display: { heading: 'Welcome' }, shared: 'Go' },
        components: [
          { id: 'root', component: 'Column', children: ['heading', 'button'] },
          { id: 'heading', component: 'Text', text: { '@path': '/display/heading' } },
          {
            id: 'button',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'go', context: { value: { '@path': '/shared' } } } },
          },
          { id: 'label', component: 'Text', text: { '@path': '/shared' } },
        ],
      },
    },
  ] as unknown as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(
    encodeStoryUi('<a2ui>root = Text("Welcome")</a2ui>', bound)
  );
  expect(prepared.text).toContain('["Welcome"]');
  const segment = parseStoryUi(prepared.restore(prepared.text.replace('Welcome', '환영해요')))[0];
  expect(segment.kind).toBe('ui');
  if (segment.kind !== 'ui') throw new Error('UI missing');
  const surface = (segment.messages[0] as unknown as { createSurface: { dataModel: unknown } })
    .createSurface;
  expect(surface.dataModel).toEqual({ display: { heading: '환영해요' }, shared: 'Go' });
});

test('translates repeated template labels while preserving action and input bindings', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        dataModel: {
          people: [
            { name: 'Alice', id: 'id-a', shared: 'Secret A' },
            { name: 'Bob', id: 'id-b', shared: 'Secret B' },
          ],
        },
        components: [
          { id: 'root', component: 'List', children: { path: '/people', componentId: 'item' } },
          { id: 'item', component: 'Column', children: ['name', 'shared', 'button'] },
          { id: 'name', component: 'Text', text: { '@path': 'name' } },
          { id: 'shared', component: 'Text', text: { '@path': 'shared' } },
          {
            id: 'button',
            component: 'Button',
            child: 'button_label',
            action: {
              event: {
                name: 'select',
                context: { id: { '@path': 'id' }, shared: { '@path': 'shared' } },
              },
            },
          },
          { id: 'button_label', component: 'Text', text: 'Select' },
        ],
      },
    },
  ] as unknown as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(encodeStoryUi('<a2ui>root = List()</a2ui>', messages));
  expect(prepared.text).toContain('["Select","Alice","Bob"]');
  const translated = prepared.text.replace('["Select","Alice","Bob"]', '["선택","앨리스","밥"]');
  const segment = parseStoryUi(prepared.restore(translated))[0];
  expect(segment.kind).toBe('ui');
  if (segment.kind !== 'ui') throw new Error('UI missing');
  const surface = (
    segment.messages[0] as unknown as {
      createSurface: { dataModel: unknown; components: Record<string, unknown>[] };
    }
  ).createSurface;
  expect(surface.dataModel).toEqual({
    people: [
      { name: '앨리스', id: 'id-a', shared: 'Secret A' },
      { name: '밥', id: 'id-b', shared: 'Secret B' },
    ],
  });
  expect(surface.components[4].action).toEqual({
    event: { name: 'select', context: { id: { '@path': 'id' }, shared: { '@path': 'shared' } } },
  });
});

test('preserves template descendants when an action references the whole item', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        dataModel: { people: [{ name: 'Alice' }] },
        components: [
          { id: 'root', component: 'List', children: { path: '/people', componentId: 'item' } },
          {
            id: 'item',
            component: 'Button',
            child: 'name',
            action: { event: { name: 'select', context: { person: { '@path': '' } } } },
          },
          { id: 'name', component: 'Text', text: { '@path': 'name' } },
        ],
      },
    },
  ] as unknown as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(encodeStoryUi('<a2ui>root = List()</a2ui>', messages));
  expect(prepared.text).toContain('>[]</UIMORI_UI_TRANSLATION_0>');
  const segment = parseStoryUi(prepared.restore(prepared.text))[0];
  expect(segment.kind).toBe('ui');
  if (segment.kind !== 'ui') throw new Error('UI missing');
  expect(
    (segment.messages[0] as unknown as { createSurface: { dataModel: unknown } }).createSurface
      .dataModel
  ).toEqual({ people: [{ name: 'Alice' }] });
});

test('translates formatString wording while retaining its dynamic expressions', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        dataModel: { name: 'Alice', title: 'Captain' },
        components: [
          {
            id: 'root',
            component: 'Text',
            text: { '@call': 'formatString', args: { value: 'Hello ${/title} ${/name}!' } },
          },
        ],
      },
    },
  ] as unknown as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(
    encodeStoryUi('<a2ui>root = Text("Hello")</a2ui>', messages)
  );
  expect(prepared.text).toContain('["Hello ${/title} ${/name}!"]');
  const translated = prepared.text.replace(
    'Hello ${/title} ${/name}!',
    '${/name} ${/title}, 안녕하세요!'
  );
  const segment = parseStoryUi(prepared.restore(translated))[0];
  expect(segment.kind).toBe('ui');
  if (segment.kind !== 'ui') throw new Error('UI missing');
  const surface = (
    segment.messages[0] as unknown as {
      createSurface: { dataModel: unknown; components: Record<string, unknown>[] };
    }
  ).createSurface;
  expect(surface.components[0].text).toEqual({
    '@call': 'formatString',
    args: { value: '${/name} ${/title}, 안녕하세요!' },
  });
  expect(surface.dataModel).toEqual({ name: 'Alice', title: 'Captain' });
  expect(() => prepared.restore(translated.replace('${/name}', '${/other}'))).toThrow(
    'OUTPUT_STORY_UI_INVALID'
  );
  expect(() => prepared.restore(translated.replace('${/name}', ''))).toThrow(
    'OUTPUT_STORY_UI_INVALID'
  );
  expect(() => prepared.restore(translated.replace('${/name}', '${/name'))).toThrow(
    'OUTPUT_STORY_UI_INVALID'
  );
});

test('preserves a displayed data binding used inside an action formatString', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        dataModel: { name: 'Alice' },
        components: [
          {
            id: 'root',
            component: 'Button',
            child: 'name',
            action: {
              event: {
                name: 'choose',
                context: {
                  command: { '@call': 'formatString', args: { value: 'select ${/name}' } },
                },
              },
            },
          },
          { id: 'name', component: 'Text', text: { '@path': '/name' } },
        ],
      },
    },
  ] as unknown as StoryUiMessage[];
  const prepared = prepareStoryUiTranslation(
    encodeStoryUi('<a2ui>root = Button()</a2ui>', messages)
  );
  expect(prepared.text).toContain('>[]</UIMORI_UI_TRANSLATION_0>');
  expect(parseStoryUi(prepared.restore(prepared.text))[0].kind).toBe('ui');
});
