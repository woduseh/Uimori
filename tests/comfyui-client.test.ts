import { afterEach, describe, expect, test } from 'vitest';
import {
  cancelComfyUIPrompt,
  comfyUISystemStats,
  comfyUIUrl,
  fetchComfyUIResult,
  generateWithComfyUI,
  validateComfyBaseUrl,
} from '../server/comfyui-client.js';
import { fillComfyWorkflow, parseComfyWorkflow, IllustrationError } from '../core/illustration.js';
import { comfyUIFixture, FIXTURE_PNG, FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(options: Parameters<typeof comfyUIFixture>[0] = {}) {
  const server = await comfyUIFixture(options);
  cleanups.push(server.close);
  return server;
}
const workflow = () =>
  fillComfyWorkflow(parseComfyWorkflow(FIXTURE_WORKFLOW), {
    prompt: 'lantern over a river',
    negativePrompt: 'lowres',
    seed: 7,
  });
const signal = () => new AbortController().signal;
async function failure(promise: Promise<unknown>): Promise<IllustrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IllustrationError) return error;
    throw error;
  }
  throw new Error('Expected an IllustrationError');
}

describe('remote ComfyUI client against a synthetic HTTP server', () => {
  test('normalizes remote base URLs and rejects credentials, queries or other schemes', () => {
    expect(validateComfyBaseUrl('http://192.168.0.10:8188/')).toBe('http://192.168.0.10:8188');
    expect(validateComfyBaseUrl('https://comfy.example.test/api/')).toBe(
      'https://comfy.example.test/api'
    );
    expect(comfyUIUrl('http://h:1/base/', 'history/x y', { type: 'output' })).toBe(
      'http://h:1/base/history/x%20y?type=output'
    );
    for (const bad of ['ws://h:1', 'http://user:pw@h:1', 'http://h:1/?x=1', 'not a url', ''])
      expect(() => validateComfyBaseUrl(bad)).toThrow('COMFYUI_BASE_URL_INVALID');
  });
  test('system_stats reports version and devices and sends the configured Authorization header', async () => {
    const server = await fixture({ authorization: 'Bearer synthetic' });
    process.env.UIMORI_TEST_COMFY_AUTH = 'Bearer synthetic';
    try {
      const stats = await comfyUISystemStats(
        { baseUrl: server.origin, authorizationEnv: 'UIMORI_TEST_COMFY_AUTH' },
        { signal: signal() }
      );
      expect(stats.system.comfyuiVersion).toBe('0.3.99');
      expect(stats.devices[0]).toMatchObject({ name: 'cuda:0 Fixture GPU', type: 'cuda' });
      expect(server.requests[0].headers.authorization).toBe('Bearer synthetic');
      delete process.env.UIMORI_TEST_COMFY_AUTH;
      const missing = await failure(
        comfyUISystemStats(
          { baseUrl: server.origin, authorizationEnv: 'UIMORI_TEST_COMFY_AUTH' },
          { signal: signal() }
        )
      );
      expect(missing.code).toBe('COMFYUI_CREDENTIAL_UNAVAILABLE');
      const denied = await failure(
        comfyUISystemStats({ baseUrl: server.origin, authorizationEnv: '' }, { signal: signal() })
      );
      expect(denied.code).toBe('COMFYUI_HTTP_ERROR');
      expect(denied.diagnostic.comfyui?.httpStatus).toBe(401);
    } finally {
      delete process.env.UIMORI_TEST_COMFY_AUTH;
    }
  });
  test('submits /prompt, polls /history until the entry appears and downloads /view images', async () => {
    const server = await fixture({ delayPolls: 2 });
    const submitted: string[] = [];
    const result = await generateWithComfyUI(
      { baseUrl: server.origin, authorizationEnv: '' },
      workflow(),
      {
        signal: signal(),
        timeoutMs: 5000,
        pollIntervalMs: 20,
        onSubmitted: (id) => {
          submitted.push(id);
        },
      }
    );
    expect(submitted).toEqual([result.promptId]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ mime: 'image/png', filename: 'ComfyUI_00001_.png' });
    expect(result.images[0].bytes.equals(FIXTURE_PNG)).toBe(true);
    expect(server.prompts[0].workflow['6']).toMatchObject({
      inputs: { text: 'lantern over a river' },
    });
    expect(server.prompts[0].clientId).toMatch(/^[0-9a-f-]{36}$/u);
    const paths = server.requests.map((request) => request.url.split('?')[0]);
    expect(paths.filter((path) => path.startsWith('/history/'))).toHaveLength(3);
    expect(paths.at(-1)).toBe('/view');
    expect(server.requests.at(-1)?.url).toContain('filename=ComfyUI_00001_.png');
  });
  test('surfaces node errors from a rejected prompt without retrying and keeps 5xx retryable', async () => {
    const rejected = await fixture({ behavior: 'reject' });
    const error = await failure(
      generateWithComfyUI({ baseUrl: rejected.origin, authorizationEnv: '' }, workflow(), {
        signal: signal(),
        timeoutMs: 1000,
        pollIntervalMs: 10,
      })
    );
    expect(error.code).toBe('COMFYUI_PROMPT_REJECTED');
    expect(error.retryable).toBe(false);
    expect(error.diagnostic.comfyui).toMatchObject({
      httpStatus: 400,
      nodeErrors: [{ nodeId: '4', classType: 'CheckpointLoaderSimple' }],
    });
    expect(error.diagnostic.comfyui?.nodeErrors?.[0].messages[0]).toContain('Value not in list');
    const broken = await fixture({ behavior: 'server-error' });
    const serverError = await failure(
      generateWithComfyUI({ baseUrl: broken.origin, authorizationEnv: '' }, workflow(), {
        signal: signal(),
        timeoutMs: 1000,
        pollIntervalMs: 10,
      })
    );
    expect(serverError).toMatchObject({ code: 'COMFYUI_HTTP_5XX', retryable: true });
  });
  test('reports execution errors, missing outputs, timeouts with cancellation and unreachable hosts', async () => {
    const errored = await fixture({ behavior: 'error' });
    const execution = await failure(
      generateWithComfyUI({ baseUrl: errored.origin, authorizationEnv: '' }, workflow(), {
        signal: signal(),
        timeoutMs: 1000,
        pollIntervalMs: 10,
      })
    );
    expect(execution).toMatchObject({ code: 'COMFYUI_EXECUTION_FAILED', retryable: true });
    expect(execution.diagnostic.comfyui?.statusMessages?.[0]).toContain('CUDA out of memory');
    const empty = await fixture({ behavior: 'no-image' });
    expect(
      (
        await failure(
          generateWithComfyUI({ baseUrl: empty.origin, authorizationEnv: '' }, workflow(), {
            signal: signal(),
            timeoutMs: 1000,
            pollIntervalMs: 10,
          })
        )
      ).code
    ).toBe('COMFYUI_NO_IMAGE');
    const hanging = await fixture({ behavior: 'hang' });
    const timeout = await failure(
      generateWithComfyUI({ baseUrl: hanging.origin, authorizationEnv: '' }, workflow(), {
        signal: signal(),
        timeoutMs: 120,
        pollIntervalMs: 20,
      })
    );
    expect(timeout).toMatchObject({ code: 'COMFYUI_TIMEOUT', retryable: false });
    expect(timeout.diagnostic.comfyui?.promptId).toBe(hanging.prompts[0].id);
    // A timeout never touches the remote queue: the render may still finish and be reconciled.
    expect(hanging.requests.some((request) => ['/queue', '/interrupt'].includes(request.url))).toBe(
      false
    );
    const later = await fetchComfyUIResult(
      { baseUrl: hanging.origin, authorizationEnv: '' },
      hanging.prompts[0].id,
      { signal: signal() }
    );
    expect(later).toEqual({ state: 'pending' });
    const redirecting = await fixture({ behavior: 'redirect' });
    const redirect = await failure(
      comfyUISystemStats(
        { baseUrl: redirecting.origin, authorizationEnv: '' },
        { signal: signal() }
      )
    );
    expect(redirect).toMatchObject({ code: 'COMFYUI_REDIRECT_REFUSED', retryable: false });
    expect(redirecting.requests.map((request) => request.url)).toEqual(['/system_stats']);
    const closed = await comfyUIFixture();
    await closed.close();
    const unreachable = await failure(
      generateWithComfyUI({ baseUrl: closed.origin, authorizationEnv: '' }, workflow(), {
        signal: signal(),
        timeoutMs: 1000,
        pollIntervalMs: 10,
      })
    );
    expect(unreachable).toMatchObject({ code: 'COMFYUI_UNREACHABLE', retryable: true });
  });
  test('an aborted signal cancels the queued prompt and rejects invalid image bytes', async () => {
    const hanging = await fixture({ behavior: 'hang' });
    const controller = new AbortController();
    const pending = failure(
      generateWithComfyUI({ baseUrl: hanging.origin, authorizationEnv: '' }, workflow(), {
        signal: controller.signal,
        timeoutMs: 5000,
        pollIntervalMs: 20,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    expect((await pending).code).toBe('ILLUSTRATION_CANCELLED');
    const tail = hanging.requests.slice(-3).map((request) => `${request.method} ${request.url}`);
    expect(tail).toEqual(['GET /queue', 'POST /interrupt', 'POST /queue']);
    expect(JSON.parse(hanging.requests.at(-1)!.body)).toEqual({ delete: [hanging.prompts[0].id] });
    // A finished prompt that is no longer running is only removed from the queue, never interrupted.
    const idle = await fixture({ delayPolls: 0 });
    await generateWithComfyUI({ baseUrl: idle.origin, authorizationEnv: '' }, workflow(), {
      signal: signal(),
      timeoutMs: 1000,
      pollIntervalMs: 10,
    });
    await cancelComfyUIPrompt({ baseUrl: idle.origin, authorizationEnv: '' }, idle.prompts[0].id);
    expect(idle.requests.slice(-2).map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /queue',
      'POST /queue',
    ]);
    const done = await fetchComfyUIResult(
      { baseUrl: idle.origin, authorizationEnv: '' },
      idle.prompts[0].id,
      { signal: signal() }
    );
    expect(done.state).toBe('completed');
    const bogus = await fixture({ imageBytes: Buffer.from('<svg xmlns="x"/>') });
    expect(
      (
        await failure(
          generateWithComfyUI({ baseUrl: bogus.origin, authorizationEnv: '' }, workflow(), {
            signal: signal(),
            timeoutMs: 1000,
            pollIntervalMs: 10,
          })
        )
      ).code
    ).toBe('COMFYUI_IMAGE_INVALID');
  });
});
