import type { Json, ProviderTool } from '../core/transport.js';
import type { HelperTask } from '../core/helper.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { fields, record, text, number, HttpError } from './request-validation.js';
import { fontCatalog, registerFont, selectFonts, deleteFont, downloadFont } from './fonts.js';
import {
  paletteCatalog,
  savePalette,
  deletePalette,
  readTheme,
  selectTheme,
  themePreferences,
} from './themes.js';

const string: Json = { type: 'string' };
const revision: Json = { type: 'integer', minimum: 0 };
const nullable: Json = { type: ['string', 'null'] };
const described = (value: Json, description: string): Json => ({
  ...(value as Record<string, Json>),
  description,
});
function tool(
  name: string,
  description: string,
  properties: Record<string, Json> = {},
  required: string[] = []
): ProviderTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}
export const HELPER_PRESENTATION_TOOLS: ProviderTool[] = [
  tool(
    'font.list',
    'List the registered fonts and which font is currently selected for the app and for the reader, with the revision that font.select needs.'
  ),
  tool(
    'font.register',
    'Add a font to the app by downloading a web-embeddable font file from a public HTTPS URL. The URL is used once for the download and is not stored with the font. Registering a font makes it available; applying it is a separate step through font.select.',
    {
      title: described(string, 'Display name of the font.'),
      url: described(string, 'Public HTTPS URL of the font file itself, not of a web page.'),
    },
    ['title', 'url']
  ),
  tool(
    'font.select',
    'Choose the font used across the app and the font used in the reader. Both values are sent every time: repeat the current id from font.list for the one that should stay as it is, and pass null to return one to the default font.',
    {
      expectedRevision: described(revision, 'Revision from font.list.'),
      appFontId: described(nullable, 'Font id for the app, or null for the default.'),
      readerFontId: described(nullable, 'Font id for the reader, or null for the default.'),
    },
    ['expectedRevision', 'appFontId', 'readerFontId']
  ),
  tool(
    'font.delete',
    'Remove a registered font from the app. The helper cannot restore it; it would have to be registered again from its file. Check font.list first to see whether the font is currently selected.',
    { id: described(string, 'Font id, from font.list.') },
    ['id']
  ),
  tool(
    'palette.list',
    'List the built-in and saved color palettes with their light and dark colors, where each is selected (global, bot or chat) and the preference revision.'
  ),
  tool(
    'palette.save',
    'Create a standalone color palette or update a saved one. The model holds title, description and colors.light and colors.dark, using the color keys described in theme.guide. Omit id and expectedRevision to create; pass both to update. Saving a palette does not apply it: that is theme.select with dimension=palette.',
    {
      id: described(string, 'Id of the palette to update. Omit to create.'),
      expectedRevision: described(revision, 'Current revision of the palette to update.'),
      model: {
        type: 'object',
        description: 'The complete palette: title, description and colors.light / colors.dark.',
      },
    },
    ['model']
  ),
  tool(
    'palette.delete',
    'Delete a saved color palette. Built-in palettes cannot be deleted, and the helper cannot restore a deleted palette.',
    {
      id: described(string, 'Palette id, from palette.list.'),
      expectedRevision: described(revision, 'Current revision of the palette.'),
    },
    ['id', 'expectedRevision']
  ),
  tool(
    'theme.select',
    'Apply a theme, a palette or a Story UI theme. The three dimensions are chosen independently. dimension=theme or palette applies at scope global, bot or chat; passing null makes a bot or chat inherit again, or returns the global scope to the default. dimension=storyUi sets the default Story UI theme of one bot (scope=bot, targetId=the bot id), using a saved theme that has storyUi, or null to clear it; a Story UI choice for a single chat is settings.update chat.storyUiStyle instead. Take expectedRevision from theme.list.',
    {
      scope: {
        type: 'string',
        enum: ['global', 'bot', 'chat'],
        description: 'Where the choice applies.',
      },
      targetId: described(string, 'The bot id or chat id for scope bot or chat. Omit for global.'),
      dimension: {
        type: 'string',
        enum: ['theme', 'palette', 'storyUi'],
        description: 'What is being chosen.',
      },
      themeId: described(
        nullable,
        'For dimension theme or storyUi: the saved theme id, or null to inherit or clear.'
      ),
      paletteId: described(
        nullable,
        'For dimension palette: the palette id, or null to inherit or clear.'
      ),
      expectedRevision: described(revision, 'Preference revision from theme.list.'),
    },
    ['scope', 'dimension', 'expectedRevision']
  ),
];
export const presentationReadOnly = (name: string) =>
  name === 'font.list' || name === 'palette.list';

