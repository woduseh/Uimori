/** A saved location, not pixel coordinates or a new story branch. */
export type ReaderTarget = {
  chatId: string;
  branchId: string;
  sourceId: string;
  representation: 'original' | 'translation';
  contentHash?: string;
  blockAnchor?: string;
};

export function readerTargetUrl(target: ReaderTarget): string {
  const params = new URLSearchParams({
    chat: target.chatId,
    branch: target.branchId,
    source: target.sourceId,
    mode: target.representation,
  });
  if (target.blockAnchor) params.set('anchor', target.blockAnchor);
  if (target.contentHash) params.set('contentHash', target.contentHash);
  return `?${params}`;
}

export function readerTargetFromUrl(search: string): ReaderTarget | null {
  const params = new URLSearchParams(search);
  const chatId = params.get('chat'),
    sourceId = params.get('source');
  if (!chatId || !sourceId) return null;
  return {
    chatId,
    sourceId,
    branchId: params.get('branch') || `main:${chatId}`,
    representation: params.get('mode') === 'translation' ? 'translation' : 'original',
    ...(params.get('anchor') ? { blockAnchor: params.get('anchor')! } : {}),
    ...(params.get('contentHash') ? { contentHash: params.get('contentHash')! } : {}),
  };
}
