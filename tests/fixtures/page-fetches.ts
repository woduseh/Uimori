import type { Page } from '@playwright/test';

type TrackedFetch = { method: string; path: string; settled: boolean; continuationsRan: boolean };
type TrackedWindow = Window & { trackedFetches: TrackedFetch[] };

export async function trackPageFetches(page: Page, pattern: RegExp) {
  await page.addInitScript(
    ({ source, flags }) => {
      const pattern = new RegExp(source, flags);
      const fetches: TrackedFetch[] = [];
      Object.assign(window, { trackedFetches: fetches });
      const original = window.fetch;
      const postTask = (task: () => void) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          task();
        };
        channel.port2.postMessage(null);
      };
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url, location.href).pathname;
        if (!pattern.test(path)) return original(input, init);
        const method = (
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase();
        const entry = { method, path, settled: false, continuationsRan: false };
        fetches.push(entry);
        return original(input, init).then(
          (response) => {
            entry.settled = true;
            const json = response.json.bind(response);
            response.json = () =>
              json().finally(() =>
                postTask(() => {
                  entry.continuationsRan = true;
                })
              );
            return response;
          },
          (error) => {
            entry.settled = true;
            throw error;
          }
        );
      };
    },
    { source: pattern.source, flags: pattern.flags }
  );
  const read = () =>
    page.evaluate(() =>
      (window as unknown as TrackedWindow).trackedFetches.map((item) => ({ ...item }))
    );
  return {
    list: read,
    count: async (method?: string) =>
      (await read()).filter((item) => !method || item.method === method).length,
    inFlight: async () => (await read()).filter((item) => !item.settled).length,
  };
}
