import { themeCatalog, deleteTheme } from './themes.js';
import { THEME_COLOR_KEYS, THEME_SLOTS, BUILTIN_THEMES, themeDefinition } from '../core/themes.js';
import type { ProviderTool } from '../core/transport.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { editableResource } from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { readResource, saveResource, undoResource } from './resource-service.js';
import { deleteLibraryItem } from './library-deletion.js';
import { record, number, text, HttpError } from './request-validation.js';

const kind = { type: 'string', enum: ['content', 'prompt-preset', 'prompt-workspace', 'theme'] };
const string = { type: 'string' };
const revision = { type: 'integer', minimum: 1 };
export const RESOURCE_TOOLS: ProviderTool[] = [
  {
    name: 'theme.list',
    description:
      'List saved and built-in presentation themes with current selections. Themes do not affect model inputs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.guide',
    description:
      'Read the theme authoring contract and example before editing. Save with resource.save kind=theme; selecting it is separate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resource.read',
    description:
      'Read any bot/persona/module/preset or current prompt workspace. No selected editor is required. Return includes the current revision used by save.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.save',
    description:
      'Create or save an application resource directly. Use the latest revision when editing an existing ID; omit id/revision to create. There is no server draft or separate apply step. For content, preserve its native Risu source and edit that source rather than only its projection. Bot translation guides live only at model.package.nativeRisu.card.extensions.uimori.translationGuide: {instructions: string, terms: [{source: string, target: string, note?: string}]}. Preserve other extensions. If the bot is a standalone module with an empty native card, edit nativeRisu.module.extensions.uimori.translationGuide instead; do not create a card. Never merge guides from mounted modules. These are translation metadata, not story facts, chat overrides, or regex replacements. A draft/proposal request does not authorize saving.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string, expectedRevision: revision, model: { type: 'object' } },
      required: ['kind', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.undo',
    description: 'Restore the immediately previous saved resource using its current revision.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: string, expectedRevision: revision },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.delete',
    description:
      'Remove a bot/persona/module or preset from the library using its current revision.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['content', 'prompt-preset', 'theme'] },
        id: string,
        expectedRevision: revision,
      },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'image.update-metadata',
    description:
      'Edit an image display name and description used for JEV image selection. Does not change image bytes, IDs, or native script reference names. Read the owning content first.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: string,
        imageId: string,
        expectedRevision: revision,
        title: string,
        description: string,
      },
      required: ['contentId', 'imageId', 'expectedRevision', 'title', 'description'],
      additionalProperties: false,
    },
  },
];
const summary = (result: ReturnType<typeof saveResource>) => ({
  created: result.created,
  revision: result.saved.revision,
  ...('id' in result.saved
    ? { id: result.saved.id, title: result.saved.title }
    : { id: 'current' }),
});

export function invokeResourceTool(
  store: Store,
  name: string,
  args: Record<string, unknown>
): unknown {
  if (name === 'theme.list') return themeCatalog(store);
  if (name === 'theme.guide')
    return {
      colors: THEME_COLOR_KEYS,
      slots: THEME_SLOTS,
      example: themeDefinition(BUILTIN_THEMES[1]),
      contract:
        'Save with resource.save kind=theme. title required. colors.light/dark map the documented names without -- to hex colors. appCss styles the app; messageCss is a low-priority layer in each Risu message ShadowRoot. templateHtml needs exactly one native slot for each name: request, heading, body, actions; templateCss styles that layout ShadowRoot. Empty HTML uses the default. No JavaScript or CBS in themes. Preserve reading preferences and bot HTML. Use responsive CSS. Stable data-uimori-part hooks: scene, scene-frame, request, heading, body, actions, composer-input. External images remain URL references; data URLs travel with JSON. Saving does not select. Full guide: docs/THEME-AUTHORING.md.',
    };
  if (name === 'image.update-metadata') {
    const id = text(args.contentId, 'content ID', 100);
    const content = readResource(store, 'content', id) as Content;
    const imageId = text(args.imageId, 'image ID', 200);
    if (!content.package.images?.some((image) => image.id === imageId))
      throw new HttpError(404, '이미지를 찾을 수 없어요.');
    const title = text(args.title, 'image title', 200);
    const description = text(args.description, 'image description', 2000, true);
    return summary(
      saveResource(store, {
        kind: 'content',
        id,
        expectedRevision: number(args.expectedRevision, 'revision'),
        model: {
          ...editableResource('content', content),
          package: {
            ...content.package,
            images: content.package.images.map((image) =>
              image.id === imageId ? { ...image, title, description } : image
            ),
          },
        } as ResourceModel,
      })
    );
  }
  if (!['content', 'prompt-preset', 'prompt-workspace', 'theme'].includes(String(args.kind)))
    throw new HttpError(400, '자료 종류를 확인해 주세요.');
  const kind = args.kind as ResourceKind;
  const id = args.id == null ? null : text(args.id, 'resource ID', 100);
  if (name === 'resource.read') return readResource(store, kind, id ?? 'current');
  const expectedRevision =
    args.expectedRevision === undefined ? undefined : number(args.expectedRevision, 'revision');
  if (name === 'resource.save')
    return summary(
      saveResource(store, {
        kind,
        id,
        expectedRevision,
        model: record(args.model) as ResourceModel,
      })
    );
  if (!id || expectedRevision === undefined)
    throw new HttpError(400, '자료 ID와 개정 번호가 필요해요.');
  if (name === 'resource.undo') return summary(undoResource(store, kind, id, expectedRevision));
  if (name === 'resource.delete' && kind === 'theme')
    return deleteTheme(store, id, expectedRevision);
  if (name === 'resource.delete' && (kind === 'content' || kind === 'prompt-preset'))
    return deleteLibraryItem(store, kind, id, { expectedRevision });
  throw new HttpError(400, '지원하지 않는 자료 작업이에요.');
}
