import { createServer } from 'node:http';

/** Owned synthetic HTTP peer for registration and explicit image-selection UI fixtures. */
export async function startRegistrationFixture() {
  let registrationCalls = 0,
    url = '';
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/stats') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ registrationCalls, errors }));
        return;
      }
      if (request.method === 'GET' && request.url === '/models') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            models: [
              {
                id: 'synthetic-created-model',
                label: '합성 등록 모델',
                capabilities: { tools: null, structuredOutput: null },
                pricing: { inputUsdPerMillion: null, outputUsdPerMillion: null, revision: null },
              },
            ],
          })
        );
        return;
      }
      if (request.method !== 'POST' || !['/', '/presentation'].includes(request.url)) {
        response.writeHead(404);
        response.end();
        return;
      }
      let input = '';
      for await (const part of request) {
        input += part;
        if (input.length > 100000) {
          response.writeHead(413);
          response.end();
          return;
        }
      }
      const body = JSON.parse(input);
      if (request.url === '/presentation') {
        const source = body.input?.source;
        const asset = body.input?.catalog?.items?.find((item) => item.uses?.includes('inline'));
        if (
          body.protocol !== 'fixture-sse-v1' ||
          body.role !== 'image' ||
          body.modelId !== 'synthetic-image-selector' ||
          !source?.sourceRevision ||
          !source.sourceHash ||
          !source.blocks?.[0]?.anchor ||
          !asset?.ref ||
          !asset.revision ||
          !asset.hash
        )
          throw new Error('Unexpected image selection fixture input');
        const output = {
          sourceRevision: source.sourceRevision,
          sourceHash: source.sourceHash,
          entries: [
            {
              blockAnchor: source.blocks[0].anchor,
              assetRef: asset.ref,
              assetRevision: asset.revision,
              assetHash: asset.hash,
              presentationIntent: 'inline',
            },
          ],
        };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'text_delta', delta: JSON.stringify(output) },
          { type: 'usage', inputTokens: 50, outputTokens: 30, costUsd: null },
          { type: 'done', reason: 'stop' },
        ])
          response.write('data: ' + JSON.stringify(event) + '\n\n');
        response.end();
        return;
      }
      if (
        body.protocol !== 'fixture-sse-v1' ||
        body.input?.controls?.purpose !== 'provider-registration'
      )
        throw new Error('Unexpected fixture purpose');
      if (body.input.source !== undefined || body.input.history !== undefined)
        throw new Error('Unexpected story context');
      registrationCalls++;
      const plan = {
        connection: {
          kind: 'new',
          draft: {
            title: 'PMUI05 제안 연결',
            protocol: 'fixture-sse-v1',
            endpoint: url,
            enabled: false,
          },
        },
        model: {
          title: 'PMUI05 제안 모델',
          modelId: 'synthetic-created-model',
          maxOutputTokens: 512,
          temperature: null,
        },
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        {
          type: 'tool_delta',
          index: 0,
          id: 'registration-proposal',
          name: 'registration.propose',
          argumentsDelta: JSON.stringify(plan),
        },
        { type: 'usage', inputTokens: 50, outputTokens: 30, costUsd: null },
        { type: 'done', reason: 'tool_calls' },
      ])
        response.write('data: ' + JSON.stringify(event) + '\n\n');
      response.end();
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    stats: () => ({ registrationCalls, errors: [...errors] }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
