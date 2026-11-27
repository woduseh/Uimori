import { resourceEditorOperations } from '#contracts/operations';
import { parseInput } from './endpoint.js';
import { illustrationPresetCatalog, deleteIllustrationPreset } from './illustration-presets.js';
import { emptyIllustrationPreset } from '../core/illustration-presets.js';
import { themeCatalog, deleteTheme } from './themes.js';
import { THEME_COLOR_KEYS, THEME_SLOTS, BUILTIN_THEMES, themeDefinition } from '../core/themes.js';
import { storyUiStyles } from '../core/story-ui-style.js';
import type { ProviderTool } from '../core/transport.js';
import type { ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { editableResource } from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import type { Store } from './store.js';
import { cloneResource, readResource, saveResource, undoResource } from './resource-service.js';
import { deleteLibraryItem } from './library-deletion.js';
import { HelperToolError } from './app-errors.js';
import { number, text } from './request-validation.js';
import { patchHelperResource, readHelperResource } from './helper-resource-editing.js';
import { patchHelperResources } from './helper-resource-batch.js';
import { readHelperResources, validateHelperPreset } from './helper-resource-inspection.js';

const kind = {
  type: 'string',
  enum: ['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'],
  description:
    'content is a saved bot, persona or module; prompt-preset a prompt preset; prompt-workspace the global prompt workspace; theme a theme; illustration-preset an illustration preset.',
};
const string = { type: 'string' };
const resourceId = { type: 'string', description: 'Id of the saved resource.' };
const revision = { type: 'integer', minimum: 1 };
const expectedRevision = {
  ...revision,
  description: 'Current revision of the resource, from a read or the result of an earlier save.',
};
const readSelection = {
  kind,
  id: resourceId,
  version: {
    type: 'string',
    enum: ['current', 'previous'],
    description:
      'current (default) or previous. previous reads the single version kept for undo: it returns revision:null with currentRevision, has no editable targets, and is replaced by the next save.',
  },
  path: {
    type: 'string',
    description:
      'JSON Pointer of the field, object or array to read, taken from readyPaths or an earlier result. Omit for the overview.',
  },
  fields: {
    type: 'array',
    items: string,
    maxItems: 50,
    description: 'Names of the object fields to return at path, instead of the whole object.',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    description: 'Entry offset in an array or object page. Pass the previous nextOffset.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 50,
    description: 'Maximum array or object entries per page.',
  },
  textOffset: {
    type: 'integer',
    minimum: 0,
    description:
      'Start position inside a long string, in UTF-16 code units. Pass the previous nextOffset.',
  },
  textLimit: {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    description:
      'Maximum string length to return, in UTF-16 code units. Omit to read up to about 2000 tokens.',
  },
  includeBodies: {
    type: 'boolean',
    description:
      "Only with the promptTemplate array path: include each block's text, innerFormat and defaultText. Bodies that do not fit are listed in omittedBodyPaths.",
  },
};
const patchProperties = {
  kind: {
    type: 'string',
    enum: ['content', 'prompt-preset', 'theme'],
    description:
      'content is a saved bot, persona or module; prompt-preset a prompt preset; theme a theme with Story UI fields.',
  },
  id: resourceId,
  expectedRevision,
  changes: {
    type: 'array',
    minItems: 1,
    description: 'Changes applied in order and saved together.',
    items: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['set', 'replaceText', 'insert', 'remove', 'move'],
          description:
            'set replaces a field value; replaceText replaces one exact excerpt inside a string; insert and remove act on an indexed array position; move reorders promptTemplate blocks.',
        },
        path: {
          type: 'string',
          description:
            'JSON Pointer of the field or indexed array position. With target it is relative to that item, such as /text, or an empty string for the item itself.',
        },
        target: {
          type: 'string',
          description:
            'Anchor of an existing array item, copied from resource.read. It keeps pointing at that item across earlier inserts, removals and moves in the same call. Accepted by set, replaceText and remove.',
        },
        from: {
          type: 'string',
          description:
            'move only: full indexed path of the block to move. path is then the destination index, counted after the block is removed.',
        },
        value: { description: 'set and insert: the new JSON value.' },
        oldText: {
          type: 'string',
          description:
            'replaceText: the exact excerpt to replace. It must occur exactly once. When no exact match exists, a match that differs only in CRLF/LF line endings is used and reported.',
        },
        newText: { type: 'string', description: 'replaceText: the replacement text.' },
      },
      required: ['path', 'op'],
      additionalProperties: false,
    },
  },
};
type ResourceMutationTarget = { kind: ResourceKind; id: string | null };
type ResourceToolDefinition = ProviderTool &
  (
    | { effect: 'read' }
    | {
        effect: 'mutation';
        target: (args: Record<string, unknown>) => ResourceMutationTarget | null;
        targets?: (args: Record<string, unknown>) => ResourceMutationTarget[];
      }
  );
