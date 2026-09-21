import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { test } from 'vitest';
import { Store } from '../server/store.js';
import { EditDraftService, editDraftRoutes } from '../server/edit-drafts.js';
import { decodeDraftSaveResult, type DraftSaveWire } from '../core/edit-draft-save-wire.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeDraftTitle } from './fixtures/native-content.js';

// Real HTTP routes + Store; no provider calls or production data.
for (const kind of ['bot', 'persona'] as const) {
  test(`single ${kind} save and undo responses retain replay, revisions and editor ownership`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uimori-save-api-'));
    const store = new Store(join(dir, 'test.sqlite'));
    const service = new EditDraftService(store),
      app = Fastify();
    editDraftRoutes(app, service);
    try {
      const input = { ...fixtureBotInput('Saved original', 'Body'), kind };
      const content = store.product.content(input);
      const authority = { requestId: 'setup', assert: () => {} };
      let draft = service.create(
        {
          editorKey: `content:${content.id}`,
          kind: 'content',
          targetId: content.id,
          model: input,
          operationId: randomUUID(),
        },
        authority
      );
      draft = service.patch(
        draft.id,
        {
          expectedRevision: draft.revision,
          operationId: randomUUID(),
          model: nativeDraftTitle(draft.model, 'Changed title'),
          rawFields: {},
          unappliedFields: [],
        },
        authority
      ).draft;
      const operationId = randomUUID();
      const payload = { operationId, expectedRevision: draft.revision };
      const url = `/api/edit-drafts/${draft.id}/save`;
      const conflict = await app.inject({
        method: 'POST',
        url,
        payload: {
          expectedRevision: draft.revision + 1,
          operationId: randomUUID(),
        },
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(service.get(draft.id).revision, draft.revision);
      const saved = await app.inject({ method: 'POST', url, payload });
      assert.equal(saved.statusCode, 200);
      const wire = saved.json<DraftSaveWire>();
      assert.equal(Object.hasOwn(wire.draft, 'model'), false);
      assert.equal(Object.hasOwn(wire.draft, 'baseModel'), false);
      assert.equal(Object.hasOwn(wire, 'format'), false);
      const decoded = decodeDraftSaveResult(wire);
      assert.deepEqual(decoded.draft.model, decoded.draft.baseModel);
      assert.notEqual(decoded.draft.model, decoded.draft.baseModel);
      const replay = await app.inject({ method: 'POST', url, payload });
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json(), wire);
      assert.equal(
        store.product.get<{ revision: number }>('content', content.id).revision,
        content.revision + 1
      );
      const probe = await app.inject({
        method: 'GET',
        url: `/api/edit-drafts/${draft.id}/revisions`,
      });
      assert.deepEqual(probe.json(), {
        revision: decoded.draft.revision,
        targetRevision: decoded.saved.revision,
      });

      const undoUrl = `/api/edit-drafts/${draft.id}/undo`;
      const undoPayload = {
        savedOperationId: operationId,
        expectedRevision: decoded.draft.revision,
        operationId: randomUUID(),
      };
      const undone = await app.inject({ method: 'POST', url: undoUrl, payload: undoPayload });
      assert.equal(undone.statusCode, 200);
      const undoWire = undone.json<DraftSaveWire>();
      assert.equal(Object.hasOwn(undoWire.draft, 'model'), false);
      assert.equal(Object.hasOwn(undoWire.draft, 'baseModel'), false);
      const restored = decodeDraftSaveResult(undoWire);
      assert.equal('title' in restored.saved ? restored.saved.title : null, content.title);
      const undoReplay = await app.inject({ method: 'POST', url: undoUrl, payload: undoPayload });
      assert.equal(undoReplay.statusCode, 200);
      assert.deepEqual(undoReplay.json(), undoWire);
      assert.equal(
        store.product.get<{ revision: number }>('content', content.id).revision,
        content.revision + 2
      );

      // Rebase returns an EditDraft, not a save receipt, and must not use the save codec.
      const rebased = await app.inject({
        method: 'POST',
        url: `/api/edit-drafts/${draft.id}/rebase`,
        payload: {
          expectedRevision: restored.draft.revision,
          expectedTargetRevision: restored.saved.revision,
          mode: 'pristine',
          operationId: randomUUID(),
        },
      });
      assert.equal(rebased.statusCode, 200);
      assert.deepEqual(rebased.json().model, restored.draft.model);
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/edit-drafts/missing/revisions' })).statusCode,
        404
      );
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
