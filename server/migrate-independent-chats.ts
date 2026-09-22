import { independentTextMedia } from './chat-media.js';
import { randomUUID } from 'node:crypto';
import { captureChatCopy, restoreChatCopy } from './chat-copy.js';
import { chatDeletionImpact, deleteChat } from './chat-deletion.js';
import { settleSnapshot } from './execution-snapshot.js';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';

type Row = Record<string, any>;

/** One-time transfer for the retired shared-branch graph. New chat IDs are intentional.
 * Every branch becomes a complete independent chat. User text, pending requests, helper
 * conversations, variables, images and authoring survive; replay diagnostics do not.
 */
export function migrateIndependentChats(store: Store): void {
  const db = store.db;
  const owners = db
    .prepare('SELECT chat_id FROM branches GROUP BY chat_id HAVING COUNT(*)>1')
    .all();
  const mapping: { original: string; chats: string[] }[] = [];
  for (const owner of owners) {
    const chat = store.chat(String(owner.chat_id)),
      branches = store.product.branches(chat.id);
    // Capture all graphs before removing any old ownership rows.
    const copies = branches.map((branch) => ({
      branch,
      copy: captureChatCopy(store, chat.id, branch.id),
    }));
    const destinations: string[] = [];
    for (const { branch, copy } of copies) {
      const next = restoreChatCopy(
        store,
        copy,
        `schema4:${branch.id}`,
        branch.default ? chat.title : `${chat.title} · ${branch.title}`
      );
      destinations.push(next.id);
      const target = store.product.branch(next.id),
        history = store.history(target.headRevision);
      const sourceIds = new Map(
        (copy.state.messages ?? []).map((item, index) => [item.sourceId, history[index].revision])
      );
      db.prepare('UPDATE chat_organization SET folder_id=?,sort_position=? WHERE chat_id=?').run(
        chat.folderId ?? null,
        chat.sortPosition ?? 0,
        next.id
      );
      db.prepare('UPDATE chats SET created_at=? WHERE id=?').run(chat.createdAt, next.id);
      const pending = db
        .prepare('SELECT body FROM chat_option_pending WHERE chat_id=? AND branch_id=?')
        .get(chat.id, branch.id);
      if (pending) {
        const value = {
          ...JSON.parse(String(pending.body)),
          id: randomUUID(),
          chatId: next.id,
          branchId: target.id,
        };
        db.prepare('INSERT INTO chat_option_pending VALUES(?,?,?,?)').run(
          value.id,
          next.id,
          target.id,
          JSON.stringify(value)
        );
      }
      // A saved but unanswered request remains retryable in its new chat, without restarting a provider.
      for (const row of db
        .prepare('SELECT * FROM runs WHERE chat_id=? AND branch_id=? AND source_revision IS NULL')
        .all(chat.id, branch.id) as Row[]) {
        const id = randomUUID(),
          parent = sourceIds.get(row.parent_revision) ?? target.headRevision;
        const snapshot = settleSnapshot({
          ...JSON.parse(row.snapshot),
          chatId: next.id,
          branchId: target.id,
          parentRevision: parent,
          history: [],
          resources: [],
          profile: store.product.snapshot(next.id, 'inspect', parent),
        } as RunSnapshot);
        db.prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,error,usage,created_at,updated_at,branch_id,partial_text)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id,
          next.id,
          parent,
          ['queued', 'running'].includes(row.status) ? 'interrupted' : row.status,
          row.request,
          JSON.stringify(snapshot),
          `migrated:${row.id}`,
          '{}',
          row.error,
          row.usage,
          row.created_at,
          row.updated_at,
          target.id,
          row.partial_text
        );
      }
      for (const row of db
        .prepare(
          'SELECT label,request FROM scene_commands WHERE chat_id=? AND branch_id=? AND source_revision IS NULL'
        )
        .all(chat.id, branch.id))
        store.story.createCommand(next.id, {
          label: row.label,
          request: row.request,
          branchId: target.id,
          idempotencyKey: randomUUID(),
        });
      for (const row of db
        .prepare(
          'SELECT id FROM helper_conversations WHERE chat_id=? AND (branch_id=? OR (branch_id IS NULL AND ?))'
        )
        .all(chat.id, branch.id, Number(branch.default))) {
        const scope = { kind: 'chat', chatId: next.id, branchId: target.id },
          json = JSON.stringify(scope);
        db.prepare(
          'UPDATE helper_conversations SET chat_id=?,branch_id=?,scope=?,scope_key=? WHERE id=?'
        ).run(next.id, target.id, json, json, row.id);
        db.prepare(`UPDATE helper_tasks SET snapshot=json_set(snapshot,'$.scope',json(?)),
          status=CASE WHEN status IN ('queued','running') THEN 'interrupted' ELSE status END WHERE conversation_id=?`).run(
          json,
          row.id
        );
        for (const task of db
          .prepare('SELECT id,snapshot FROM helper_tasks WHERE conversation_id=?')
          .all(row.id)) {
          const snapshot = JSON.parse(String(task.snapshot));
          const selected = snapshot.selection && sourceIds.get(snapshot.selection.sourceId);
          if (selected) {
            snapshot.selection.sourceId = selected;
            snapshot.selection.sourceHash = store.source(selected).hash;
          }
          if (snapshot.writing) {
            delete snapshot.writing;
            // Explicit helper retries construct a fresh writing input in the moved conversation.
          }
          db.prepare('UPDATE helper_tasks SET snapshot=? WHERE id=?').run(
            JSON.stringify(snapshot),
            task.id
          );
        }
        db.prepare(
          `UPDATE attempts SET chat_id=?,status=CASE WHEN status='running' THEN 'interrupted' ELSE status END WHERE id IN (SELECT a.attempt_id FROM helper_task_attempts a JOIN helper_tasks t ON t.id=a.task_id WHERE t.conversation_id=?)`
        ).run(next.id, row.id);
        for (const table of ['helper_messages', 'helper_artifacts'])
          for (const text of db
            .prepare(`SELECT rowid,text FROM ${table} WHERE conversation_id=?`)
            .all(row.id)) {
            const independent = independentTextMedia(store, String(text.text));
            if (independent !== text.text)
              db.prepare(`UPDATE ${table} SET text=? WHERE rowid=?`).run(independent, text.rowid);
          }
        db.prepare('UPDATE context_heads SET chat_id=? WHERE scope_key=?').run(
          next.id,
          `helper:${row.id}`
        );
        db.prepare('UPDATE context_checkpoints SET chat_id=? WHERE scope_key=?').run(
          next.id,
          `helper:${row.id}`
        );
      }
      if (branch.default) {
        // Preserve even unused catalog images; only the deleted owner changes.
        db.prepare(
          "UPDATE assets SET chat_id=?,body=json_set(body,'$.chatId',?) WHERE chat_id=?"
        ).run(next.id, next.id, chat.id);
      }
      const themes = db
        .prepare("SELECT value FROM app_metadata WHERE key='theme-preferences'")
        .get();
      if (themes) {
        const value = JSON.parse(String(themes.value));
        if (value.chatThemes?.[chat.id]) value.chatThemes[next.id] = value.chatThemes[chat.id];
        db.prepare("UPDATE app_metadata SET value=? WHERE key='theme-preferences'").run(
          JSON.stringify(value)
        );
      }
    }
    // No old process survives reopening this exclusively owned DB. Do not replay its tasks.
    for (const table of ['runs', 'jobs', 'context_jobs', 'illustration_jobs', 'attempts'])
      db.prepare(
        `UPDATE ${table} SET status='interrupted' WHERE chat_id=? AND status IN ('queued','running')`
      ).run(chat.id);
    deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
    mapping.push({ original: chat.id, chats: destinations });
  }
  if (mapping.length)
    db.prepare('INSERT OR REPLACE INTO app_metadata VALUES(?,?)').run(
      'schema4-independent-chats',
      JSON.stringify(mapping)
    );
}