function resourceTarget(args: Record<string, unknown>): ResourceMutationTarget | null {
  if (!kind.enum.includes(String(args.kind))) return null;
  if (args.id != null && typeof args.id !== 'string') return null;
  return {
    kind: args.kind as ResourceKind,
    id: args.kind === 'prompt-workspace' ? 'current' : ((args.id as string | null) ?? null),
  };
}
const resourceTools: ResourceToolDefinition[] = [
  {
    name: 'illustration-preset.list',
    effect: 'read',
    description:
      'List the saved illustration presets with their names, revisions and current selections. Read the recipe of one preset with resource.read kind=illustration-preset.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'illustration-preset.guide',
    effect: 'read',
    description:
      'Read the authoring guide for portable illustration presets: the fields a preset recipe contains and how they are used. Read it before writing or editing a preset with resource.save. Saving a preset and selecting it are separate steps, and this operation does not generate images.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.list',
    effect: 'read',
    description:
      'List the saved themes and palettes with compact metadata, the current selections (including the per-bot Story UI themes in botStoryUiThemes) and the preference revision needed by theme.select. A theme that has storyUi.baseStyle can style the Story UI. Read the CSS or colors of one theme with resource.read kind=theme, and palette colors with palette.list.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'theme.guide',
    effect: 'read',
    description:
      "Read the authoring guide and examples for Story UI themes and Reader themes. Read it before creating or editing a theme or palette. To design a Story UI theme for a bot, also read that bot's authored content (in a chat, source.writing.packages names the owning bot with role=bot), then save with resource.save kind=theme. Applying a theme is a separate step through theme.select: dimension=storyUi for the bot, or settings.update chat.storyUiStyle for one chat, only when the user asks for it.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resource.read',
    effect: 'read',
    description:
      "Read a saved library resource in typed, bounded pieces: a bot, persona or module (kind=content, the character card with its description, first message, lorebook and other fields), a prompt preset (prompt template blocks, toggles, variables and saved values), the global prompt workspace, a theme or an illustration preset. Call it with kind and id alone for a compact overview with source, regions and readyPaths (for content, the card or module region lists each field with its text length or item count), then follow a returned JSON Pointer path into the field, array or text you need. Use it when you need exact typed values, array structure or the current revision before resource.patch. To find text by its content use data.search, and for the same question across several resources use resource.readMany. Long strings page with textOffset/textLimit and nextOffset, and arrays and objects page with offset/limit. Use path for one read or paths for 1-16 reads of the same resource, with nextIndex marking paths that were not returned. Editable array entries carry a target anchor for resource.patch at this revision. Prompt template pages list each block's id, name, type, roles and text lengths without the bodies unless includeBodies is set. Nothing is evaluated: CBS and scripts are returned as authored. The whole response stays within about 12000 tokens, and a page never means the omitted part was read. Small values keep their JSON types and a missing optional field is reported with exists:false. The shared illustration appearance defaults of a bot or persona are at source.appearanceProfilesPath.",
    inputSchema: {
      type: 'object',
      properties: {
        ...readSelection,
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: { type: 'string', maxLength: 1024 },
          description:
            'Several JSON Pointer paths of the same resource and revision, read in one call. Do not combine with path. The field and paging options apply to every path; continue with paths.slice(nextIndex).',
        },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.readMany',
    effect: 'read',
    description:
      'Read 1-16 selections across different library resources in one call, with typed values, when comparing or collecting the same fields from several bots, personas, modules or presets. Each selection takes the resource.read arguments except paths, and returns its own result or error. The selections share one response budget of about 12000 tokens: when nextIndex is not null, call again with items.slice(nextIndex), and follow the nextOffset of a result for the rest of its text or array. For text that data.search already located, data.read with those refs is shorter.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          description: 'One selection per resource and path.',
          items: {
            type: 'object',
            properties: readSelection,
            required: ['kind', 'id'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'preset.validate',
    effect: 'read',
    description:
      'Check a saved prompt preset for toggle problems without running it or changing anything. It reports toggle declaration and value diagnostics, and option value or label changes against the previous save when one is retained. The check is advisory and partial: it does not parse full CBS syntax, analyse conditional branches or know externally supplied variables, so a clean report does not prove that every branch is valid. Page the diagnostics with offset and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the saved prompt preset.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Diagnostic offset. Pass the previous nextOffset.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum diagnostics per page.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.patch',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Edit fields of a saved bot, persona or module (kind=content), a prompt preset or the Story UI of a theme. This is the normal way to change a character description, first message, lorebook entry, prompt template block, toggle or display title without resending the rest of the resource. Take expectedRevision and paths from resource.read, or use the editTarget of a data.search or data.read result for a replaceText change. Changes apply in order, so a later index refers to the array as earlier changes left it; to address an existing array item regardless of earlier changes, pass its target anchor with a relative path. All changes validate and save together as one save that can be undone once; if any change fails nothing is saved and the result identifies the failing change. set also writes whole structured values: the complete {instructions,terms} translation guide at source.translationGuidePath, the full array of {id,name,appearance,referenceImageId?} at source.appearanceProfilesPath for shared bot or persona appearance defaults, and the complete {baseStyle,css} at /storyUi of a theme (its /storyUi/baseStyle and /storyUi/css fields can also be edited individually). insert and remove work on indexed lorebook entries, translation guide terms and promptTemplate blocks. The display /title and the native name of a preset are separate fields. Editing toggle definitions resets or removes saved values that became invalid and lists every affected key in resetKeys; reconciledValues.removedKeys and reconciledValues.resetKeys tell the removed values from the reset ones. Identity, asset and derived projection fields are read only.',
    inputSchema: {
      type: 'object',
      properties: patchProperties,
      required: ['kind', 'id', 'expectedRevision', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.patchMany',
    effect: 'mutation',
    target: () => null,
    targets: (args) =>
      Array.isArray(args.items)
        ? args.items.flatMap((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
            const target = resourceTarget(item as Record<string, unknown>);
            return target ? [target] : [];
          })
        : [],
    description:
      'Apply resource.patch changes to 1-16 different library resources as one atomic save, for example the same correction across several presets or bots. Each item is a complete resource.patch request with its own current expectedRevision, and a resource may appear only once. Either every item saves or nothing does. The result lists each saved resource, and the changed resources can be undone together from the helper screen. It applies the changes once; it does not keep the resources synchronized afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          description: 'One resource.patch request per resource.',
          items: {
            type: 'object',
            properties: patchProperties,
            required: ['kind', 'id', 'expectedRevision', 'changes'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.clone',
    effect: 'mutation',
    target: (args) =>
      args.kind === 'content' || args.kind === 'prompt-preset'
        ? { kind: args.kind, id: null }
        : null,
    description:
      'Create an independent copy (duplicate) of a saved bot, persona, module or prompt preset without reading or resending its contents. Returns the id and revision of the new copy and of the source; edit the copy by patching the returned id. A preset copy keeps its prompt blocks, controls, defaults and current values. The copy does not include unsaved editor input, saved option combinations, folder placement, active selections, chat history or undo history, and a content copy starts with no relatedIds. The source is never changed. The global prompt workspace cannot be cloned.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['content', 'prompt-preset'],
          description: 'content is a saved bot, persona or module; prompt-preset a prompt preset.',
        },
        sourceId: { type: 'string', description: 'Id of the resource to copy.' },
        expectedSourceRevision: {
          ...revision,
          description: 'Current revision of the source resource.',
        },
        title: { type: 'string', description: 'Display title of the new copy.' },
        syncNativeName: {
          type: 'boolean',
          description:
            'Prompt presets only: also set the native preset name to the new title. By default the authored native name is kept.',
        },
      },
      required: ['kind', 'sourceId', 'expectedSourceRevision', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.save',
    effect: 'mutation',
    target: resourceTarget,
    description:
      "Create a new library resource, or replace an existing one with a complete editable model. Use it to create a theme (start from the storyUi example in theme.guide) or an illustration preset, or when a whole model really must be replaced. To change some fields of a bot, persona, module, prompt preset or an existing theme's Story UI, use resource.patch, which keeps the other fields; to copy a bot or preset, use resource.clone. Omit id and expectedRevision to create; pass both, with the latest revision, to replace. Saving a theme or an illustration preset does not apply it: that is theme.select or illustration-preset.select, whose expectedRevision is the preferencesRevision this save returns.",
    inputSchema: {
      type: 'object',
      properties: {
        kind,
        id: { type: 'string', description: 'Id of the resource to replace. Omit to create.' },
        expectedRevision: {
          ...revision,
          description: 'Latest revision of the resource to replace. Omit to create.',
        },
        model: { type: 'object', description: 'The complete editable model of the resource.' },
      },
      required: ['kind', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.undo',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Undo the most recent save of one library resource by restoring the single previous version that is kept for it, as a new save. Use it when the last edit to a library resource should be taken back. Only one previous version is kept and the next save replaces it, so when unsure what would come back, compare first with resource.read version=previous. It fails when no previous version is kept or when the resource changed since expectedRevision.',
    inputSchema: {
      type: 'object',
      properties: { kind, id: resourceId, expectedRevision },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'resource.delete',
    effect: 'mutation',
    target: resourceTarget,
    description:
      'Delete a saved bot, persona, module, prompt preset, theme or illustration preset from the library. The helper has no operation that restores a deleted item, so check the id, title and current revision with a read first. A prompt preset that is the current default main or translation prompt cannot be deleted until another one is selected.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['content', 'prompt-preset', 'theme', 'illustration-preset'],
          description:
            'content is a saved bot, persona or module; prompt-preset a prompt preset; theme a theme; illustration-preset an illustration preset.',
        },
        id: resourceId,
        expectedRevision,
      },
      required: ['kind', 'id', 'expectedRevision'],
      additionalProperties: false,
    },
  },
  {
    name: 'image.update-metadata',
    effect: 'mutation',
    target: (args) =>
      typeof args.contentId === 'string' ? { kind: 'content', id: args.contentId } : null,
    description:
      'Change the display name and description of one saved image of a bot, persona or module. These two texts are what JEV image selection reads, so describe what the image shows. The image bytes, its id and the names that native scripts use to reference it do not change. Get imageId and the content revision from image.list.',
    inputSchema: {
      type: 'object',
      properties: {
        contentId: {
          type: 'string',
          description: 'Id of the bot, persona or module that owns the image.',
        },
        imageId: { type: 'string', description: 'Id of the image, from image.list.' },
        expectedRevision: {
          ...revision,
          description: 'Current revision of the owning content.',
        },
        title: {
          type: 'string',
          description: 'New display name. Both title and description are required.',
        },
        description: { type: 'string', description: 'New description of what the image shows.' },
      },
      required: ['contentId', 'imageId', 'expectedRevision', 'title', 'description'],
      additionalProperties: false,
    },
  },
];
export const RESOURCE_TOOLS: ProviderTool[] = resourceTools.map((definition) => {
  const { effect: _effect, ...tool } = definition;
  if ('target' in tool) {
    const { target: _target, targets: _targets, ...schema } = tool;
    return schema;
  }
  return tool;
});

export function helperResourceOperation(
  name: string,
  args: Record<string, unknown> = {}
):
  | { readOnly: true }
  | { readOnly: false; target: ResourceMutationTarget | null; targets?: ResourceMutationTarget[] }
  | undefined {
  const definition = resourceTools.find((tool) => tool.name === name);
  if (!definition) return undefined;
  return definition.effect === 'read'
    ? { readOnly: true }
    : {
        readOnly: false,
        target: definition.target(args),
        ...(definition.targets ? { targets: definition.targets(args) } : {}),
      };
}
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
  if (name === 'resource.readMany') return readHelperResources(store, args.items);
  if (name === 'resource.patchMany') return patchHelperResources(store, args.items);
  if (name === 'preset.validate') return validateHelperPreset(store, args);
  if (name === 'illustration-preset.list') {
    const catalog = illustrationPresetCatalog(store);
    return {
      ...catalog,
      presets: catalog.presets.map(({ id, revision, title, description, generator }) => ({
        id,
        revision,
        title,
        description,
        generator,
      })),
    };
  }
  if (name === 'illustration-preset.guide')
    return {
      example: emptyIllustrationPreset(),
      contract:
        'Save with resource.save kind=illustration-preset. Required title and generator (codex, comfyui or novelai), optional description and styleGuidance, comfyui: {workflow, negativeGuidance}, novelai: {negativeGuidance}. workflow is API-format JSON with {{prompt}}, {{negative}}, {{seed}} placeholders; an empty workflow is valid for Codex but cannot generate with ComfyUI. The selected recipe chooses the generator and uses its shared local environment. No provider IDs, credentials, automatic-generation policies or chat reference images belong here. Portable exports are v2; v1 infers comfyui when a workflow exists, otherwise codex. Saving an in-use preset affects future reservations; existing jobs and retries keep frozen input. Saving a new preset does not select it. User selection priority: chat, bot, global. No image generation on save.',
    };
  if (name === 'theme.list') {
    const catalog = themeCatalog(store);
    return {
      themes: catalog.themes.map(({ id, revision, title, description, storyUi }) => ({
        id,
        revision,
        title,
        description,
        ...(storyUi ? { storyUi: { baseStyle: storyUi.baseStyle } } : {}),
      })),
      palettes: catalog.palettes.map((palette) => ({
        id: palette.id,
        ...('revision' in palette ? { revision: palette.revision } : {}),
        title: palette.title,
        description: palette.description,
      })),
      preferences: catalog.preferences,
    };
  }
  if (name === 'theme.guide')
    return {
      colors: THEME_COLOR_KEYS,
      slots: THEME_SLOTS,
      optionalSlots: ['portrait', 'request-persona'],
      example: themeDefinition(BUILTIN_THEMES[1]),
      storyUi: {
        baseStyles: storyUiStyles,
        example: {
          title: 'Moonlit archive',
          description: 'Lavender paper and dark violet ink for an occult archive.',
          storyUi: {
            baseStyle: 'fantasy',
            css: '& { --story-paper: #f1ebf3; --story-surface: #fffbff; --story-ink: #292132; --story-border: #927d9c; --story-accent: #583a6c; } .story-ui-tabs { border-bottom: 1px solid var(--story-border); }',
          },
        },
        workflow:
          'For the current chat, use the id of the role=bot item in writing.packages. In library scope, use the captured bot editor target or discover the requested bot with data.search scope=library and output=documents. Use resource.read kind=content with that ID, then follow source.path and read the authored description, personality, scenario or other relevant paths. Base the theme on those details and the user’s request. Save using resource.save kind=theme, with model shaped like the example. For existing themes, use current revision and resource.patch to preserve unrelated CSS and layout. When asked to apply for a bot, use theme.list preference revision and theme.select with dimension=storyUi, scope=bot, targetId=bot ID and themeId=saved theme ID. A bot default applies to its chats with auto style. For an explicit current-chat override, use settings.update for chat.storyUiStyle with theme:<theme ID>; auto follows the bot default or model choice. Previews and proposals do not authorize saving or selection.',
        css: 'Use & for the Story UI panel. --story-paper, --story-surface, --story-ink, --story-muted, --story-border, --story-accent, --story-accent-ink, --story-accent-text, --story-radius, --story-font and --story-display control the shared skin; a theme that sets only some of them gets muted text from its ink and accent text from its accent. Every component is ordinary markup with a story-ui-* class, including .story-ui-frame (data-kind, data-accent), .story-ui-message, .story-ui-bubble, .story-ui-post, .story-ui-notice, .story-ui-badge, .story-ui-stat, .story-ui-gauge, .story-ui-card, .story-ui-button, .story-ui-tabs, .story-ui-field, .story-ui-table and .story-ui-chart. A theme on a named base style renders with the light palette of that style. Use ordinary style rules and @media/@supports, with legible contrast, focus indicators and responsive sizing. Styles only affect the rendered Story UI panel. The renderer ignores global at-rules such as @import, @font-face and @property. Use registered font families and CSS only.',
        boardCss:
          'Optional storyUi.boardCss styles the body of the Status side-panel tab that shows pinned blocks, not the blocks themselves and not the app tabs. Use & for the panel body; it sets --board-paper (background), --board-ink, --board-muted, --board-line, --board-selected (selected slot chip) and --board-font, and .story-board-slots > button[aria-selected="true"] is the selected chip. Decorations stay inside the body. Without boardCss the body follows the built-in style colors of the pinned block.',
      },
      contract:
        'Save with resource.save kind=theme. title required. colors.light/dark map the documented names without -- to hex colors. appCss styles the app; messageCss is a low-priority layer in each Risu message ShadowRoot. templateHtml needs exactly one native slot for each name: request, heading, body, actions; templateCss styles that layout ShadowRoot. Optional single portrait and request-persona slots project app-owned portraits and zoom controls; request-persona belongs beside submitted user input. An optional data-uimori-body-scroll marker on the body slot opts into bounded inner scrolling with reading/navigation support. Do not hardcode character URLs. Empty HTML uses the default. No JavaScript or CBS in themes. Preserve reading preferences and bot HTML. Use responsive CSS. Stable data-uimori-part hooks: scene, scene-frame, request, heading, body, actions, composer-input, scene-portraits, portrait-group, bot-portrait, persona-portrait. Layout and palette selection are independent server preferences; saved theme colors remain portable. External images remain URL references; data URLs travel with JSON. Saving does not select. Use palette.list/save for independent color presets, font.list/register for named public HTTPS font files, and theme.select or font.select only when application is explicitly requested. A preview/proposal alone is not a save or apply request. Full guide: docs/THEME-AUTHORING.md.',
    };
  if (name === 'image.update-metadata') {
    const id = text(args.contentId, 'content ID', 100);
    const content = readResource(store, 'content', id) as Content;
    const imageId = text(args.imageId, 'image ID', 200);
    if (!content.package.images?.some((image) => image.id === imageId))
      throw new HelperToolError(404, 'IMAGE_NOT_FOUND_IN_CONTENT');
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
  if (
    !['content', 'prompt-preset', 'prompt-workspace', 'theme', 'illustration-preset'].includes(
      String(args.kind)
    )
  )
    throw new HelperToolError(
      400,
      'INVALID_ARGUMENTS',
      'kind must be content, prompt-preset, prompt-workspace, theme or illustration-preset'
    );
  const kind = args.kind as ResourceKind;
  if (name === 'resource.clone') {
    const result = cloneResource(
      store,
      parseInput(resourceEditorOperations.cloneResource.input, args)
    );
    return { ...summary(result), source: result.source };
  }
  if (name === 'resource.save') {
    const input = parseInput(resourceEditorOperations.saveResource.input, args);
    return summary(
      saveResource(store, {
        ...input,
        id: input.id ?? null,
        model: input.model as ResourceModel,
      })
    );
  }
  if (name === 'resource.undo') {
    const input = parseInput(resourceEditorOperations.undoResource.input, args);
    return summary(undoResource(store, input.kind, input.id, input.expectedRevision));
  }
  const id = args.id == null ? null : text(args.id, 'resource ID', 100);
  if (name === 'resource.read') return readHelperResource(store, kind, id ?? 'current', args);
  if (name === 'resource.patch') {
    if (!id) throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'id is required');
    return patchHelperResource(
      store,
      kind,
      id,
      number(args.expectedRevision, 'revision'),
      args.changes
    );
  }
  const expectedRevision =
    args.expectedRevision === undefined ? undefined : number(args.expectedRevision, 'revision');
  if (!id || expectedRevision === undefined)
    throw new HelperToolError(400, 'INVALID_ARGUMENTS', 'id and expectedRevision are required');
  if (name === 'resource.delete' && kind === 'illustration-preset')
    return deleteIllustrationPreset(store, id, expectedRevision);
  if (name === 'resource.delete' && kind === 'theme')
    return deleteTheme(store, id, expectedRevision);
  if (name === 'resource.delete' && (kind === 'content' || kind === 'prompt-preset'))
    return deleteLibraryItem(store, kind, id, { expectedRevision });
  throw new HelperToolError(
    400,
    'INVALID_ARGUMENTS',
    'Unsupported resource operation for this kind'
  );
}
