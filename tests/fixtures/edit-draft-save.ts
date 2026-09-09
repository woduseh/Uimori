import { expect, type Page, type Request } from '@playwright/test';
import type { DraftSaveResult, EditDraftKind } from '../../core/edit-drafts.js';
import type { Content } from '../../core/product.js';

export function isEditDraftSaveRequest(request: Pick<Request, 'url' | 'method'>): boolean {
  return (
    request.method() === 'POST' &&
    /^\/api\/edit-drafts\/[^/]+\/save$/u.test(new URL(request.url()).pathname)
  );
}
/** Opening/synchronizing a shared buffer does not save its library target. Other writes remain observable. */
export function isEditDraftBufferRequest(request: Pick<Request, 'url' | 'method'>): boolean {
  const path = new URL(request.url()).pathname;
  return (
    (request.method() === 'POST' && path === '/api/edit-drafts') ||
    (request.method() === 'PATCH' && /^\/api\/edit-drafts\/[^/]+$/u.test(path))
  );
}
/** Start before the UI action. Assert the saved receipt and target instead of waiting for the retired editor transport. */
export async function waitForEditDraftSave(
  page: Page,
  kind: EditDraftKind,
  targetId?: string
): Promise<DraftSaveResult> {
  const response = await page.waitForResponse((value) => isEditDraftSaveRequest(value.request()));
  expect(response.ok(), await response.text()).toBe(true);
  const result = (await response.json()) as DraftSaveResult;
  expect(result.status).toBe('saved');
  expect(result.draft.kind).toBe(kind);
  expect(result.draft.targetId).toBe('id' in result.saved ? result.saved.id : 'current');
  if (targetId !== undefined) expect(result.draft.targetId).toBe(targetId);
  expect(result.operationId).toBe(response.request().postDataJSON().operationId);
  return result;
}
export async function waitForContentDraftSave(page: Page, targetId?: string): Promise<Content> {
  return (await waitForEditDraftSave(page, 'content', targetId)).saved as Content;
}
