import { randomUUID } from 'node:crypto';
import { allEndpoints } from '#contracts';
import { DEFAULT_MAIN_PROMPT } from '../../core/prompts.js';
import { deleteChat } from '../../server/chat-deletion.js';
import { promptWorkspace, updatePromptWorkspace } from '../../server/prompt-workspace.js';
import { createFixtureChat } from '../fixtures/chat.js';
import { nativePrompt } from '../fixtures/native-prompt.js';
import { conflict, deleted, domainCases, read, store } from './harness.js';

const endpoints = allEndpoints['chat-settings'];
const chatId = (title: string) => createFixtureChat(store(), title).id;
const goneChatId = () => {
  const id = chatId('Stale tab gone chat');
  deleteChat(store(), id);
  return id;
};
const readDeleted = {
  when: 'a chat another tab deleted',
  arrange: () => ({ input: { chatId: goneChatId() } }),
  answer: deleted,
};

let optionControl = false;
function withOptionControl() {
  if (optionControl) return;
  const prior = promptWorkspace(store());
  updatePromptWorkspace(store(), {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      values: { tone: 'calm' },
      program: nativePrompt(DEFAULT_MAIN_PROMPT, { customPromptTemplateToggle: 'tone=Tone=text' }),
    },
  });
  optionControl = true;
}
type OptionState = { revision: number; binding: unknown; pending: { id: string }[] };
const optionState = (id: string) => read<OptionState>(endpoints.readOptions, { chatId: id });
const staged = (id: string, binding: unknown) =>
  read<OptionState>(endpoints.stageOptions, {
    chatId: id,
    expectedRevision: 0,
    operationId: randomUUID(),
    binding,
    values: { tone: 'warm' },
  });

async function optionWrite(values: Record<string, unknown>, controlValues = values) {
  withOptionControl();
  const live = chatId('Stale tab options');
  const { binding } = await optionState(live);
  const request = { expectedRevision: 0, binding };
  return {
    input: {
      ...request,
      chatId: goneChatId(),
      operationId: randomUUID(),
      binding: { owner: 'workspace:main', definitionHash: 'a'.repeat(64) },
      values,
    },
    control: { ...request, chatId: live, operationId: randomUUID(), values: controlValues },
  };
}

const guide = {
  enabled: true,
  work: 'Stale tab work',
  reference: '',
  position: '',
  followCanon: false,
  webSearch: false,
};

function orphanNote(id: string) {
  const note = randomUUID();
  store()
    .db.prepare('INSERT INTO author_notes VALUES(?,?,?,NULL,NULL)')
    .run(
      note,
      id,
      JSON.stringify({
        id: note,
        chatId: id,
        kind: 'author-note',
        atRevision: randomUUID(),
        atHash: 'b'.repeat(64),
        text: 'Stale tab note',
        declaration: { author: 'Stale tab', text: 'Stale tab note' },
      })
    );
  return note;
}

export const chatSettingsCases = domainCases('chat-settings', {
  readOptions: { cases: [readDeleted] },
  fixOptions: {
    cases: [
      {
        when: 'a chat another tab deleted and values no option defines',
        arrange: () => optionWrite({ undefinedOption: 'x' }, {}),
        answer: conflict,
      },
    ],
  },
  stageOptions: {
    cases: [
      {
        when: 'a chat another tab deleted and values no option defines',
        arrange: () => optionWrite({ undefinedOption: 'x' }, { tone: 'warm' }),
        answer: conflict,
      },
    ],
  },
  cancelStagedOptions: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: async () => {
          withOptionControl();
          const live = chatId('Stale tab pending options');
          const { binding } = await optionState(live);
          const { revision, pending } = await staged(live, binding);
          const request = { expectedRevision: revision, pendingId: pending[0]!.id };
          return {
            input: { ...request, chatId: goneChatId(), operationId: randomUUID() },
            control: { ...request, chatId: live, operationId: randomUUID() },
          };
        },
        answer: conflict,
      },
    ],
  },
  readVariables: { cases: [readDeleted] },
  writeVariables: {
    cases: [
      {
        when: 'a chat another tab deleted and values the service refuses',
        arrange: () => {
          const request = { expectedRevision: 0, expectedSourceHash: null };
          return {
            input: {
              ...request,
              chatId: goneChatId(),
              idempotencyKey: randomUUID(),
              values: { prototype: 'x' },
            },
            control: {
              ...request,
              chatId: chatId('Stale tab variables'),
              idempotencyKey: randomUUID(),
              values: { mood: 'calm' },
            },
          };
        },
        answer: conflict,
      },
    ],
  },
  readStoryGuide: { cases: [readDeleted] },
  updateStoryGuide: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: { chatId: goneChatId(), expectedRevision: 0, config: guide },
          control: { chatId: chatId('Stale tab guide'), expectedRevision: 0, config: guide },
        }),
        answer: conflict,
      },
    ],
  },
  readOrphanMemory: { cases: [readDeleted] },
  applyOrphanMemory: {
    cases: [
      {
        when: 'a chat another tab deleted and an entry no memory lists',
        arrange: () => {
          const live = chatId('Stale tab orphan memory');
          const request = {
            kind: 'note',
            action: 'retire',
            expectedRevision: 0,
            expectedLoreRevision: 0,
            expectedHeadRevision: null,
            expectedHeadHash: null,
          };
          return {
            input: {
              ...request,
              chatId: goneChatId(),
              entryId: 'no-such-entry',
              idempotencyKey: randomUUID(),
            },
            control: {
              ...request,
              chatId: live,
              entryId: orphanNote(live),
              idempotencyKey: randomUUID(),
            },
          };
        },
        answer: conflict,
      },
    ],
  },
});
