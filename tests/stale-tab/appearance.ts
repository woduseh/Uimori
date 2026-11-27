import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allEndpoints } from '#contracts';
import { emptyTheme } from '../../core/themes.js';
import { deleteFont, registerFont } from '../../server/fonts.js';
import { deletePalette, deleteTheme, savePalette, saveTheme } from '../../server/themes.js';
import {
  bot,
  conflict,
  deleted,
  deletedChat,
  domainCases,
  read,
  removed,
  scene,
  store,
} from './harness.js';

const fontReason =
  'Fonts are not library items: a removed font answers the catalogued FONT_NOT_FOUND, whose text asks for a reload of the font list.';
const theme = () => saveTheme(store(), emptyTheme('Stale tab theme'));
const paletteModel = {
  title: 'Stale tab palette',
  description: '',
  colors: { light: {}, dark: {} },
};
const palette = () => savePalette(store(), paletteModel);
const fontBytes = readFileSync(join(import.meta.dirname, '../fixtures/appearance-synthetic.ttf'));
const font = (padding: number) =>
  registerFont(store(), {
    title: 'Stale tab font',
    bytes: Buffer.concat([fontBytes, Buffer.alloc(padding)]),
  });
const themeRevision = async () =>
  (await read<{ preferences: { revision: number } }>(allEndpoints.appearance.readThemes))
    .preferences.revision;

export const appearanceCases = domainCases('appearance', {
  selectFonts: {
    cases: [
      {
        when: 'a font another tab removed',
        arrange: async () => {
          const live = font(1);
          const gone = font(2);
          deleteFont(store(), gone.id);
          const { revision } = await read<{ revision: number }>(
            allEndpoints.appearance.readFontPreferences
          );
          const choice = { expectedRevision: revision, readerFontId: null };
          return {
            input: { ...choice, appFontId: gone.id },
            control: { ...choice, appFontId: live.id },
          };
        },
        answer: { status: 404, code: 'FONT_NOT_FOUND' },
        reason: fontReason,
      },
    ],
  },
  deleteFont: {
    cases: [
      {
        when: 'a font another tab removed',
        arrange: () => {
          const gone = font(3);
          deleteFont(store(), gone.id);
          return { input: { id: gone.id } };
        },
        answer: { status: 404, code: 'FONT_NOT_FOUND' },
        reason: fontReason,
      },
    ],
  },
  selectTheme: {
    cases: [
      {
        when: 'a theme another tab deleted',
        arrange: async () => {
          const live = theme();
          const gone = theme();
          deleteTheme(store(), gone.id, gone.revision);
          const choice = { dimension: 'theme', scope: 'global' };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, themeId: gone.id, expectedRevision },
            control: { ...choice, themeId: live.id, expectedRevision },
          };
        },
        answer: deleted,
      },
      {
        when: 'a palette another tab deleted',
        arrange: async () => {
          const live = palette();
          const gone = palette();
          deletePalette(store(), gone.id, gone.revision);
          const choice = { dimension: 'palette', scope: 'global' };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, paletteId: gone.id, expectedRevision },
            control: { ...choice, paletteId: live.id, expectedRevision },
          };
        },
        answer: deleted,
      },
      {
        when: 'a bot scope another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const choice = { dimension: 'theme', scope: 'bot', themeId: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: gone.id, expectedRevision },
            control: { ...choice, targetId: live.id, expectedRevision },
          };
        },
        answer: conflict,
      },
      {
        when: 'a chat scope another tab deleted',
        arrange: async () => {
          const live = scene('Stale tab appearance chat');
          const choice = { dimension: 'theme', scope: 'chat', themeId: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: deletedChat().chatId, expectedRevision },
            control: { ...choice, targetId: live.chat.id, expectedRevision },
          };
        },
        answer: conflict,
      },
    ],
  },
  selectThemeBackground: {
    cases: [
      {
        when: 'a bot scope another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const choice = { scope: 'bot', background: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: gone.id, expectedRevision },
            control: { ...choice, targetId: live.id, expectedRevision },
          };
        },
        answer: conflict,
      },
      {
        when: 'a chat scope another tab deleted',
        arrange: async () => {
          const live = scene('Stale tab background chat');
          const choice = { scope: 'chat', background: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: deletedChat().chatId, expectedRevision },
            control: { ...choice, targetId: live.chat.id, expectedRevision },
          };
        },
        answer: conflict,
      },
    ],
  },
  deleteTheme: {
    cases: [
      {
        when: 'a theme another tab deleted',
        arrange: () => {
          const item = theme();
          deleteTheme(store(), item.id, item.revision);
          return { input: { id: item.id, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  updatePalette: {
    cases: [
      {
        when: 'a palette another tab deleted',
        arrange: () => {
          const item = palette();
          deletePalette(store(), item.id, item.revision);
          return { input: { id: item.id, model: {}, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  deletePalette: {
    cases: [
      {
        when: 'a palette another tab deleted',
        arrange: () => {
          const item = palette();
          deletePalette(store(), item.id, item.revision);
          return { input: { id: item.id, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
});
