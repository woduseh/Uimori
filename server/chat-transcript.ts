import { createHash, randomUUID } from 'node:crypto';
import {
  CHAT_TRANSCRIPT_FORMAT,
  CHAT_TRANSCRIPT_VERSION,
  validateChatTranscript,
  type ChatTranscript,
} from '../core/chat-transcript.js';
import type { ContentAttachment } from '../core/risu-content.js';
import type { Content, ContentRef } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { CHAT_TITLE_MAX_CHARS } from '../core/content-limits.js';
import { HttpError, fields, record, text } from './request-validation.js';
import { successfulTranslation } from './source-editing.js';
import type { Chat, Store } from './store.js';

const IMPORT_EVENT = 'chat.transcript-imported';
const IMPORT_RECEIPT_EVENT = 'chat.transcript-import-receipt';
const zeroUsage = { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null };

/** The authored history of one branch; runs, snapshots, state and attempts stay behind. */
export function exportChatTranscript(
  store: Store,
  chatId: string,
  branchId?: string
): ChatTranscript {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const history = store.history(branch.headRevision);
  const profile = store.product.profile(chatId);
  const entries = history.map((item) => {
    const source = store.source(item.revision);
    const translation = successfulTranslation(store, source);
    return {
      request: store.run(source.runId).request,
      text: item.text,
      translation: translation?.result?.text ?? null,
    };
  });
  const scope = store.story.notes.scope(chatId, branch.headRevision);
  const notes = store.story.notes.entries(scope).flatMap((note) => {
    const atIndex =
      note.atRevision === null
        ? null
        : history.findIndex((item) => item.revision === note.atRevision);
    return atIndex === -1 ? [] : [{ text: note.text, author: note.declaration.author, atIndex }];
  });
  return {
    format: CHAT_TRANSCRIPT_FORMAT,
    version: CHAT_TRANSCRIPT_VERSION,
    exportedAt: new Date().toISOString(),
    title: chat.title,
    packageAttachments: (profile.packageAttachments ?? []).map(({ id, revision, role }) => ({
      id,
      revision,
      role,
    })),
    notes,
    entries,
  };
}

export type ChatTranscriptImport = {
  chat: Chat;
  created: boolean;
  /** References the transcript named that this library no longer has; the chat was created without them. */
  skippedAttachments: (ContentRef | ContentAttachment)[];
};

/**
 * Creates a new chat whose history is the transcript's entries as authored sources. Each entry is a
 * completed run with zero usage, so readers, fork and archive treat it like any other turn. The
 * owning bot must exist in this library; other missing references are dropped and reported.
 */
