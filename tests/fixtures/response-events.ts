import type { Route } from '@playwright/test';
import type { ResponseStreamPage } from '../../core/response-stream.js';

export const isResponseEvents = (route: Route) =>
  new URL(route.request().url()).pathname.endsWith('/events');

export function responseStreamCursor(route: Route) {
  const request = route.request();
  return Number(
    new URL(request.url()).searchParams.get('after') ?? request.headers()['last-event-id'] ?? 0
  );
}

export const pageAfter = (page: ResponseStreamPage, after: number): ResponseStreamPage => {
  const chunks = page.chunks.filter((chunk) => chunk.seq > after);
  return { ...page, chunks, cursor: chunks.at(-1)?.seq ?? after };
};

export const hasNews = (page: ResponseStreamPage) =>
  page.status !== 'running' || page.chunks.length > 0;

export async function fulfillResponseEvents(route: Route, page: ResponseStreamPage) {
  await route
    .fulfill({
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: `id: ${page.cursor}\ndata: ${JSON.stringify(page)}\n\n`,
    })
    .catch(() => {});
}

export async function waitForNews(
  route: Route,
  read: () => ResponseStreamPage | undefined,
  waitMs = 15000
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const page = read();
    if (!page || hasNews(page) || Date.now() > deadline || route.request().failure()) return page;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function serveResponseEvents(
  route: Route,
  read: (after: number) => ResponseStreamPage | undefined
) {
  const after = responseStreamCursor(route);
  const page = await waitForNews(route, () => read(after));
  if (!page)
    return route
      .fulfill({ status: 404, json: { error: 'Response stream not found' } })
      .catch(() => {});
  return fulfillResponseEvents(route, page);
}
