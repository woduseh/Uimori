import type { Page } from '@playwright/test';

/**
 * The app asks run admissions for a receipt (`Prefer: return=minimal`). A spec that inspects the
 * frozen input in the app's own admission response asks for the full run instead.
 */
export async function requestFullRunResponses(page: Page): Promise<void> {
  await page.route(
    /\/api\/(?:chats\/[^/]+\/runs|runs\/[^/]+\/(?:retry|rejudge|candidate))$/u,
    (route) => {
      const { prefer: _prefer, ...headers } = route.request().headers();
      return route.continue({ headers });
    }
  );
}
