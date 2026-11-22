import type { DatabaseSync } from 'node:sqlite';

type Target = { kind: string; id: string };

const HELD = `kind='confirmation.required' AND json_valid(data) AND json_type(data,'$.arguments') IS NOT NULL`;
const GRANTED = `json_valid(t.snapshot) AND EXISTS (SELECT 1 FROM json_each(t.snapshot,'$.confirmations') c
  WHERE json_type(c.value,'$.arguments') IS NOT NULL)`;

function releaseGrants(db: DatabaseSync, where: string, values: string[], ids?: Set<string>) {
  const update = db.prepare('UPDATE helper_tasks SET snapshot=? WHERE id=?');
  for (const row of db
    .prepare(`SELECT t.id,t.snapshot FROM helper_tasks t WHERE ${GRANTED} AND (${where})`)
    .all(...values)) {
    const snapshot = JSON.parse(String(row.snapshot)) as {
      confirmations: { id: string; arguments?: unknown }[];
    };
    const released = (call: { id: string; arguments?: unknown }) =>
      call.arguments !== undefined && (!ids || ids.has(call.id));
    if (!snapshot.confirmations.some(released)) continue;
    snapshot.confirmations = snapshot.confirmations.map((call) => {
      if (!released(call)) return call;
      const { arguments: _arguments, ...rest } = call;
      return rest;
    });
    update.run(JSON.stringify(snapshot), String(row.id));
  }
}

export function redactHelperArgumentPreviews(
  db: DatabaseSync,
  chatId: string,
  sceneIds: Iterable<string>,
  preview: string
) {
  db.prepare(`UPDATE helper_events SET data=json_set(data,'$.argsPreview',?,'$.argsRedacted',json('true'))
    WHERE kind='tool.started' AND json_type(data,'$.argsPreview')='text'
      AND (conversation_id IN (SELECT id FROM helper_conversations WHERE chat_id=?)
        OR json_extract(data,'$.chatId')=?
        OR (json_extract(data,'$.target.kind')='scene'
          AND json_extract(data,'$.target.id') IN (SELECT value FROM json_each(?))))`).run(
    preview,
    chatId,
    chatId,
    JSON.stringify([...sceneIds])
  );
}

export function releaseHelperConfirmationArguments(db: DatabaseSync, conversationId?: string) {
  const scoped = conversationId ? 'AND t.conversation_id=?' : '';
  const values = conversationId ? [conversationId] : [];
  db.prepare(`UPDATE helper_events SET data=json_remove(data,'$.arguments') WHERE ${HELD}
    AND task_id IN (SELECT t.id FROM helper_tasks t WHERE EXISTS (SELECT 1 FROM helper_tasks later
      WHERE later.conversation_id=t.conversation_id AND later.rowid>t.rowid) ${scoped})`).run(
    ...values
  );
  releaseGrants(
    db,
    `(t.status='completed' OR EXISTS (SELECT 1 FROM helper_tasks later
      WHERE later.conversation_id=t.conversation_id AND later.rowid>t.rowid
        AND COALESCE(json_extract(later.snapshot,'$.requestGroupId'),later.id)=COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id))) ${scoped}`,
    values
  );
}

export function forgetHelperConfirmationTargets(
  db: DatabaseSync,
  targets: readonly Target[],
  chatId?: string
) {
  const keys = JSON.stringify(targets.map((target) => `${target.kind}:${target.id}`));
  const where = `${HELD} AND (json_extract(data,'$.chatId')=? OR EXISTS (SELECT 1 FROM json_each(data,'$.targets') target
    WHERE json_extract(target.value,'$.kind')||':'||json_extract(target.value,'$.id') IN (SELECT value FROM json_each(?))))`;
  const held = db
    .prepare(
      `SELECT conversation_id AS conversationId,json_extract(data,'$.id') AS id FROM helper_events WHERE ${where}`
    )
    .all(chatId ?? null, keys);
  if (!held.length) return;
  db.prepare(`UPDATE helper_events SET data=json_remove(data,'$.arguments') WHERE ${where}`).run(
    chatId ?? null,
    keys
  );
  const byConversation = new Map<string, Set<string>>();
  for (const row of held) {
    const ids = byConversation.get(String(row.conversationId)) ?? new Set<string>();
    ids.add(String(row.id));
    byConversation.set(String(row.conversationId), ids);
  }
  for (const [conversationId, ids] of byConversation)
    releaseGrants(db, 't.conversation_id=?', [conversationId], ids);
}
