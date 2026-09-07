import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { Json } from '../../core/transport.js';

export type CapturedRequest = { url: string; headers: IncomingMessage['headers']; body: string };
export async function loopbackProvider(
  handler: (request: CapturedRequest, response: ServerResponse) => void | Promise<void>
) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const captured = {
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      await handler(captured, response);
    } catch {
      response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not receive a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    endpoint: `${origin}/turn`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
export const sse = (event: Json) => `data: ${JSON.stringify(event)}\r\n\r\n`;
export async function writeSse(response: ServerResponse, events: Json[], fragments = false) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const bytes = Buffer.from(events.map(sse).join(''), 'utf8');
  if (fragments)
    for (let offset = 0; offset < bytes.length; offset += 3) {
      response.write(bytes.subarray(offset, offset + 3));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  else response.write(bytes);
  response.end();
}
