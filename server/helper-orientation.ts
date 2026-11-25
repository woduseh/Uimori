import type { HelperTaskSnapshot } from '../core/helper.js';
import type { Json } from '../core/transport.js';
import { helperModelReferences } from './helper-references.js';
import { helperSceneEditTarget, sceneTranslationState } from './helper-scene-tools.js';
import type { Store } from './store.js';

export function helperChatOrientation(
  store: Store,
  chatId: string,
  writing: NonNullable<HelperTaskSnapshot['writing']>
): Record<string, Json> {
  const chat = store.chat(chatId);
  const context = store.context.current(chatId);
  const guide = store.storyGuide.get(chatId);
  const organization = store.organization.metadata(chatId);
  const profile = writing.profile;
  const mainModel = profile?.models?.main;
  const mainPrompt = profile?.promptPresets?.main;
  const visible = writing.history.filter((item) => item.sceneContext?.sceneEnabled !== false);
  const latest = writing.history.at(-1);
  const latestSource = latest ? store.source(latest.revision) : undefined;
  return {
    title: chat.title,
    titleRevision: chat.titleRevision ?? 0,
    settingsRevision: writing.settingsRevision,
    settings: {
      maxCalls: writing.settings.maxCalls,
      storyUi: writing.settings.storyUi ?? false,
      storyUiStyle: writing.settings.storyUiStyle ?? 'auto',
    },
    ...(profile ? { profileRevision: profile.revision } : {}),
    effective: {
      mainModel: mainModel ? { id: mainModel.id, title: mainModel.title } : null,
      mainPromptPreset: mainPrompt ? { id: mainPrompt.id, title: mainPrompt.title } : null,
    },
    notesRevision: context.notesRevision,
    activeContextRevision: context.activeRevision,
    storyGuide: {
      revision: guide.revision,
      enabled: guide.config.enabled,
      work: guide.config.work || null,
    },
    ...(organization
      ? {
          botId: organization.botId,
          folderId: organization.folderId,
          organizationRevision: organization.organizationRevision,
        }
      : {}),
    latestScene:
      latest && latestSource
        ? {
            ...helperSceneEditTarget(store, chatId, latest.revision),
            sceneNumber:
              latest.sceneContext?.sceneEnabled === false ? null : visible.length || null,
            translation: sceneTranslationState(store, latestSource),
          }
        : null,
  };
}

export function seededHelperOperations(
  store: Store,
  snapshot: Pick<
    HelperTaskSnapshot,
    'scope' | 'editor' | 'selection' | 'outline' | 'references' | 'mode'
  >
): string[] {
  const review = snapshot.outline?.target.purpose === 'review';
  const writes = snapshot.mode !== 'plan' && !review;
  const names: string[] = [];
  const add = (...items: string[]) => {
    for (const item of items) if (!names.includes(item)) names.push(item);
  };
  if (snapshot.selection) add('scene.read', ...(writes ? ['scene.patch'] : []));
  if (snapshot.editor) {
    const unsaved = snapshot.editor.source !== 'saved' && snapshot.editor.model !== undefined;
    add(
      unsaved ? 'editor.read' : 'resource.read',
      ...(writes && !unsaved ? ['resource.patch'] : [])
    );
  }
  if (snapshot.outline) add('outline.read', ...(writes ? ['outline.write'] : []));
  for (const target of helperModelReferences(store, snapshot.scope, snapshot.references)) {
    const readTool = (target as { readTool?: string }).readTool;
    if (readTool === 'scene.read') add('scene.read', ...(writes ? ['scene.patch'] : []));
    else if (readTool === 'outline.read') add('outline.read', ...(writes ? ['outline.write'] : []));
    else if (readTool === 'resource.read')
      add('resource.read', ...(writes ? ['resource.patch'] : []));
  }
  return names;
}
