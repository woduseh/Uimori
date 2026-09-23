import { createHash, randomUUID } from 'node:crypto';
import {
  CHAT_TRANSCRIPT_FORMAT,
  CHAT_TRANSCRIPT_VERSION,
  validateChatTranscript,
  type ChatTranscript,
} from '../core/chat-transcript.js';
import type { Content, ContentRef } from '../core/product.js';
import type { ContentAttachment } from '../core/risu-content.js';
import type { RunSnapshot } from '../core/types.js';
import type { Chat, Store } from './store.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { successfulTranslation } from './translation-artifacts.js';

/** User-authored data through a selected source; no execution or database-table archive. */
export function exportChatTranscript(
  store: Store,
  chatId: string,
  branchId?: string,
  throughSource?: string | null
): ChatTranscript {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const head = throughSource === undefined ? branch.headRevision : throughSource;
  const history = store.history(head);
  const profile = store.product.profile(chatId);
  if (history.some((item) => store.source(item.revision).chatId !== chatId))
    throw new HttpError(400, 'Source outside chat');
  const entries = history.map((item) => {
    const source = store.source(item.revision);
    return {
      request: String(
        store.db.prepare('SELECT request FROM runs WHERE id=?').get(source.runId)!.request
      ),
      text: item.text,
      translation: successfulTranslation(store, source)?.result?.text ?? null,
    };
  });
  const notes = store.story.notes.entries(store.story.notes.scope(chatId, head)).map((note) => ({
    text: note.text,
    author: note.declaration.author,
    atIndex:
      note.atRevision === null
        ? null
        : history.findIndex((item) => item.revision === note.atRevision),
    ...(note.kind === 'imported-memory'
      ? { kind: note.kind, origin: note.origin }
      : { kind: note.kind }),
  }));
  return {
    format: CHAT_TRANSCRIPT_FORMAT,
    version: CHAT_TRANSCRIPT_VERSION,
    exportedAt: new Date().toISOString(),
    title: chat.title,
    packageAttachments: profile.packageAttachments ?? [],
    notes,
    entries,
  };
}

export type ChatTranscriptImport = {
  chat: Chat;
  created: boolean;
  skippedAttachments: (ContentRef | ContentAttachment)[];
};

/** Store complete authored messages without invoking generation, native callbacks or auxiliary jobs. */
export function importChatTranscript(store: Store, value: unknown): ChatTranscriptImport {
  const body = record(value);
  fields(body, ['transcript', 'title', 'idempotencyKey']);
  const transcript = validateChatTranscript(body.transcript);
  const title = body.title === undefined ? transcript.title : text(body.title, 'title', 200);
  const key = `transcript:${text(body.idempotencyKey, 'import request', 160)}`;
  const digest = createHash('sha256')
    .update(JSON.stringify({ ...transcript, exportedAt: undefined, title }))
    .digest('hex');
  return store.transaction(() => {
    const prior = store.db
      .prepare('SELECT digest,result FROM import_operations WHERE key=?')
      .get(key);
    if (prior) {
      if (prior.digest !== digest)
        throw new HttpError(409, '다른 채팅에 같은 가져오기 ID가 사용됐어요.');
      const saved = JSON.parse(String(prior.result));
      return {
        chat: store.chat(saved.chatId),
        created: false,
        skippedAttachments: saved.skippedAttachments,
      };
    }
    const skippedAttachments: ChatTranscriptImport['skippedAttachments'] = [];
    const attachments = transcript.packageAttachments.flatMap((ref) => {
      try {
        const content = store.product.get<Content>('content', ref.id);
        return [{ id: content.id, revision: content.revision, role: ref.role }];
      } catch {
        skippedAttachments.push(ref);
        return [];
      }
    });
    const bot = attachments.find((ref) => ref.role === 'bot');
    if (!bot) throw new HttpError(400, '채팅을 이어 쓸 봇이 필요해요.');
    const chat = store.createChat(title, { botId: bot.id });
    const profile = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      packageAttachments: attachments,
      image: profile.image,
    });
    const frozen = store.product.snapshot(chat.id);
    const branchId = store.product.branch(chat.id).id;
    const notesAt = (at: number | null, head: string | null) => {
      for (const [index, note] of transcript.notes.entries())
        if (note.atIndex === at)
          store.story.notes.write(chat.id, {
            text: note.text,
            author: note.author,
            kind: note.kind,
            ...(note.kind === 'imported-memory' ? { origin: note.origin } : {}),
            branchId,
            expectedRevision: store.story.notes.revision(chat.id),
            expectedHeadRevision: head,
            idempotencyKey: `import-note:${index}`,
          });
    };
    notesAt(null, null);
    let head: string | null = null;
    for (const [index, entry] of transcript.entries.entries()) {
      const { run } = store.createRunInTransaction(
        chat.id,
        {
          request: entry.request,
          expectedRevision: head,
          expectedSettingsRevision: chat.settingsRevision,
          idempotencyKey: `import-message:${index}`,
        },
        (state) =>
          ({
            chatId: chat.id,
            parentRevision: head,
            settingsRevision: state.settingsRevision,
            settings: state.settings,
            request: entry.request,
            history: [],
            resources: [],
            profile: frozen,
            transcriptImport: { index, storage: 'source-only-v1' },
          }) satisfies RunSnapshot
      );
      store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
      const source = store.completeRunInTransaction(
        run.id,
        entry.text,
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        run.snapshot.settings
      );
      head = source.id;
      if (entry.translation !== null) {
        const id = randomUUID(),
          time = new Date().toISOString();
        store.db
          .prepare(
            "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,generation,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',1,1,?,?)"
          )
          .run(id, chat.id, source.id, source.hash, time, time);
        store.db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(
          id,
          1,
          JSON.stringify({
            mock: false,
            manual: true,
            sourceRevision: source.id,
            sourceHash: source.hash,
            text: entry.translation,
          }),
          time
        );
        store.event(chat.id, 'job.completed', id);
      }
      notesAt(index, head);
    }
    store.db
      .prepare('INSERT INTO import_operations VALUES(?,?,?)')
      .run(key, digest, JSON.stringify({ chatId: chat.id, skippedAttachments }));
    store.event(chat.id, 'chat.imported', chat.id);
    return { chat: store.chat(chat.id), created: true, skippedAttachments };
  });
}
