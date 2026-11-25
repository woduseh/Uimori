import type { Content, PromptPreset } from '../../core/product.js';
import type { Store } from '../../server/store.js';
import { fixtureBotInput } from './chat.js';
import { nativeContent } from './native-content.js';
import { nativePrompt } from './native-prompt.js';
export const CODE_BOT_CARD = {
  name: 'Code Bot',
  description: 'Mood {{getvar::mood}} {{#if {{getvar::open}}}}open {{unknownfn::a}}',
  first_mes:
    'Hi {{user}}.\n{{#when::toggle::style}}fancy{{:else}}plain{{/when}}\n{{img::missing-pic}}',
  alternate_greetings: ['Alt {{setvar::seen::1}}'],
  character_book: {
    entries: [
      {
        comment: 'Harbor',
        keys: ['harbor', '', 'Harbor'],
        content: '@@position pt_x\nThe harbor.',
      },
      { comment: 'Keyless', keys: [], content: 'Nothing activates me.' },
    ],
  },
  extensions: {
    risuai: {
      defaultVariables: 'mood=calm',
      toggles: 'style=Style\nunused=Unused',
      customScripts: [
        { comment: 'Shout', type: 'editoutput', in: 'hello', out: 'HELLO {{getvar::mood}}' },
        { comment: 'Broken', type: 'editdisplay', in: '(unclosed', out: 'x' },
        { comment: 'Translation', type: 'edittrans', in: 'a', out: 'b' },
        { comment: 'Emotion', type: 'editoutput', in: 'smile', out: '@@emo happy' },
        { comment: 'No pattern' },
      ],
      triggerscript: [
        {
          comment: 'Lua',
          type: 'start',
          conditions: [],
          effect: [
            {
              type: 'triggerlua',
              code: 'function onStart(id)\n  -- sleep(id, 1) is only a comment\n  sleep(id, 10)\n  LLM(id, {})\nend\n',
            },
          ],
        },
        {
          comment: 'Syntax',
          type: 'start',
          conditions: [],
          effect: [{ type: 'triggerlua', code: 'local ok = true\nlocal x = = 1' }],
        },
        {
          comment: 'Mixed',
          type: 'output',
          conditions: [{ type: 'exists', var: 'a', operator: '=', value: '1' }],
          effect: [
            { type: 'triggerlua', code: 'x = 1' },
            { type: 'setvar', var: 'a', value: '1', operator: '^=' },
          ],
        },
        { comment: 'Effect', type: 'output', conditions: [], effect: [{ type: 'v2GetCharAt' }] },
      ],
    },
  },
};

export function saveCodeBot(store: Store) {
  return store.product.content({
    ...fixtureBotInput('Code Bot'),
    package: nativeContent(structuredClone(CODE_BOT_CARD), { id: 'code-bot' }),
  }) as Content;
}

export function saveCodePreset(store: Store) {
  return store.product.promptPreset({
    title: 'Code preset',
    role: 'main',
    program: nativePrompt('Mode {{getglobalvar::toggle_mode}} {{#if 1}}', {
      customPromptTemplateToggle: 'mode=Mode',
      promptSettings: { utilOverride: true },
      regex: [{ comment: 'Bracket', type: 'editprocess', in: '[', out: '' }],
      promptTemplate: [
        { type: 'plain', text: 'Mode {{getglobalvar::toggle_mode}} {{#if 1}}', role: 'system' },
        { type: 'memory', innerFormat: '{{slot}}' },
      ],
    }),
  }) as PromptPreset;
}
