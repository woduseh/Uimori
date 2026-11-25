import {
  readOptionalJson,
  removeOptionalStorage,
  writeOptionalStorage,
  type BrowserStorageArea,
} from './optional-storage.js';

export type StorageOwner =
  | 'setting'
  | 'browser'
  | 'signal'
  | 'chat'
  | 'bot'
  | 'helper-conversation'
  | 'task'
  | 'illustration'
  | 'prompt-group'
  | 'transient';

export type StorageFamily = {
  readonly key: string;
  readonly match: 'exact' | 'prefix';
  readonly areas: readonly BrowserStorageArea[];
  readonly owner: StorageOwner;
  readonly work?: true;
  readonly cap?: number;
};

type Options = { work?: true; cap?: number };
const families: StorageFamily[] = [];
const local = ['local'] as const;
const session = ['session'] as const;
const both = ['local', 'session'] as const;

function exact<K extends string>(
  key: K,
  areas: readonly BrowserStorageArea[],
  owner: StorageOwner,
  options: Options = {}
): K {
  families.push({ key, match: 'exact', areas, owner, ...options });
  return key;
}
function keyed<A extends unknown[]>(
  prefix: string,
  areas: readonly BrowserStorageArea[],
  owner: StorageOwner,
  suffix: (...args: A) => string,
  options: Options = {}
): ((...args: A) => string) & { readonly prefix: string } {
  families.push({ key: prefix, match: 'prefix', areas, owner, ...options });
  return Object.assign((...args: A) => prefix + suffix(...args), { prefix });
}
const one = (value: string) => value;
const joined = (...parts: string[]) => parts.join(':');

