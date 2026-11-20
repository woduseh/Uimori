import type { ProviderProtocol } from './product.js';
import type { Json, ProviderRequest } from './transport.js';

export type ProviderWebSearch = {
  performed: boolean;
  sources: { url: string; title: string }[];
  queries?: string[];
  searchEntryPoint?: string;
};

export function webSearchAllowed(request: Pick<ProviderRequest, 'role' | 'input'>): boolean {
  return (
    request.role === 'helper' ||
    (request.role === 'main' && request.input?.controls?.purpose === 'story-guide')
  );
}

export function storyGuideWebSearchCapability(protocol: ProviderProtocol) {
  if (protocol === 'google-gemini-v1' || protocol === 'vertex-gemini-v1')
    return { supported: true, mode: 'provider' as const };
  return helperWebSearchCapability(protocol);
}

export function webSearchSources(citations: Json[]): ProviderWebSearch['sources'] {
  const seen = new Set<string>();
  return citations.flatMap((citation) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return [];
    if (typeof citation.url !== 'string') return [];
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      return [];
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return [];
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    return [
      {
        url: url.href,
        title:
          typeof citation.title === 'string' && citation.title.trim()
            ? citation.title
            : url.hostname,
      },
    ];
  });
}

export function boundedWebSearch(value: ProviderWebSearch): ProviderWebSearch {
  const sources = webSearchSources(value.sources);
  if (
    sources.length > 32 ||
    sources.some((source) => source.url.length > 8192 || source.title.length > 2000) ||
    (value.queries?.length ?? 0) > 16 ||
    value.queries?.some((query) => query.length > 2000) ||
    (value.searchEntryPoint?.length ?? 0) > 65_536 ||
    JSON.stringify({ ...value, sources }).length > 98_304
  )
    throw new Error('STORY_GUIDE_WEB_SEARCH_METADATA_TOO_LARGE');
  return {
    performed: value.performed,
    sources,
    ...(value.queries ? { queries: [...new Set(value.queries)] } : {}),
    ...(value.searchEntryPoint ? { searchEntryPoint: value.searchEntryPoint } : {}),
  };
}

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
