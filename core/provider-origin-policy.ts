import { validateProviderEndpoint, type ProviderProtocol } from './product.js';

/** Only protocol-validated official roots or operator-configured origins can send requests. */
export function providerOriginApproval(protocol: ProviderProtocol, endpoint: string, approvedOrigins: readonly string[]): 'official' | 'configured' | null {
  if (protocol === 'codex-app-server-v1') return null;
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return null;
    const normalized = validateProviderEndpoint(protocol, endpoint);
    // Vertex, Anthropic, and Vercel validators already enforce their exact official roots.
    if (protocol === 'vertex-gemini-v1' || protocol === 'anthropic-messages-v1' || protocol === 'vercel-chat-v1') return 'official';
    if ((protocol === 'openai-responses-v1' || protocol === 'openai-chat-v1') && normalized === 'https://api.openai.com/v1') return 'official';
    return approvedOrigins.includes(url.origin) ? 'configured' : null;
  } catch {
    return null;
  }
}
