import { afterEach, expect, test } from 'vitest';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { randomUUID } from 'node:crypto';
import type { Content } from '../core/product.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import {
  readIllustrationAppearanceProfiles,
  validateIllustrationAppearanceProfiles,
  withIllustrationAppearanceProfiles,
} from '../core/illustration-profiles.js';
import { saveIllustrationProfiles } from '../server/helper-illustration-profiles.js';
import { saveResource } from '../server/resource-service.js';
import {
  frozenIllustrationReferences,
  illustrationReferences,
  updateIllustrationReferences,
} from '../server/illustrations.js';
import {
  inheritIllustrationProfiles,
  redrawIllustrationCanon,
} from '../server/illustration-profile-defaults.js';
import { exportRisuContent } from '../server/risu-export.js';
import { readCharacterCard } from '../server/character-card-file.js';
import { analyzeNativeRisuImport } from '../server/risu-native-import.js';
import { chatWithSource, illustrationDatabases } from './fixtures/illustration.js';

const databases = illustrationDatabases('uimori-appearance-');
afterEach(() => databases.cleanup());
const profiles = [{ id: 'mira', name: 'Mira', appearance: 'Green eyes and black hair.' }];

test('native appearance metadata preserves extensions and validates authored traits', () => {
  const document = {
    extensions: { other: true, uimori: { translationGuide: { instructions: '', terms: [] } } },
  };
  const next = withIllustrationAppearanceProfiles(document, profiles);
  expect(next.extensions).toMatchObject(document.extensions);
  expect(document.extensions.uimori).not.toHaveProperty('illustrationProfiles');
  expect(readIllustrationAppearanceProfiles(next)).toEqual(profiles);
  expect(validateIllustrationAppearanceProfiles(profiles)).toEqual(profiles);
  expect(() => validateIllustrationAppearanceProfiles([{ ...profiles[0], age: 20 }])).toThrow();
  expect(() => validateIllustrationAppearanceProfiles([profiles[0], profiles[0]])).toThrow();
  expect(
    inheritIllustrationProfiles(profiles, [{ id: 'local', name: 'Mira', appearance: 'Blue eyes.' }])
  ).toEqual([{ id: 'local', name: 'Mira', appearance: 'Blue eyes.' }]);
});

test('shared bot defaults follow native revisions, chat overrides win, CHARX round trips and invalid saves are atomic', () => {
  const store = databases.create();
  const { chat } = chatWithSource(store);
  const bot = store.product.get<Content>('content', chat.botId);
  const model = editableResource('content', bot) as ContentEditModel;
  model.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    model.package.nativeRisu.card,
    profiles
  );
  const saved = saveResource(store, {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    model,
  }).saved as Content;
  expect(illustrationReferences(store, chat.id).characterProfiles).toMatchObject(
    profiles.map(({ id: _id, ...profile }) => profile)
  );
  const overrides = [{ id: 'local', name: 'Mira', appearance: 'Blue eyes.' }];
  updateIllustrationReferences(store, chat.id, {
    expectedRevision: 0,
    references: [],
    characterProfiles: overrides,
  });
  expect(illustrationReferences(store, chat.id).characterProfiles).toEqual([
    { ...overrides[0], id: illustrationReferences(store, chat.id).defaultCharacterProfiles[0].id },
  ]);
  const charx = exportRisuContent(store.product, saved);
  const analyzed = analyzeNativeRisuImport(
    readCharacterCard({ name: charx.filename, base64: charx.bytes.toString('base64') })
  );
  expect(
    readIllustrationAppearanceProfiles(analyzed.file.contents[0].source.package.nativeRisu.card)
  ).toEqual(profiles);
  const invalid = editableResource('content', saved) as ContentEditModel;
  invalid.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    invalid.package.nativeRisu.card,
    [{ ...profiles[0], appearance: '' }]
  );
  expect(() =>
    saveResource(store, {
      kind: 'content',
      id: bot.id,
      expectedRevision: saved.revision,
      model: invalid,
    })
  ).toThrow();
  expect(store.product.get<Content>('content', bot.id).revision).toBe(saved.revision);
});

