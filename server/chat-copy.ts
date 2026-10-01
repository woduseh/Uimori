import { captureIllustrations, restoreIllustrations } from './illustration-copy.js';
import { captureBookmarks, restoreBookmarks } from './reading-state.js';
import { captureChatAuthoring, restoreChatAuthoring } from './chat-copy-authoring.js';
import {
  captureCopiedMessages,
  restoreCopiedMessages,
  mapCopiedMessageTexts,
} from './chat-copy-messages.js';
import { independentTextMedia } from './chat-media.js';
import { independentTranscriptMedia } from './chat-media.js';
import type { Store, Chat } from './store.js';
import type { ChatCopy } from '../core/chat-backup.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import { exportChatTranscript, importChatTranscript } from './chat-transcript.js';
import { readChatVariables } from './chat-variables.js';
import { HttpError } from './request-validation.js';

/** Capture user-visible state through a selected source. No future notes/variables leak into an old copy. */
export function captureChatCopy(store: Store, chatId: string, sourceId?: string | null): ChatCopy {
  const chat = store.chat(chatId);
  const head = sourceId === undefined ? chat.headRevision : sourceId;
  if (head && store.source(head).chatId !== chatId) throw new HttpError(400, 'Source outside chat');
  const history = store.history(head);
  const transcript = independentTranscriptMedia(store, exportChatTranscript(store, chatId, head));
  const profile = store.product.profile(chatId);
  const checkpoints = history.map((source) => {
    const row = store.db
      .prepare('SELECT body FROM chat_variable_outputs WHERE source_id=?')
      .get(source.revision);
    return row ? validateChatVariableState(JSON.parse(String(row.body))) : null;
  });
  const variables =
    head === chat.headRevision
      ? readChatVariables(store, chatId)
      : (checkpoints.at(-1) ?? { revision: 0, values: {} });
  const messages = captureCopiedMessages(store, history);
  mapCopiedMessageTexts(messages, (text) => independentTextMedia(store, text));
  const illustrations = captureIllustrations(store, history);
  return {
    transcript,
    state: {
      bookmarks: captureBookmarks(
        store,
        chatId,
        history.map((source) => source.revision)
      ),
      variables,
      checkpoints,
      messages,
      authoring: captureChatAuthoring(store, chatId, history),
      settings: chat.settings,
      profile: {
        image: profile.image,
        imageTranslation: profile.imageTranslation,
        loreContext: profile.loreContext,
        pinned: profile.pinned,
      },
    },
    illustrations,
  };
}

/** Restore plain messages, notes, variable checkpoints and images; never replay a model or script execution. */
export function restoreChatCopy(
  store: Store,
  copy: ChatCopy,
  requestKey: string,
  title = copy.transcript.title
): Chat {
  return store.transaction(() => {
    const imported = importChatTranscript(store, {
      transcript: copy.transcript,
      title,
      idempotencyKey: requestKey,
    });
    if (!imported.created) return imported.chat;
    const chatId = imported.chat.id;
    const history = store.history(imported.chat.headRevision);
    if (copy.state.checkpoints.length !== history.length)
      throw new HttpError(400, '채팅 상태와 메시지 수가 맞지 않아요.');
    const variables = validateChatVariableState(copy.state.variables);
    const profile = store.product.profile(chatId);
    store.product.updateProfile(chatId, {
      expectedRevision: profile.revision,
      packageAttachments: profile.packageAttachments,
      ...copy.state.profile,
    });
    store.settings(chatId, imported.chat.settingsRevision, copy.state.settings);
    for (const [index, source] of history.entries()) {
      const checkpoint = copy.state.checkpoints[index];
      if (checkpoint)
        store.db
          .prepare(
            'INSERT INTO chat_variable_outputs(source_id,body) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET body=excluded.body'
          )
          .run(source.revision, JSON.stringify(validateChatVariableState(checkpoint)));
    }
    store.db
      .prepare(`INSERT INTO chat_variable_states(chat_id,revision,values_json) VALUES(?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,values_json=excluded.values_json`)
      .run(chatId, variables.revision, JSON.stringify(variables.values));
    if (copy.state.authoring) restoreChatAuthoring(store, chatId, history, copy.state.authoring);
    if (copy.state.messages) restoreCopiedMessages(store, copy.state.messages, history);
    restoreBookmarks(
      store,
      chatId,
      history.map((source) => source.revision),
      copy.state.bookmarks
    );
    restoreIllustrations(store, history, copy.illustrations);
    return store.chat(chatId);
  });
}