export const storageKeys = {
  uiLanguage: exact('uimori:ui-language', local, 'setting'),
  theme: exact('uimori:theme', local, 'setting'),
  font: exact('uimori:font', local, 'setting'),
  fontSize: exact('uimori:font-size', local, 'setting'),
  readability: exact('uimori:readability', local, 'setting'),
  readingWidth: exact('uimori:reading-width', local, 'setting'),
  readingLanguage: exact('uimori:reading-language', local, 'setting'),
  responseDisplay: exact('uimori:response-display', local, 'setting'),
  enterSend: exact('uimori:enter-send', local, 'setting'),
  sidebarWidth: exact('uimori:sidebar-width', local, 'setting'),
  sidebarCollapsed: exact('uimori:sidebar-collapsed', local, 'setting'),
  sceneNavigator: exact('uimori:scene-navigator', local, 'setting'),
  illustrationsCollapsed: exact('uimori:illustrations-collapsed', local, 'setting'),
  firstMessageFont: exact('uimori:first-message-font', local, 'setting'),
  changeReviewLayout: exact('uimori:change-review-layout', local, 'setting'),
  shortcuts: exact('uimori:shortcuts', local, 'setting'),
  shortcutBindings: exact('uimori:shortcut-bindings', local, 'setting'),
  panelWidth: exact('uimori:panel-width', local, 'setting'),
  workspacePanel: exact('uimori:workspace-panel', local, 'setting'),
  helperRunningSend: exact('uimori:helper-running-send', local, 'setting'),
  helperMode: exact('uimori:helper-mode', local, 'setting'),
  helperLiveActivity: exact('uimori:helper-live-activity', local, 'setting'),
  libraryCollapsedFolders: exact('uimori:library-collapsed-folders', local, 'setting'),
  libraryViews: exact('uimori-library-views', local, 'setting'),
  libraryCardRatios: exact('uimori-library-card-ratios', local, 'setting'),
  librarySorts: exact('uimori-library-sorts', local, 'setting'),
  libraryManualOrders: exact('uimori-library-manual-orders', local, 'setting'),
  jevDisplayPosition: exact('uimori-jev-display-position', local, 'setting'),
  chatSettingsSection: exact('uimori:chat-settings-section', local, 'setting'),
  appSettingsSection: exact('uimori:app-settings-section', local, 'setting'),
  inputTranslationLanguage: exact('uimori:input-translation-language', local, 'setting'),
  selectionRevisionContext: exact('uimori:selection-revision-context', local, 'setting'),
  lastWorkspace: exact('uimori:last-workspace', local, 'setting'),
  activitySections: exact('uimori:activity-sections:v1', local, 'setting'),
  helperActivitySections: exact('uimori:helper-activity-sections:v1', local, 'setting'),
  botTree: exact('uimori.bot-tree.v1', local, 'setting'),
  helperNavigation: exact('uimori:helper-navigation:v1', local, 'setting'),
  readingClient: exact('uimori:reading-client', local, 'browser'),
  storageRecency: exact('uimori:storage-recency:v1', local, 'browser'),
  libraryChanged: exact('uimori:library-change', local, 'signal'),

  readingPosition: keyed('reading:', both, 'chat', one),
  activityAcknowledgement: keyed(
    'uimori:activity-acknowledged:v1:',
    local,
    'chat',
    (scope: string, identity: string) => `${JSON.stringify(scope)}:${identity}`
  ),
  chatFolders: keyed('uimori.chat-folders.', local, 'bot', one),
  illustrationCollapsed: keyed('uimori:illustration-collapsed:', local, 'illustration', one, {
    cap: 500,
  }),
  promptOptionGroup: keyed('uimori:prompt-option-group:', local, 'prompt-group', one, {
    cap: 200,
  }),
  helperConfirmationDeclined: keyed(
    'uimori:helper-confirmation-declined:',
    local,
    'task',
    (taskId: string, confirmationId: string) => joined(taskId, confirmationId),
    { cap: 200 }
  ),
  helperSession: keyed('uimori:helper-session:', local, 'helper-conversation', one),
  helperSessionScope: keyed('uimori:helper-session-scope:', local, 'helper-conversation', one),
  helperSeen: keyed('uimori:helper-seen:', local, 'helper-conversation', one),
  helperCreate: keyed('uimori:helper-create:', both, 'helper-conversation', one, { work: true }),
  helperCopy: keyed('uimori:helper-copy:', both, 'helper-conversation', one, { work: true }),
  helperProjectCreate: keyed('uimori:helper-project-create:', both, 'helper-conversation', one, {
    work: true,
  }),

  command: keyed('command:', session, 'chat', one, { work: true }),
  draft: keyed('draft:', session, 'chat', one, { work: true }),
  draftCursor: keyed('cursor:', session, 'chat', one),
  requestState: keyed('request-state:', session, 'chat', one, { work: true }),
  loreReset: keyed('lore-reset:', session, 'chat', one, { work: true }),
  inputTranslationOriginal: keyed('input-translation:', session, 'chat', one, { work: true }),
  pendingProfile: keyed('pending-profile:', session, 'chat', one, { work: true }),
  queuedRequest: keyed('queued-request:', session, 'chat', one, { work: true }),
  requestEdit: keyed('request-edit:', session, 'chat', one, { work: true }),
  requestContextEdit: keyed('request-context-edit:', session, 'chat', one, { work: true }),
  forkCommand: keyed(
    'fork-command:',
    session,
    'chat',
    (chatId: string, sourceId: string | null) => `${chatId}:${sourceId}`,
    { work: true }
  ),
  sceneDeletion: keyed('scene-delete:', session, 'chat', joined, { work: true }),
  outlineWorkspace: keyed('outline-workspace:', session, 'chat', joined, { work: true }),
  outlinePending: keyed('outline-pending:', session, 'chat', one, { work: true }),
  chatVariableDraft: keyed('uimori:chat-variable-draft:', session, 'chat', one, { work: true }),
  storyUiDraft: keyed('uimori:story-ui-draft:', session, 'chat', joined, { work: true }),
  textDraft: keyed('uimori:text-draft:', session, 'chat', joined, { work: true }),
  resourceClone: keyed('resource-clone:', session, 'transient', joined, { work: true }),
  helperResponseEdit: keyed('helper-response-edit:', session, 'helper-conversation', one, {
    work: true,
  }),
  helperAttachmentsAccepted: keyed(
    'uimori:helper-attachments-accepted:',
    session,
    'helper-conversation',
    one,
    { work: true }
  ),
  helperAttachmentsToken: keyed(
    'uimori:helper-attachments-token:',
    session,
    'helper-conversation',
    one,
    { work: true }
  ),
  readerMode: keyed('reader-mode:', session, 'transient', one),
  activityHidden: keyed('activity-hidden:', session, 'transient', one),
  turnActivity: keyed('turn-activity:', session, 'transient', joined),
  helperTaskActivity: keyed(
    'helper-task-activity:',
    session,
    'transient',
    (conversationId: string, taskId: string, settled: boolean) =>
      `${conversationId}:${taskId}${settled ? ':settled' : ''}`
  ),
  readingSuggestion: keyed('uimori:reading-suggestion:', session, 'transient', one),
  requestDraftTab: exact('uimori:request-draft-tab', session, 'transient'),
  editorTabScope: exact('uimori:editor-tab-scope', session, 'transient'),
  themeDisabled: exact('uimori:theme-disabled', session, 'setting'),
};

export const storageFamilies: readonly StorageFamily[] = families;