test('bot and persona defaults inherit in separate chats without changing chat overrides', () => {
  const store = databases.create();
  const botInput = fixtureBotInput();
  botInput.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    botInput.package.nativeRisu.card,
    profiles
  );
  const bot = store.product.content(botInput) as Content;
  const personaInput = {
    ...fixtureBotInput('Persona'),
    kind: 'persona',
    package: nativeContent({ name: 'Reader', description: 'Persona' }, {}, 'persona'),
  };
  personaInput.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    personaInput.package.nativeRisu.card,
    [{ id: 'reader', name: 'Reader', appearance: 'Silver hair.' }]
  );
  const persona = store.product.content(personaInput) as Content;
  const first = createFixtureChat(store, 'First', { botId: bot.id });
  const second = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Second',
      notes: [],
      packageAttachments: [
        { id: bot.id, revision: bot.revision, role: 'bot' },
        { id: persona.id, revision: persona.revision, role: 'persona' },
      ],
      entries: [{ request: 'Hello', text: 'A scene', translation: null }],
    },
  }).chat;
  expect(
    illustrationReferences(store, first.id).characterProfiles.map((profile) => profile.name)
  ).toEqual(['Mira']);
  expect(
    illustrationReferences(store, second.id).characterProfiles.map((profile) => profile.name)
  ).toEqual(['Mira', 'Reader']);
  updateIllustrationReferences(store, second.id, { expectedRevision: 0, references: [] });
  const updatedBot = editableResource('content', bot) as ContentEditModel;
  updatedBot.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    updatedBot.package.nativeRisu.card,
    [{ ...profiles[0], appearance: 'Updated shared hair.' }]
  );
  saveResource(store, {
    kind: 'content',
    id: bot.id,
    expectedRevision: bot.revision,
    model: updatedBot,
  });
  expect(illustrationReferences(store, second.id).characterProfiles[0].appearance).toBe(
    'Updated shared hair.'
  );
  updateIllustrationReferences(store, first.id, {
    expectedRevision: 0,
    references: [],
    characterProfiles: [{ ...profiles[0], appearance: 'Local red hair.' }],
  });
  expect(illustrationReferences(store, second.id).characterProfiles[0].appearance).toBe(
    'Updated shared hair.'
  );
});

test('redraw retains shared cast but current authored profiles take precedence', () => {
  const canon = [
    { name: 'Mira', appearance: 'Green eyes.' },
    { name: 'Ari', appearance: 'Black hair.' },
  ];
  expect(
    redrawIllustrationCanon(canon, [{ id: 'local', name: 'Mira', appearance: 'Blue eyes.' }])
  ).toEqual([{ name: 'Mira', appearance: 'Blue eyes.' }, canon[1]]);
  expect(redrawIllustrationCanon(undefined, profiles)).toBeUndefined();
});

test('explicit chat copies freeze one complete identity, restore latest defaults and leave others dynamic', () => {
  const store = databases.create();
  const input = fixtureBotInput();
  input.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    input.package.nativeRisu.card,
    [...profiles, { id: 'ari', name: 'Ari', appearance: 'Brown hair.' }]
  );
  let bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Inheritance', { botId: bot.id });
  const initial = illustrationReferences(store, chat.id);
  expect(initial.chatCharacterProfiles).toEqual([]);
  const edited = { ...initial.characterProfiles[0], appearance: 'Chat blue eyes.' };
  let current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: initial.revision,
    references: [],
    chatCharacterProfiles: [edited],
  });
  expect(current.chatCharacterProfiles).toEqual([edited]);
  const model = editableResource('content', bot) as ContentEditModel;
  model.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    model.package.nativeRisu.card,
    [
      { ...profiles[0], name: 'Renamed Mira', appearance: 'Newest default.' },
      { id: 'ari', name: 'Ari', appearance: 'Newest Ari.' },
    ]
  );
  bot = saveResource(store, { kind: 'content', id: bot.id, expectedRevision: bot.revision, model })
    .saved as Content;
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
  });
  expect(current.chatCharacterProfiles).toEqual([edited]);
  expect(current.characterProfiles).toContainEqual(edited);
  expect(current.characterProfiles.find((item) => item.name === 'Ari')?.appearance).toBe(
    'Newest Ari.'
  );
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
    chatCharacterProfiles: [],
  });
  expect(current.characterProfiles).toEqual(current.defaultCharacterProfiles);
  expect(current.characterProfiles[0]).toMatchObject({
    name: 'Renamed Mira',
    appearance: 'Newest default.',
  });
  const own = { id: 'own', name: 'New character', appearance: 'Gold hair.' };
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
    chatCharacterProfiles: [own],
  });
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
    chatCharacterProfiles: [],
  });
  expect(current.characterProfiles).toEqual(current.defaultCharacterProfiles);
  const alias = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
    chatCharacterProfiles: [{ id: 'alias', name: '  ＡＲＩ  ', appearance: 'Alias override.' }],
  });
  expect(alias.chatCharacterProfiles[0].id).toBe(current.defaultCharacterProfiles[1].id);
  expect(alias.characterProfiles).toHaveLength(2);
});

