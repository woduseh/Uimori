import { validateContentPackage } from '../../core/content-package.js';

/** Entirely synthetic common panel with a dependent selector, nested ledger and dynamic instructions. */
export function createPanelPackage() {
  return validateContentPackage({
    version: 1,
    id: 'panel-example',
    revision: 1,
    title: '합성 경로 안내',
    description: '',
    body: 'Synthetic adult explorers.',
    lore: [],
    controls: [],
    transforms: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      stateSchema: {
        type: 'record',
        properties: {
          route: { type: 'enum', values: ['unselected', 'harbor', 'ridge'] },
          ledger: {
            type: 'list',
            maxItems: 20,
            items: {
              type: 'record',
              properties: {
                name: { type: 'string', maxLength: 100 },
                amount: { type: 'number', min: 0, max: 100 },
              },
            },
          },
          note: { type: 'string', maxLength: 1000 },
        },
      },
      initialState: { route: 'unselected', ledger: [{ name: '물', amount: 2 }], note: '' },
      actions: [
        {
          id: 'choose',
          label: '경로 저장',
          inputSchema: {
            type: 'record',
            properties: { route: { type: 'enum', values: ['harbor', 'ridge'] } },
          },
          effects: [{ path: ['route'], value: { context: ['input', 'route'] } }],
        },
        {
          id: 'again',
          label: '경로 다시 선택',
          inputSchema: { type: 'record', properties: {} },
          effects: [{ path: ['route'], value: 'unselected' }],
        },
        {
          id: 'note',
          label: '메모 저장',
          inputSchema: {
            type: 'record',
            properties: { note: { type: 'string', maxLength: 1000 } },
          },
          effects: [{ path: ['note'], value: { context: ['input', 'note'] } }],
        },
      ],
      outputParsers: [
        {
          id: 'ledger',
          required: false,
          format: 'json',
          start: '<LEDGER>',
          end: '</LEDGER>',
          fields: [{ path: ['ledger'], from: ['items'], valueType: 'json' }],
        },
      ],
    },
    instructions: [
      {
        id: 'route',
        target: 'main',
        text: '',
        template: [
          { kind: 'text', text: 'Selected route: ' },
          { kind: 'value', expression: { context: ['state', 'route'] } },
          { kind: 'text', text: '; Ledger: ' },
          { kind: 'value', expression: { context: ['state', 'ledger'] } },
        ],
      },
    ],
    panels: [
      {
        id: 'journey',
        title: '탐험 준비',
        actions: ['choose', 'again', 'note'],
        css: '.ledger{display:grid;gap:8px;padding:0;list-style:none}.ledger li{display:flex;justify-content:space-between;border-bottom:1px solid #8884;padding:6px}form{display:grid;gap:10px;margin-block:12px}button{cursor:pointer}',
        template: [
          {
            kind: 'if',
            condition: { op: 'equal', args: [{ context: ['state', 'route'] }, 'unselected'] },
            then: [
              {
                kind: 'text',
                text: '<form data-uimori-action="choose"><label>출발 경로<select name="route"><option value="harbor">항구</option><option value="ridge">산등성이</option></select></label><button type="submit">경로 선택</button></form>',
              },
            ],
            else: [
              { kind: 'text', text: '<p>선택한 경로: <strong id="route">' },
              { kind: 'value', expression: { context: ['state', 'route'] } },
              {
                kind: 'text',
                text: '</strong></p><button type="button" data-uimori-action="again">다시 선택</button>',
              },
            ],
          },
          { kind: 'text', text: '<details open><summary>보급 기록</summary><ul class="ledger">' },
          {
            kind: 'each',
            source: { context: ['state', 'ledger'] },
            as: 'item',
            body: [
              { kind: 'text', text: '<li><span>' },
              { kind: 'value', expression: { local: 'item', path: ['name'] } },
              { kind: 'text', text: '</span><strong>' },
              { kind: 'value', expression: { local: 'item', path: ['amount'] } },
              { kind: 'text', text: '</strong></li>' },
            ],
          },
          {
            kind: 'text',
            text: '</ul></details><form data-uimori-action="note"><label>준비 메모<textarea name="note" maxlength="1000">',
          },
          { kind: 'value', expression: { context: ['state', 'note'] } },
          {
            kind: 'text',
            text: '</textarea></label><button type="submit">메모 반영</button></form>',
          },
        ],
      },
    ],
  });
}