export function storageFamily(area: BrowserStorageArea, key: string): StorageFamily | undefined {
  return families.find(
    (family) =>
      family.areas.includes(area) &&
      (family.match === 'exact' ? key === family.key : key.startsWith(family.key))
  );
}

export function localStorageNamespaces(): string[] {
  return [
    ...new Set(
      families
        .filter((family) => family.areas.includes('local'))
        .map((family) => /^[^:.-]*[:.-]/u.exec(family.key)?.[0] ?? family.key)
    ),
  ];
}

function localKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)
    ).filter((key): key is string => key !== null);
  } catch {
    return [];
  }
}

export function localKeysStartingWith(prefix: string): string[] {
  return localKeys().filter((key) => key.startsWith(prefix));
}

export function sweepUnregisteredStorage() {
  const namespaces = localStorageNamespaces();
  for (const key of localKeys())
    if (namespaces.some((namespace) => key.startsWith(namespace)) && !storageFamily('local', key))
      removeOptionalStorage('local', key);
}

function cappedFamily(key: string) {
  const family = storageFamily('local', key);
  return family?.cap && family.match === 'prefix' ? family : undefined;
}
function readRecency(): Record<string, string[]> {
  const value = readOptionalJson('local', storageKeys.storageRecency, null);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string[]>)
    : {};
}
function updateRecency(key: string, keep: boolean) {
  const family = cappedFamily(key);
  if (!family?.cap) return;
  const present = localKeys().filter((item) => item.startsWith(family.key));
  const recency = readRecency();
  const known = (Array.isArray(recency[family.key]) ? recency[family.key]! : []).filter(
    (item) => typeof item === 'string' && item !== key && present.includes(item)
  );
  const order = [...present.filter((item) => item !== key && !known.includes(item)), ...known];
  if (keep) order.push(key);
  const evicted = order.splice(0, Math.max(0, order.length - family.cap));
  for (const item of evicted) removeOptionalStorage('local', item);
  writeOptionalStorage(
    'local',
    storageKeys.storageRecency,
    JSON.stringify({ ...recency, [family.key]: order })
  );
}

export function writeRecentStorage(key: string, value: string): boolean {
  const written = writeOptionalStorage('local', key, value);
  if (written) updateRecency(key, true);
  return written;
}

export function removeRecentStorage(key: string) {
  removeOptionalStorage('local', key);
  updateRecency(key, false);
}

function removeLocal(owned: (key: string) => boolean) {
  for (const key of localKeys()) if (owned(key)) removeOptionalStorage('local', key);
}

function acknowledgedChat(key: string): string | undefined {
  const { prefix } = storageKeys.activityAcknowledgement;
  const end = key.indexOf('":', prefix.length);
  if (!key.startsWith(`${prefix}"`) || end < 0) return undefined;
  try {
    return JSON.parse(key.slice(prefix.length, end + 1)) as string;
  } catch {
    return undefined;
  }
}
const chatGroupPrefix = storageKeys.helperSession('chat:');
function scopedChat(key: string): string | undefined {
  if (key.startsWith(chatGroupPrefix)) return key.slice(chatGroupPrefix.length);
  const { prefix } = storageKeys.helperSessionScope;
  if (!key.startsWith(prefix)) return undefined;
  try {
    const scope = JSON.parse(key.slice(prefix.length)) as { kind?: unknown; chatId?: unknown };
    return scope.kind === 'chat' && typeof scope.chatId === 'string' ? scope.chatId : undefined;
  } catch {
    return undefined;
  }
}
function chatOf(key: string): string | undefined {
  const { prefix } = storageKeys.readingPosition;
  if (key.startsWith(prefix)) return key.slice(prefix.length);
  return acknowledgedChat(key) ?? scopedChat(key);
}
const botOf = (key: string) => {
  const { prefix } = storageKeys.chatFolders;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
};

export function forgetChatStorage(chatId: string) {
  removeLocal((key) => chatOf(key) === chatId);
  removeOptionalStorage('session', storageKeys.readingPosition(chatId));
}

export function forgetMissingChats(liveChatIds: ReadonlySet<string>) {
  removeLocal((key) => {
    const chatId = chatOf(key);
    return chatId !== undefined && !liveChatIds.has(chatId);
  });
}

export function forgetBotStorage(botId: string) {
  removeOptionalStorage('local', storageKeys.chatFolders(botId));
}

export function forgetMissingBots(liveBotIds: ReadonlySet<string>) {
  removeLocal((key) => {
    const botId = botOf(key);
    return botId !== undefined && !liveBotIds.has(botId);
  });
}
