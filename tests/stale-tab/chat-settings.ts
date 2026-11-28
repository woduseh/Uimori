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

const operationIdExemption =
  'operationId is a client-generated idempotency key for chat option writes, like idempotencyKey, not a stored resource target.';

export const chatSettingsCases = domainCases('chat-settings', {
  readOptions: { cases: [readDeleted] },
  fixOptions: {
    cases: [
      {
        when: 'a chat another tab deleted and values no option defines',
        arrange: () => optionWrite({ undefinedOption: 'x' }, {}),
        answer: conflict,
        target: 'chatId',
      },
    ],
    exemptTargets: { operationId: operationIdExemption },
  },
  stageOptions: {
    cases: [
      {
        when: 'a chat another tab deleted and values no option defines',
        arrange: () => optionWrite({ undefinedOption: 'x' }, { tone: 'warm' }),
        answer: conflict,
        target: 'chatId',
      },
    ],
    exemptTargets: { operationId: operationIdExemption },
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
        target: 'chatId',
      },
      {
        when: 'a staged option another tab replaced',
        arrange: async () => {
          withOptionControl();
          const live = chatId('Stale tab replaced pending option');
          const { binding } = await optionState(live);
          const first = await staged(live, binding);
          const replaced = await read<OptionState>(endpoints.stageOptions, {
            chatId: live,
            expectedRevision: first.revision,
            operationId: randomUUID(),
            binding,
            values: { tone: 'sharp' },
          });
          const request = { chatId: live, expectedRevision: replaced.revision };
          return {
            input: { ...request, pendingId: first.pending[0]!.id, operationId: randomUUID() },
            control: { ...request, pendingId: replaced.pending[0]!.id, operationId: randomUUID() },
          };
        },
        answer: conflict,
        target: 'pendingId',
      },
    ],
    exemptTargets: { operationId: operationIdExemption },
  },
  readVariables: { cases: [readDeleted] },
  readStoryGuide: { cases: [readDeleted] },
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
        target: 'chatId',
      },
      {
        when: 'an orphan note another tab already retired',
        arrange: async () => {
          const live = chatId('Stale tab retired orphan memory');
          const gone = orphanNote(live);
          const kept = orphanNote(live);
          await read(endpoints.applyOrphanMemory, {
            chatId: live,
            kind: 'note',
            action: 'retire',
            entryId: gone,
            expectedRevision: 0,
            expectedLoreRevision: 0,
            expectedHeadRevision: null,
            expectedHeadHash: null,
            idempotencyKey: randomUUID(),
          });
          const current = await read<{
            revision: number;
            loreRevision: number;
            headRevision: string | null;
            headHash: string | null;
          }>(endpoints.readOrphanMemory, { chatId: live });
          const request = {
            chatId: live,
            kind: 'note',
            action: 'retire',
            expectedRevision: current.revision,
            expectedLoreRevision: current.loreRevision,
            expectedHeadRevision: current.headRevision,
            expectedHeadHash: current.headHash,
          };
          return {
            input: { ...request, entryId: gone, idempotencyKey: randomUUID() },
            control: { ...request, entryId: kept, idempotencyKey: randomUUID() },
          };
        },
        answer: conflict,
        target: 'entryId',
      },
    ],
  },
});