export function applyHelperPresentationMutation(
  store: Store,
  workspace: HelperWorkspace,
  task: Pick<HelperTask, 'id' | 'conversationId'>,
  receiptId: string,
  name: string,
  args: Record<string, unknown>,
  bytes?: Uint8Array
): unknown {
  if (name !== 'theme.select' || args.dimension !== 'storyUi')
    return invokePresentationTool(store, name, args, bytes);

  const botId = text(args.targetId, 'bot ID', 100);
  const before = themePreferences(store).botStoryUiThemes?.[botId] ?? null;
  const result = selectTheme(store, args);
  const after = result.botStoryUiThemes?.[botId] ?? null;
  let beforeLabel: string | null = null;
  if (before) {
    try {
      beforeLabel = readTheme(store, before).title;
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
    }
  }
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: name,
    requestedTargets: 1,
    targets:
      before === after
        ? []
        : [
            {
              kind: 'settings',
              id: botId,
              title: store.product.get<Content>('content', botId).title,
              revision: result.revision,
              setting: 'bot.storyUiTheme',
              before,
              after,
              beforeLabel,
              afterLabel: after ? readTheme(store, after).title : null,
            },
          ],
  });
  return result;
}

export async function preparePresentationTool(
  name: string,
  value: unknown,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  if (name !== 'font.register') return undefined;
  const args = record(value);
  fields(args, ['title', 'url']);
  text(args.title, 'font title', 200);
  return downloadFont(
    text(args.url, 'font URL', 4000),
    AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  );
}
export function invokePresentationTool(
  store: Store,
  name: string,
  value: unknown,
  bytes?: Uint8Array
): unknown {
  const args = record(value);
  if (name === 'font.list') {
    fields(args, []);
    return fontCatalog(store);
  }
  if (name === 'palette.list') {
    fields(args, []);
    return { palettes: paletteCatalog(store), preferences: themePreferences(store) };
  }
  if (name === 'font.register') {
    fields(args, ['title', 'url']);
    if (!bytes) throw new HttpError(400, 'FONT_DOWNLOAD_REQUIRED');
    text(args.url, 'font URL', 4000);
    return registerFont(store, {
      title: text(args.title, 'font title', 200),
      bytes,
    });
  }
  if (name === 'font.select') {
    fields(args, ['expectedRevision', 'appFontId', 'readerFontId']);
    return selectFonts(store, args);
  }
  if (name === 'font.delete') {
    fields(args, ['id']);
    return deleteFont(store, text(args.id, 'font ID', 100));
  }
  if (name === 'palette.save') {
    fields(args, ['id', 'expectedRevision', 'model']);
    return savePalette(
      store,
      args.model,
      args.id === undefined ? undefined : text(args.id, 'palette ID', 100),
      args.expectedRevision === undefined ? undefined : number(args.expectedRevision, 'revision', 0)
    );
  }
  if (name === 'palette.delete') {
    fields(args, ['id', 'expectedRevision']);
    return deletePalette(
      store,
      text(args.id, 'palette ID', 100),
      number(args.expectedRevision, 'revision', 1)
    );
  }
  if (name === 'theme.select') return selectTheme(store, args);
  throw new HttpError(400, 'UNKNOWN_PRESENTATION_TOOL');
}
