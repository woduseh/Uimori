import { expect, test } from '@playwright/test';
import type { PromptWorkspace } from '../../core/product.js';

/** Restore global working settings at the test boundary, never on chat creation. */
export function preservePromptWorkspace() {
  let original: PromptWorkspace;
  test.beforeEach(async ({ request }) => {
    const response = await request.get('/api/prompt-workspace');
    expect(response.ok()).toBe(true);
    original = await response.json();
  });
  test.afterEach(async ({ request }) => {
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
  });
}
