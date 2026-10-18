import type { DatabaseSync } from 'node:sqlite';
import {
  defaultStoryGuideConfig,
  normalizeStoryGuideConfig,
  type StoryGuideBrief,
  type StoryGuideState,
} from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import { fields, HttpError, number, record } from './request-validation.js';
import type { Store } from './store.js';

/** Additive within the current personal format; existing chats need no eager rows. */
export function initStoryGuide(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_story_guides(
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    config TEXT NOT NULL,
    brief TEXT
  )`);
}

export class StoryGuideStore {
  constructor(readonly store: Store) {}

  get(chatId: string): StoryGuideState {
    this.store.chat(chatId);
    const row = this.store.db
      .prepare('SELECT revision,config,brief FROM chat_story_guides WHERE chat_id=?')
      .get(chatId);
    return row
      ? {
          revision: Number(row.revision),
          config: normalizeStoryGuideConfig(JSON.parse(String(row.config))),
          brief: row.brief === null ? null : (JSON.parse(String(row.brief)) as StoryGuideBrief),
        }
      : { revision: 0, config: defaultStoryGuideConfig(), brief: null };
  }

  update(chatId: string, value: unknown): StoryGuideState {
    const body = record(value);
    fields(body, ['expectedRevision', 'config']);
    const expectedRevision = number(body.expectedRevision, 'story guide revision', 0);
    const config = normalizeStoryGuideConfig(body.config);
    return this.store.transaction(() => {
      const current = this.get(chatId);
      if (current.revision !== expectedRevision)
        throw new HttpError(409, '원작·인물 참고 설정이 바뀌었어요. 다시 읽어 주세요.');
      if (JSON.stringify(current.config) === JSON.stringify(config)) return current;
      this.store.db
        .prepare(`INSERT INTO chat_story_guides(chat_id,revision,config,brief) VALUES(?,?,?,NULL)
          ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,config=excluded.config`)
        .run(chatId, current.revision + 1, JSON.stringify(config));
      this.store.event(chatId, 'story-guide.updated', chatId);
      return this.get(chatId);
    });
  }

  /** Only a still-current writer may publish the last automatically generated brief. */
  saveBrief(chatId: string, brief: StoryGuideBrief): boolean {
    if (!brief.runId) return false;
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          "SELECT parent_revision,snapshot FROM runs WHERE id=? AND chat_id=? AND status IN ('queued','running')"
        )
        .get(brief.runId!, chatId);
      if (!row || row.parent_revision !== brief.parentRevision) return false;
      const snapshot = JSON.parse(String(row.snapshot)) as RunSnapshot;
      const current = this.get(chatId);
      if (
        !current.config.enabled ||
        current.revision !== brief.configRevision ||
        snapshot.storyGuide?.revision !== brief.configRevision
      )
        return false;
      const replacement = snapshot.replacement;
      const expectedHead = replacement?.sourceRevision ?? brief.parentRevision;
      if (this.store.chat(chatId).headRevision !== expectedHead) return false;
      const expectedHash =
        replacement?.sourceHash ??
        snapshot.history.find((source) => source.revision === expectedHead)?.contentHash;
      if (expectedHead && expectedHash && this.store.source(expectedHead).hash !== expectedHash)
        return false;
      this.store.db
        .prepare('UPDATE chat_story_guides SET brief=? WHERE chat_id=?')
        .run(JSON.stringify(brief), chatId);
      this.store.event(chatId, 'story-guide.generated', brief.runId!);
      return true;
    });
  }
}