test('legacy effective saves filter unchanged defaults while explicit image overrides count effective references', () => {
  const store = databases.create();
  const input = fixtureBotInput();
  input.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    input.package.nativeRisu.card,
    profiles
  );
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Legacy', { botId: bot.id });
  const initial = illustrationReferences(store, chat.id);
  let current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: 0,
    references: [],
    characterProfiles: initial.characterProfiles,
  });
  expect(current.chatCharacterProfiles).toEqual([]);
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
    chatCharacterProfiles: initial.characterProfiles,
  });
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [],
  });
  expect(current.chatCharacterProfiles).toEqual(initial.characterProfiles);
  const asset = store.product.createAsset(chat.id, {
    title: 'Reference',
    mime: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
  });
  current = updateIllustrationReferences(store, chat.id, {
    expectedRevision: current.revision,
    references: [{ ref: asset.id, role: 'style' }],
    chatCharacterProfiles: [{ ...initial.characterProfiles[0], referenceRef: asset.id }],
  });
  expect(current.chatCharacterProfiles[0].referenceRef).toBe(asset.id);
  expect(frozenIllustrationReferences(store, chat.id)).toMatchObject([
    { ref: asset.id, role: 'character' },
  ]);
  const others = Array.from({ length: 8 }, (_, index) =>
    store.product.createAsset(chat.id, {
      title: `Other ${index}`,
      mime: 'image/png',
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      description: '',
      actor: '',
      outfit: '',
      location: '',
      allowedUse: 'both',
    })
  );
  expect(() =>
    updateIllustrationReferences(store, chat.id, {
      expectedRevision: current.revision,
      references: others.map((item) => ({ ref: item.id, role: 'style' })),
      chatCharacterProfiles: current.chatCharacterProfiles,
    })
  ).toThrow('삽화 참고 이미지는 최대 8개까지 사용할 수 있어요.');

  expect(() =>
    updateIllustrationReferences(store, chat.id, {
      expectedRevision: current.revision,
      references: [],
      chatCharacterProfiles: [{ ...initial.characterProfiles[0], referenceRef: 'missing' }],
    })
  ).toThrow('이 채팅에서 사용할 수 없는 인물 참고 이미지예요.');
});

test('helper edits only the requested inherited identity and reports its stable ID', () => {
  const store = databases.create();
  const input = fixtureBotInput();
  input.package.nativeRisu.card = withIllustrationAppearanceProfiles(
    input.package.nativeRisu.card,
    [...profiles, { id: 'ari', name: 'Ari', appearance: 'Brown hair.' }]
  );
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Helper', { botId: bot.id });
  const initial = illustrationReferences(store, chat.id);
  const saved = saveIllustrationProfiles(store, chat.id, {
    expectedRevision: 0,
    profiles: [{ name: 'mira', appearance: 'Blue eyes.' }],
  });
  expect(saved.profiles[0].profileId).toBe(initial.defaultCharacterProfiles[0].id);
  expect(illustrationReferences(store, chat.id).chatCharacterProfiles).toEqual([
    { id: saved.profiles[0].profileId, name: 'mira', appearance: 'Blue eyes.' },
  ]);
  saveIllustrationProfiles(store, chat.id, {
    expectedRevision: saved.revision,
    profiles: [{ profileId: saved.profiles[0].profileId, appearance: 'Silver eyes.' }],
  });
  expect(illustrationReferences(store, chat.id).chatCharacterProfiles).toEqual([
    { id: saved.profiles[0].profileId, name: 'mira', appearance: 'Silver eyes.' },
  ]);
});
