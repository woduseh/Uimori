import { expect, type Page, type Request } from '@playwright/test';
import type { ResourceKind, ResourceSaveResult } from '../../core/resource-editing.js';
import type { Content } from '../../core/product.js';

export function isResourceSaveRequest(request: Pick<Request, 'url' | 'method'>): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/resources/save';
}
export async function waitForResourceSave(
  page: Page,
  kind: ResourceKind,
  targetId?: string
): Promise<ResourceSaveResult> {
  const response = await page.waitForResponse(
    (value) =>
      isResourceSaveRequest(value.request()) && value.request().postDataJSON().kind === kind
  );
  expect(response.ok(), await response.text()).toBe(true);
  const result = (await response.json()) as ResourceSaveResult;
  expect(result.saved.revision).toBeGreaterThan(0);
  if (targetId !== undefined)
    expect('id' in result.saved ? result.saved.id : 'current').toBe(targetId);
  return result;
}
export async function waitForContentSave(page: Page, targetId?: string): Promise<Content> {
  return (await waitForResourceSave(page, 'content', targetId)).saved as Content;
}
