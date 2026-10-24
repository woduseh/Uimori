import type { ProviderProtocol } from './product.js';
import type { Json } from './transport.js';

/** This is adapter support, not a promise that a selected model/account can use search. */
export function helperWebSearchCapability(protocol: ProviderProtocol) {
  if (protocol === 'codex-app-server-v1') return { supported: true, mode: 'live' as const };
  if (protocol === 'openai-responses-v1' || protocol === 'anthropic-messages-v1')
    return { supported: true, mode: 'provider' as const };
  return {
    supported: false,
    mode: 'unavailable' as const,
    reason: 'This adapter does not support web search together with Uimori tools.',
  };
}

/** Render provider citations without changing original content retained for continuation. */
export function webCitationLinks(citations: Json[]): string {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const citation of citations) {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) continue;
    if (typeof citation.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title =
      typeof citation.title === 'string' && citation.title.trim() ? citation.title : url.hostname;
    const label = title.replace(/[\\[\]<>\r\n]/gu, ' ').trim();
    const target = url.href.replace(/[<>\s]/gu, (value) => encodeURIComponent(value));
    links.push(`[${label}](<${target}>)`);
  }
  return links.length ? '\n\n' + links.join('\n') : '';
}
