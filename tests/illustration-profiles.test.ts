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
import { saveResource } from '../server/resource-service.js';
import { illustrationReferences, updateIllustrationReferences } from '../server/illustrations.js';
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
  expect(illustrationReferences(store, chat.id).characterProfiles).toEqual(overrides);
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
