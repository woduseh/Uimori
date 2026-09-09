import { expect, test, type APIRequestContext } from '@playwright/test';
import type { ModelWorkspace, PromptWorkspace, PromptPreset } from '../../core/product.js';
import type { EditDraft } from '../../core/edit-drafts.js';

/** Shared synthetic drafts now survive browser contexts; test boundaries explicitly discard them. */
async function discardSharedPromptDrafts(request: APIRequestContext) {
  const keys = [
    'prompt-workspace:current',
    'new:prompt-preset:main:builtin',
    'new:prompt-preset:main:new',
    'new:prompt-preset:translation:builtin',
    'new:prompt-preset:translation:new',
  ];
  for (const editorKey of keys) {
    const listed = await request.get(`/api/edit-drafts?editorKey=${encodeURIComponent(editorKey)}`);
    expect(listed.ok(), await listed.text()).toBe(true);
    for (const draft of (await listed.json()) as EditDraft[]) {
      expect(draft.editorKey).toBe(editorKey);
      expect(draft.targetId).toBe(editorKey === 'prompt-workspace:current' ? 'current' : null);
      const discarded = await request.delete(`/api/edit-drafts/${draft.id}`, {
        data: { expectedRevision: draft.revision, operationId: crypto.randomUUID() },
      });
      expect(discarded.ok(), await discarded.text()).toBe(true);
    }
  }
}

export function isolatePromptDrafts() {
  test.beforeEach(async ({ request }) => discardSharedPromptDrafts(request));
}

/** Restore global working settings at the test boundary, never on chat creation. */
export function preservePromptWorkspace() {
  isolatePromptDrafts();
  let original: PromptWorkspace | undefined;
  let originalModels: ModelWorkspace | undefined;
  test.beforeEach(async ({ request }) => {
    original = undefined;
    originalModels = undefined;
    const response = await request.get('/api/prompt-workspace');
    expect(response.ok()).toBe(true);
    let baseline = (await response.json()) as PromptWorkspace;
    // Give anonymous fixture working copies a restorable owner through public APIs.
    // Once established, later cases reuse that owner; user-facing PUT never gains reset authority.
    for (const role of ['main', 'translation'] as const) {
      if (baseline[role].presetId) continue;
      const saved = baseline[role];
      const created = await request.post('/api/prompt-presets', {
        data: {
          title: `검증 기준 프롬프트 · ${role}`,
          role,
          program: saved.program,
          values: saved.values,
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const preset = (await created.json()) as PromptPreset;
      const applied = await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: baseline.revision, role, presetId: preset.id },
      });
      expect(applied.ok(), await applied.text()).toBe(true);
      baseline = (await applied.json()) as PromptWorkspace;
      const restored = await request.put('/api/prompt-workspace', {
        data: { expectedRevision: baseline.revision, [role]: { ...saved, presetId: preset.id } },
      });
      expect(restored.ok(), await restored.text()).toBe(true);
      baseline = (await restored.json()) as PromptWorkspace;
    }
    original = baseline;
    originalModels = await (await request.get('/api/model-workspace')).json();
  });
  test.afterEach(async ({ request, page }) => {
    // Drain synthetic response handlers before restoration emits fresh SSE requests.
    await page.unrouteAll({ behavior: 'wait' });
    if (!original || !originalModels) return;
    let current = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
    for (const role of ['main', 'translation'] as const) {
      if (current[role].presetId === original[role].presetId) continue;
      const applied = await request.post('/api/prompt-workspace/apply', {
        data: { expectedRevision: current.revision, role, presetId: original[role].presetId },
      });
      expect(applied.ok(), await applied.text()).toBe(true);
      current = (await applied.json()) as PromptWorkspace;
    }
    const restored = await request.put('/api/prompt-workspace', {
      data: {
        expectedRevision: current.revision,
        main: original.main,
        translation: original.translation,
        translationPolicy: original.translationPolicy,
      },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
    const modelCurrent = await (await request.get('/api/model-workspace')).json();
    const modelRestored = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: modelCurrent.revision,
        routes: originalModels.routes,
        titleModel: originalModels.titleModel ?? null,
        helperModel: originalModels.helperModel ?? null,
        contextModel: originalModels.contextModel ?? null,
        translationPolicy: originalModels.translationPolicy,
      },
    });
    expect(modelRestored.ok(), await modelRestored.text()).toBe(true);
  });
}
