import { vi } from 'vitest';
import { JEV_ENDPOINT } from '../../server/jev-judgment.js';

/** Deterministic transport fixture. All judgment calls are intercepted before network access. */
export function installJevFixture() {
  vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-jev-test-key');
  const requests: Record<string, any>[] = [];
  const fallback = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (url !== JEV_ENDPOINT) return fallback(url, init);
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return new Response(
      JSON.stringify({
        model: 'jev-latest',
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([key, raw]) => {
            const question = raw as { type: string; criteria?: Record<string, unknown> };
            if (question.type === 'choice') {
              const choices = Object.keys(question.criteria!);
              const choice = choices.includes('none') ? 'none' : choices[0];
              return [
                key,
                {
                  type: 'choice',
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    choices.map((option) => [option, option === choice ? 1 : 0])
                  ),
                },
              ];
            }
            return [key, { type: 'noul', noul: key === 'explicitRefusal' ? 0.01 : 0.99 }];
          })
        ),
        usage: { input_tokens: 7, output_tokens: 3 },
      })
    );
  });
  return requests;
}