export function importChatTranscript(store: Store, value: unknown): ChatTranscriptImport {
  const body = record(value);
  fields(body, ['transcript', 'title', 'idempotencyKey']);
  const key = text(body.idempotencyKey, 'request key', 120);
  let transcript: ChatTranscript;
  try {
    transcript = validateChatTranscript(body.transcript);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'CHAT_TRANSCRIPT_INVALID');
  }
  const title =
    body.title === undefined ? transcript.title : text(body.title, 'title', CHAT_TITLE_MAX_CHARS);
  // Validation reconstructs every object in a fixed order. Export time and the overridden file
  // title do not affect the imported chat; references are bound before current-library lookup.
  const digest = createHash('sha256')
    .update(JSON.stringify({ ...transcript, exportedAt: undefined, title }))
    .digest('hex');
  return store.transaction(() => {
    const prior = store.db
      .prepare('SELECT chat_id FROM events WHERE kind=? AND entity_id=?')
      .get(IMPORT_EVENT, key) as { chat_id: string } | undefined;
    if (prior) {
      const row = store.db
        .prepare('SELECT entity_id FROM events WHERE kind=? AND chat_id=?')
        .get(IMPORT_RECEIPT_EVENT, prior.chat_id) as { entity_id: string } | undefined;
      let receipt: {
        requestKey: string;
        digest: string;
        skippedAttachments: ChatTranscriptImport['skippedAttachments'];
      } | null;
      try {
        receipt = row ? JSON.parse(row.entity_id) : null;
      } catch {
        receipt = null;
      }
      // Old key-only events cannot prove request equality. Never reconstruct it from a chat
      // whose title, sources, notes or references may have been edited since the import.
      if (
        receipt?.requestKey !== key ||
        typeof receipt.digest !== 'string' ||
        !Array.isArray(receipt.skippedAttachments)
      )
        throw new HttpError(409, 'CHAT_TRANSCRIPT_IMPORT_UNVERIFIABLE');
      if (receipt.digest !== digest) throw new HttpError(409, 'CHAT_TRANSCRIPT_IMPORT_CONFLICT');
      return {
        chat: store.chat(prior.chat_id),
        created: false,
        skippedAttachments: receipt.skippedAttachments,
      };
    }
    const skippedAttachments: ChatTranscriptImport['skippedAttachments'] = [];
    const current = (reference: ContentRef): Content | null => {
      try {
        return store.product.get<Content>('content', reference.id);
      } catch {
        return null;
      }
    };
    const packageAttachments = transcript.packageAttachments.flatMap((reference) => {
      const content = current(reference);
      if (content?.package)
        return [{ id: content.id, revision: content.revision, role: reference.role }];
      skippedAttachments.push(reference);
      return [];
    });
    const bot = packageAttachments.find((reference) => reference.role === 'bot');
    if (!bot) throw new HttpError(400, 'CHAT_TRANSCRIPT_BOT_REQUIRED');
    const chat = store.createChat(title, 'calm', { botId: bot.id });
    const id = chat.id;
    const branchId = `main:${id}`;
    const profile = store.product.profile(id);
    store.product.updateProfile(id, {
      expectedRevision: profile.revision,
      packageAttachments,
      image: profile.image,
    });
    const notesAt = (index: number | null, head: string | null) => {
      for (const [position, note] of transcript.notes.entries()) {
        if (note.atIndex !== index) continue;
        store.story.notes.write(id, {
          text: note.text,
          author: note.author,
          branchId,
          expectedRevision: store.story.notes.revision(id),
          expectedHeadRevision: head,
          idempotencyKey: `transcript-note:${position}`,
        });
      }
    };
    notesAt(null, null);
    for (const [index, entry] of transcript.entries.entries()) {
      const frozen = store.product.snapshot(id);
      const { run } = store.createRunInTransaction(
        id,
        {
          request: entry.request,
          expectedRevision: store.product.branch(id, branchId).headRevision,
          expectedSettingsRevision: store.chat(id).settingsRevision,
          idempotencyKey: `transcript:${index}`,
        },
        (state): RunSnapshot => ({
          chatId: id,
          parentRevision: state.headRevision,
          settingsRevision: state.settingsRevision,
          settings: state.settings,
          request: entry.request,
          history: [],
          resources: store.product.resources(id, frozen),
          profile: frozen,
          transcriptImport: { index, storage: 'source-only-v1' },
        })
      );
      // No queue worker can observe an imported run before its exact source commits.
      store.db
        .prepare("UPDATE runs SET status='running' WHERE id=? AND status='queued'")
        .run(run.id);
      const source = store.completeRunInTransaction(
        run.id,
        entry.text,
        zeroUsage,
        run.snapshot.settings
      );
      if (entry.translation !== null) {
        const jobId = randomUUID();
        const time = new Date().toISOString();
        store.db
          .prepare(
            "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,generation,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',1,1,?,?)"
          )
          .run(jobId, id, source.id, source.hash, time, time);
        store.db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(
          jobId,
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
        store.event(id, 'job.completed', jobId);
      }
      notesAt(index, source.id);
    }
    store.event(id, IMPORT_EVENT, key);
    store.event(
      id,
      IMPORT_RECEIPT_EVENT,
      JSON.stringify({ requestKey: key, digest, skippedAttachments })
    );
    return { chat: store.chat(id), created: true, skippedAttachments };
  });
}
