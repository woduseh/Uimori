import type { Page } from '@playwright/test';

export async function requestFullRunResponses(page: Page): Promise<void> {
  await page.route(
    /\/api\/(?:chats\/[^/]+\/runs|runs\/[^/]+\/(?:retry|rejudge|candidate))$/u,
    (route) => {
      const { prefer: _prefer, ...headers } = route.request().headers();
      return route.continue({ headers });
    }
  );
}
