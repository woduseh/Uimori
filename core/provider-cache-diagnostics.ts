import { createHash } from 'node:crypto';
import type { ProviderProtocol } from './product.js';
import type { Json } from './transport.js';

export type ProviderCacheBoundary = { path: string; sha256: string; bytes: number };
const object = (value: Json | undefined): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Local wire fingerprints, not provider cache keys or evidence of a cache hit.
 * All non-message settings are included conservatively. bytes counts this framed JSON projection,
 * not model tokens. Only explicit blocks emitted by the Responses/Messages encoders are reported.
 */
export function providerCacheBoundaries(
  protocol: ProviderProtocol,
  body: Json
): ProviderCacheBoundary[] {
  if (!object(body) || !['openai-responses-v1', 'anthropic-messages-v1'].includes(protocol))
    return [];
  const wireBody = body;
  const responses = protocol === 'openai-responses-v1';
  const field = responses ? 'prompt_cache_breakpoint' : 'cache_control';
  const explicit = (value: Json) =>
    object(value) &&
    object(value[field]) &&
    (responses ? value[field].mode === 'explicit' : value[field].type === 'ephemeral');
  const settings = Object.fromEntries(
    Object.entries(wireBody).filter(([key]) =>
      responses ? key !== 'input' : key !== 'system' && key !== 'messages'
    )
  );
  function* chunks(): Generator<{ path: string; value: Json; boundary?: boolean }> {
    if (!responses && Array.isArray(wireBody.system))
      for (const [index, part] of wireBody.system.entries())
        yield { path: `system[${index}]`, value: part, boundary: explicit(part) };
    else if (!responses && wireBody.system !== undefined)
      yield { path: 'system', value: wireBody.system };
    const section = responses ? 'input' : 'messages';
    const messages = wireBody[section];
    if (!Array.isArray(messages)) return;
    for (const [index, message] of messages.entries()) {
      const path = `${section}[${index}]`;
      if (object(message) && Array.isArray(message.content)) {
        const { content, ...envelope } = message;
        // Include every message header even if its JSON key followed content in the wire body.
        yield { path, value: envelope };
        for (const [partIndex, part] of content.entries())
          yield {
            path: `${path}.content[${partIndex}]`,
            value: part,
            boundary: explicit(part),
          };
      } else yield { path, value: message };
    }
  }
  let remaining = 0;
  for (const chunk of chunks()) if (chunk.boundary) remaining++;
  if (!remaining) return [];
  const hash = createHash('sha256');
  let bytes = 0;
  const append = (value: Json) => {
    const text = JSON.stringify(value);
    hash.update(text);
    bytes += Buffer.byteLength(text);
  };
  append(['wire-cache-boundary-v1', protocol, settings]);
  const boundaries: ProviderCacheBoundary[] = [];
  for (const { path, value, boundary } of chunks()) {
    append([path, value]);
    if (boundary) {
      boundaries.push({ path, sha256: hash.copy().digest('hex'), bytes });
      if (--remaining === 0) break;
    }
  }
  return boundaries;
}
