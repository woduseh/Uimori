import { expect, test } from '@playwright/test';
import type { PromptWorkspace } from '../../core/product.js';

/** Restore global working settings at the test boundary, never on chat creation. */
export function preservePromptWorkspace() {
  let original: PromptWorkspace;
  let originalModels: { routes: unknown; translationPolicy: unknown };
  test.beforeEach(async ({ request }) => {
    const response = await request.get('/api/prompt-workspace');
    expect(response.ok()).toBe(true);
    original = await response.json();
    originalModels = await (await request.get('/api/model-workspace')).json();
  });
  test.afterEach(async ({ request, page }) => {
    // Drain synthetic response handlers before restoration emits fresh SSE requests.
    await page.unrouteAll({ behavior: 'wait' });
    if (!original) return;
    const current = (await (await request.get('/api/prompt-workspace')).json()) as PromptWorkspace;
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
        translationPolicy: originalModels.translationPolicy,
      },
    });
    expect(modelRestored.ok(), await modelRestored.text()).toBe(true);
  });
}
