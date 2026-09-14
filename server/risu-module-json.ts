import { RISU_IMPORT_MAX_ASSETS, RISU_IMPORT_MAX_LORE_ENTRIES } from '../core/risu-import.js';
import { HttpError, record, text } from './request-validation.js';

/** One lore mapping for extracted projects and the canonical lore in CharX containers. */
export function moduleLoreEntries(lorebook: unknown) {
  if (!Array.isArray(lorebook) || lorebook.length > RISU_IMPORT_MAX_LORE_ENTRIES)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  return lorebook.map((raw) => {
    const entry = record(raw);
    const known = [
      'id',
      'key',
      'secondkey',
      'comment',
      'content',
      'mode',
      'insertorder',
      'alwaysActive',
      'selective',
      'useRegex',
      'folder',
      'enabled',
      'bookVersion',
    ];
    const extra = Object.fromEntries(
      Object.entries(entry).filter(
        ([key, item]) => !known.includes(key) && item !== undefined && item !== false && item !== ''
      )
    );
    return {
      name: typeof entry.comment === 'string' ? entry.comment : '',
      content: text(entry.content ?? '', 'lore content', 1_000_000, true),
      keys:
        typeof entry.key === 'string'
          ? entry.key
              .split(',')
              .map((key: string) => key.trim())
              .filter(Boolean)
          : [],
      // Module lore is already in Risu's database shape, so its activation fields map onto the card
      // fields the lorebook conversion reads rather than into an extension bag nothing reads back.
      secondary_keys:
        typeof entry.secondkey === 'string'
          ? entry.secondkey
              .split(',')
              .map((key: string) => key.trim())
              .filter(Boolean)
          : [],
      constant: entry.alwaysActive === true,
      enabled: entry.enabled !== false && entry.mode !== 'folder',
      selective: entry.selective === true,
      use_regex: entry.useRegex === true,
      insertion_order: entry.insertorder,
      ...(typeof entry.mode === 'string' ? { mode: entry.mode } : {}),
      ...(typeof entry.folder === 'string' ? { folder: entry.folder } : {}),
      ...(Object.keys(extra).length ? { extensions: extra } : {}),
    };
  });
}

/** Interpret the documented JSON envelope, independently of its binary container codec. */
export function moduleJsonDocument(
  value: unknown,
  members = new Map<string, () => Buffer>(),
  projectAssets: ((() => Buffer) | undefined)[] = []
): Record<string, unknown> {
  const envelope = record(value);
  if (envelope.type !== 'risuModule') throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const module = record(envelope.module);
  const name = text(module.name, 'module name', 200);
  const description = text(module.description ?? '', 'module description', 100_000, true);
  const entries = moduleLoreEntries(module.lorebook ?? []);
  const assets: { name: string; uri: string; type: string }[] = [];
  const addAsset = (name: unknown, value: unknown, type: string, projectAsset?: () => Buffer) => {
    const title = typeof name === 'string' && name ? name : `이미지 ${assets.length + 1}`;
    const raw = typeof value === 'string' ? value : '';
    const data = raw.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
    const uri = data || projectAsset ? `embeded://module-assets/${assets.length}` : raw;
    if (data || projectAsset) {
      const bytes = projectAsset ? projectAsset() : Buffer.from(data![1], 'base64');
      if (!projectAsset && bytes.toString('base64') !== data![1])
        throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
      members.set(uri.slice('embeded://'.length), () => bytes);
    }
    assets.push({ name: title, uri, type });
  };
  if (module.assets !== undefined) {
    if (!Array.isArray(module.assets) || module.assets.length > RISU_IMPORT_MAX_ASSETS)
      throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
    for (const [index, asset] of module.assets.entries()) {
      if (!Array.isArray(asset) || asset.length < 2)
        throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
      addAsset(asset[0], asset[1], 'other', projectAssets[index]);
    }
  }
  if (module.icon) addAsset('main', module.icon, 'icon');
  const metadata = Object.fromEntries(
    Object.entries(module).filter(
      ([key]) =>
        !['id', 'name', 'description', 'lorebook', 'regex', 'trigger', 'assets', 'icon'].includes(
          key
        )
    )
  );
  return {
    name,
    description: '',
    creator_notes: description,
    character_book: { entries },
    assets,
    extensions: {
      risuai: { ...metadata, customScripts: module.regex, triggerscript: module.trigger },
    },
  };
}
