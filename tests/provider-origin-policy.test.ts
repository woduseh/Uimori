import { describe, expect, it } from 'vitest';
import { providerOriginApproval } from '../core/provider-origin-policy.js';
import { validateConnection } from '../core/transport.js';
import type { ProviderProtocol } from '../core/product.js';

const vertex =
  'https://aiplatform.googleapis.com/v1/projects/project-id/locations/global/publishers/google/models';
const official: [ProviderProtocol, string][] = [
  ['vertex-gemini-v1', vertex],
  ['openai-responses-v1', 'https://api.openai.com/v1'],
  ['openai-chat-v1', 'https://api.openai.com/v1'],
  ['anthropic-messages-v1', 'https://api.anthropic.com/v1'],
  ['vercel-chat-v1', 'https://ai-gateway.vercel.sh/v1'],
  ['deepseek-chat-v1', 'https://api.deepseek.com/v1'],
];

describe('provider origin approval', () => {
  it.each(official)(
    'allows the validated %s official root without operator configuration',
    (protocol, endpoint) => {
      for (const root of [endpoint, `${endpoint}/`]) {
        expect(providerOriginApproval(protocol, root, [])).toBe('official');
        expect(validateConnection({ id: 'test', protocol, endpoint: root }, [])).toMatchObject({
          protocol,
          endpoint: root,
        });
      }
    }
  );

  it.each(official)(
    'rejects misleading or credential-bearing %s addresses',
    (protocol, endpoint) => {
      const url = new URL(endpoint);
      for (const altered of [
        endpoint.replace(url.hostname, `${url.hostname}.evil.example`),
        endpoint.replace(url.hostname, `evil-${url.hostname}`),
        endpoint.replace('https://', 'http://'),
        endpoint.replace(url.hostname, `${url.hostname}:8443`),
        endpoint.replace('https://', 'https://user:secret@'),
        `${endpoint}?key=value`,
        `${endpoint}#fragment`,
      ])
        expect(providerOriginApproval(protocol, altered, [])).toBeNull();
    }
  );

  it('requires explicit origins for compatible remote APIs and loopback fixtures', () => {
    for (const protocol of ['openai-chat-v1', 'openai-responses-v1'] as const) {
      const endpoint = 'https://proxy.example/custom/v1';
      expect(providerOriginApproval(protocol, endpoint, [])).toBeNull();
      expect(providerOriginApproval(protocol, endpoint, ['https://proxy.example'])).toBe(
        'configured'
      );
      expect(
        providerOriginApproval(protocol, 'http://127.0.0.1:8000/v1', ['http://127.0.0.1:8000'])
      ).toBe('configured');
      expect(
        providerOriginApproval(protocol, 'http://proxy.example/v1', ['http://proxy.example'])
      ).toBeNull();
    }
    expect(providerOriginApproval('fixture-sse-v1', 'http://127.0.0.1:8000/turn', [])).toBeNull();
    expect(
      providerOriginApproval('fixture-sse-v1', 'http://127.0.0.1:8000/turn', [
        'http://127.0.0.1:8000',
      ])
    ).toBe('configured');
    expect(
      providerOriginApproval('fixture-sse-v1', 'https://api.openai.com/v1', [
        'https://api.openai.com',
      ])
    ).toBeNull();
  });

  it('does not let configured origins bypass endpoint or secret-in-URL validation', () => {
    for (const suffix of ['?token=secret', '#fragment']) {
      expect(
        providerOriginApproval('openai-chat-v1', `https://proxy.example/v1${suffix}`, [
          'https://proxy.example',
        ])
      ).toBeNull();
    }
    expect(
      providerOriginApproval('openai-chat-v1', 'https://user:secret@proxy.example/v1', [
        'https://proxy.example',
      ])
    ).toBeNull();
    expect(
      providerOriginApproval('anthropic-messages-v1', 'https://proxy.example/v1', [
        'https://proxy.example',
      ])
    ).toBeNull();
    expect(providerOriginApproval('openai-chat-v1', 'https://api.openai.com/other', [])).toBeNull();
    expect(
      providerOriginApproval('vercel-chat-v1', 'https://api.openai.com/v1', [
        'https://api.openai.com',
      ])
    ).toBeNull();
  });

  it('preserves the supported global Vertex contract and rejects unimplemented regions', () => {
    for (const endpoint of [
      vertex.replace('/global/', '/us-central1/'),
      vertex
        .replace('aiplatform.googleapis.com', 'us-central1-aiplatform.googleapis.com')
        .replace('/global/', '/us-central1/'),
      vertex.replace('/project-id/', '/bad/'),
      `${vertex}/gemini-3.8-flash`,
    ]) {
      expect(
        providerOriginApproval('vertex-gemini-v1', endpoint, [new URL(endpoint).origin])
      ).toBeNull();
    }
    expect(() =>
      validateConnection(
        {
          id: 'test',
          protocol: 'vertex-gemini-v1',
          endpoint: vertex.replace('/global/', '/us-central1/'),
        },
        ['https://aiplatform.googleapis.com']
      )
    ).toThrow('INVALID_VERTEX_ENDPOINT');
  });

  it('leaves local Codex authorization with the dedicated connection contract', () => {
    expect(providerOriginApproval('codex-app-server-v1', 'codex://local', [])).toBeNull();
    expect(
      validateConnection(
        { id: 'test', protocol: 'codex-app-server-v1', endpoint: 'codex://local' },
        []
      )
    ).toMatchObject({ endpoint: 'codex://local' });
  });
});
