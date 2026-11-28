import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { StoryGuideUpdate } from '#contracts';
import {
  defaultStoryGuideConfig,
  normalizeStoryGuideConfig,
  type StoryGuideBrief,
  type StoryGuideConfig,
  type StoryGuideDetail,
  type StoryGuideState,
} from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import { AppError } from './app-errors.js';
import type { Store } from './store.js';
import { assertTx, type Tx } from './tx.js';

export function initStoryGuide(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_story_guides(
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    config TEXT NOT NULL,
    brief TEXT
  )`);
}

export class StoryGuideStore {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

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

  detail(chatId: string): StoryGuideDetail {
    const state = this.get(chatId);
    const writerIncludesGuide = `a.job_id IS NULL AND a.usage_kind='writing' AND
      json_extract(a.request,'$.requestReceipt.storyGuide.status')='included'`;
    const last = this.store.db
      .prepare(
        `SELECT r.status,COALESCE(json_extract(r.snapshot,'$.storyGuideReceipt'),
          json_extract(r.snapshot,'$.storyGuide')) AS guide,
          EXISTS (SELECT 1 FROM attempts a WHERE a.run_id=r.id AND ${writerIncludesGuide}) AS used
          FROM runs r WHERE r.chat_id=? ORDER BY r.rowid DESC LIMIT 1`
      )
      .get(chatId);
    const guide = last?.guide
      ? (JSON.parse(String(last.guide)) as RunSnapshot['storyGuideReceipt'])
      : undefined;
    const lastWithBrief = this.store.db
      .prepare(
        `SELECT COALESCE(json_extract(r.snapshot,'$.storyGuideReceipt.brief'),json_extract(r.snapshot,'$.storyGuide.brief')) AS brief
          FROM attempts a JOIN runs r ON r.id=a.run_id WHERE r.chat_id=? AND (
            json_type(r.snapshot,'$.storyGuideReceipt.brief')='object' OR
            json_type(r.snapshot,'$.storyGuide.brief')='object'
          ) AND ${writerIncludesGuide} ORDER BY r.rowid DESC LIMIT 1`
      )
      .get(chatId);
    return {
      ...state,
      brief: lastWithBrief
        ? (JSON.parse(String(lastWithBrief.brief)) as StoryGuideDetail['brief'])
        : null,
      ...(guide
        ? {
            latestRun: {
              status: String(last!.status),
              used: !!guide.brief && last!.used === 1,
              ...(guide.error ? { error: guide.error } : {}),
            },
          }
        : {}),
    };
  }

  private writeRow(chatId: string, revision: number, config: StoryGuideConfig): StoryGuideState {
    this.store.db
      .prepare(`INSERT INTO chat_story_guides(chat_id,revision,config,brief) VALUES(?,?,?,NULL)
        ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,config=excluded.config`)
      .run(chatId, revision, JSON.stringify(config));
    this.store.event(chatId, 'story-guide.updated', chatId);
    return this.get(chatId);
  }

  save(tx: Tx, chatId: string, revision: number, config: StoryGuideConfig): StoryGuideState {
    assertTx(tx, this.store.db);
    return this.writeRow(chatId, revision, config);
  }

  update(chatId: string, { expectedRevision, config }: StoryGuideUpdate): StoryGuideState {
    return this.store.transaction(() => {
      this.store.writableChat(chatId);
      const current = this.get(chatId);
      if (current.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
      if (isDeepStrictEqual(current.config, config)) return current;
      return this.writeRow(chatId, current.revision + 1, config);
    });
  }

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
