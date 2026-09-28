import { captureBookmarks, restoreBookmarks } from './reading-state.js';
import { captureChatAuthoring, restoreChatAuthoring } from './chat-copy-authoring.js';
import {
  captureCopiedMessages,
  restoreCopiedMessages,
  mapCopiedMessageTexts,
} from './chat-copy-messages.js';
import { independentTextMedia } from './chat-media.js';
import { independentTranscriptMedia } from './chat-media.js';
import { storeImage } from './image-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store, Chat } from './store.js';
import type { ChatCopy, PortableIllustration } from '../core/chat-backup.js';
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
  const illustrations: PortableIllustration[] = [];
  for (const [entry, source] of history.entries()) {
    for (const row of store.db
      .prepare(`SELECT i.mime,b.bytes,i.body FROM illustration_images i JOIN image_blobs b ON b.hash=i.hash
      JOIN illustration_jobs j ON j.id=i.job_id WHERE j.source_revision=? AND j.status='completed' ORDER BY j.created_at,i.position`)
      .all(source.revision)) {
      illustrations.push({
        entry,
        mime: row.mime as PortableIllustration['mime'],
        base64: Buffer.from(row.bytes as Uint8Array).toString('base64'),
        title: String(JSON.parse(String(row.body)).caption ?? ''),
      });
    }
  }
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
    for (const image of copy.illustrations) {
      const source = history[image.entry];
      if (!source) throw new HttpError(400, '삽화의 메시지가 없어요.');
      const owner = store.source(source.revision);
      const id = randomUUID(),
        time = new Date().toISOString();
      const bytes = Buffer.from(image.base64, 'base64');
      store.db
        .prepare(`INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,owner,attempt,input,diagnostic,error,created_at,updated_at)
        VALUES(?,?,?,?,'manual','completed',1,NULL,1,?,NULL,NULL,?,?)`)
        .run(
          id,
          chatId,
          owner.id,
          owner.hash,
          JSON.stringify({
            version: 1,
            generator: 'none',
            settingsRevision: 1,
            styleGuidance: '',
            maxAutoRetries: 0,
          }),
          time,
          time
        );
      const hash = createHash('sha256').update(bytes).digest('hex');
      storeImage(store.db, { hash, mime: image.mime, bytes });
      store.db
        .prepare(
          'INSERT INTO illustration_images(id,job_id,chat_id,position,mime,hash,body,created_at) VALUES(?,?,?,0,?,?,?,?)'
        )
        .run(
          randomUUID(),
          id,
          chatId,
          image.mime,
          hash,
          JSON.stringify({ caption: image.title }),
          time
        );
    }
    return store.chat(chatId);
  });
}
