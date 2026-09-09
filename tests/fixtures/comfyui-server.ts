import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

export const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);
export type ComfyBehavior =
  | 'success'
  | 'reject'
  | 'error'
  | 'no-image'
  | 'hang'
  | 'server-error'
  | 'redirect';
export type ComfyCapturedRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
};

/** Synthetic ComfyUI HTTP surface: /system_stats, /prompt, /history/:id, /view, /queue, /interrupt. */
export async function comfyUIFixture(
  options: {
    behavior?: ComfyBehavior;
    /** History polls that return an empty object before the entry appears. */
    delayPolls?: number;
    imageBytes?: Buffer;
    imageCount?: number;
    authorization?: string;
    /** Inject after accepting a prompt, or while reading its history/image response. */
    fault?: {
      path: 'prompt' | 'history' | 'view';
      kind: 'headers' | 'body' | 'disconnect' | 'http-5xx';
    };
    targetedCancel?: boolean;
  } = {}
) {
  const behavior = options.behavior ?? 'success';
  const requests: ComfyCapturedRequest[] = [];
  const prompts: { id: string; workflow: Record<string, unknown>; clientId: string }[] = [];
  const polls = new Map<string, number>();
  let fault = options.fault;
  const waiters: { path: string; resolve: () => void }[] = [];
  let origin = '';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url ?? '/', 'http://fixture');
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '',
      headers: request.headers,
      body,
    });
    for (const waiter of waiters.splice(0)) {
      if (url.pathname.startsWith(waiter.path)) waiter.resolve();
      else waiters.push(waiter);
    }
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const injectFault = (path: NonNullable<typeof fault>['path']) => {
      if (fault?.path !== path) return false;
      if (fault.kind === 'disconnect') response.destroy();
      else if (fault.kind === 'body') {
        response.writeHead(200, {
          'content-type': path === 'view' ? 'image/png' : 'application/json',
        });
        response.write(path === 'view' ? FIXTURE_PNG.subarray(0, 8) : '{');
      } else if (fault.kind === 'http-5xx')
        json(503, { error: 'synthetic transient response failure' });
      return true;
    };
    if (options.authorization && request.headers.authorization !== options.authorization)
      return json(401, { error: 'unauthorized' });
    if (behavior === 'redirect' && url.pathname !== '/redirected') {
      response.writeHead(302, { location: `${origin}/redirected` });
      return response.end();
    }
    if (url.pathname === '/system_stats')
      return json(200, {
        system: { os: 'fixture-os', comfyui_version: '0.3.99', python_version: '3.12.0' },
        devices: [{ name: 'cuda:0 Fixture GPU', type: 'cuda', vram_total: 12_000_000_000 }],
      });
    if (url.pathname === '/prompt' && request.method === 'POST') {
      if (behavior === 'server-error') return json(500, { error: 'boom' });
      let parsed: { prompt?: Record<string, unknown>; client_id?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: { type: 'invalid_json', message: 'bad json' }, node_errors: {} });
      }
      if (behavior === 'reject')
        return json(400, {
          error: {
            type: 'prompt_outputs_failed_validation',
            message: 'Prompt outputs failed validation',
            details: '',
          },
          node_errors: {
            '4': {
              errors: [
                {
                  type: 'value_not_in_list',
                  message: 'Value not in list',
                  details: "ckpt_name: 'missing.safetensors' not in ['fixture.safetensors']",
                },
              ],
              class_type: 'CheckpointLoaderSimple',
              dependent_outputs: ['9'],
            },
          },
        });
      const id = randomUUID();
      prompts.push({ id, workflow: parsed.prompt ?? {}, clientId: String(parsed.client_id ?? '') });
      polls.set(id, 0);
      if (injectFault('prompt')) return;
      return json(200, { prompt_id: id, number: prompts.length, node_errors: {} });
    }
    const history = /^\/history\/([^/]+)$/u.exec(url.pathname);
    if (history) {
      if (injectFault('history')) return;
      const id = decodeURIComponent(history[1]);
      if (!polls.has(id)) return json(200, {});
      const count = (polls.get(id) ?? 0) + 1;
      polls.set(id, count);
      if (behavior === 'hang' || count <= (options.delayPolls ?? 0)) return json(200, {});
      if (behavior === 'error')
        return json(200, {
          [id]: {
            outputs: {},
            status: {
              status_str: 'error',
              completed: false,
              messages: [
                ['execution_start', { prompt_id: id }],
                [
                  'execution_error',
                  {
                    prompt_id: id,
                    node_id: '3',
                    node_type: 'KSampler',
                    exception_type: 'RuntimeError',
                    exception_message: 'CUDA out of memory (fixture)',
                  },
                ],
              ],
            },
          },
        });
      const images = Array.from({ length: options.imageCount ?? 1 }, (_, index) => ({
        filename: `ComfyUI_0000${index + 1}_.png`,
        subfolder: '',
        type: 'output',
      }));
      return json(200, {
        [id]: {
          outputs: behavior === 'no-image' ? {} : { '9': { images } },
          status: { status_str: 'success', completed: true, messages: [] },
        },
      });
    }
    if (url.pathname === '/view') {
      if (injectFault('view')) return;
      response.writeHead(200, { 'content-type': 'image/png' });
      return response.end(options.imageBytes ?? FIXTURE_PNG);
    }
    if (/^\/api\/jobs\/[^/]+\/cancel$/u.test(url.pathname))
      return options.targetedCancel
        ? json(200, { cancelled: true })
        : json(404, { error: 'unsupported' });
    if (url.pathname === '/queue' && request.method === 'GET')
      return json(200, {
        queue_running:
          behavior === 'hang' ? prompts.map((prompt) => [0, prompt.id, {}, {}, []]) : [],
        queue_pending: [],
      });
    if (url.pathname === '/queue' || url.pathname === '/interrupt') return json(200, {});
    return json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not receive a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    prompts,
    clearFault: () => {
      fault = undefined;
    },
    waitForRequest: (path: string) =>
      requests.some((request) => request.url.startsWith(path))
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ path, resolve })),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
/** Minimal API-format workflow with the three placeholders. */
export const FIXTURE_WORKFLOW = JSON.stringify({
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: '{{seed}}',
      steps: 20,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fixture.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, {{negative}}', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
});
