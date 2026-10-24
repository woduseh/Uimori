import type { Json, ProviderTool } from '../core/transport.js';
import type { Store } from './store.js';
import { fields, record, text, number, HttpError } from './request-validation.js';
import { fontCatalog, registerFont, selectFonts, deleteFont, downloadFont } from './fonts.js';
import {
  paletteCatalog,
  savePalette,
  deletePalette,
  selectTheme,
  themePreferences,
} from './themes.js';

const string: Json = { type: 'string' };
const revision: Json = { type: 'integer', minimum: 0 };
const nullable: Json = { type: ['string', 'null'] };
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
    'List registered fonts and current global app/reader selections with their revision.'
  ),
  tool(
    'font.register',
    'Download and register a web-embeddable font from a public HTTPS font-file URL. The URL is used for download only, not saved as font metadata. Registration does not apply it. A preview alone is not a creation request.',
    { title: string, url: string },
    ['title', 'url']
  ),
  tool(
    'font.select',
    'Apply explicitly requested global app and reader fonts with the revision from font.list. Both IDs are required; preserve the other current choice. Null restores the default.',
    { expectedRevision: revision, appFontId: nullable, readerFontId: nullable },
    ['expectedRevision', 'appFontId', 'readerFontId']
  ),
  tool(
    'font.delete',
    'Delete an explicitly requested registered font. Read current selections first.',
    { id: string },
    ['id']
  ),
  tool(
    'palette.list',
    'List built-in and saved light/dark palettes and scoped selections with preference revision.'
  ),
  tool(
    'palette.save',
    'Create or update a standalone palette. model contains title, description and colors.light/dark using theme.guide color keys. Saving does not apply it; preview/proposal requests remain unsaved.',
    { id: string, expectedRevision: revision, model: { type: 'object' } },
    ['model']
  ),
  tool(
    'palette.delete',
    'Delete an explicitly requested saved palette using its current revision.',
    { id: string, expectedRevision: revision },
    ['id', 'expectedRevision']
  ),
  tool(
    'theme.select',
    'Apply an explicitly requested theme or palette independently. Read theme.list/palette.list for preference revision. Null inherits for bot/chat or restores the global default. Creation alone does not select.',
    {
      scope: { type: 'string', enum: ['global', 'bot', 'chat'] },
      targetId: string,
      dimension: { type: 'string', enum: ['theme', 'palette'] },
      themeId: nullable,
      paletteId: nullable,
      expectedRevision: revision,
    },
    ['scope', 'dimension', 'expectedRevision']
  ),
];
export const presentationReadOnly = (name: string) =>
  name === 'font.list' || name === 'palette.list';

/** Network preparation precedes the synchronous receipt transaction. */
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
