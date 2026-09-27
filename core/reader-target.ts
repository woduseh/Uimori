/** A saved location, not pixel coordinates or a new story branch. */
export type ReaderTarget = {
  chatId: string;
  branchId: string;
  sourceId: string;
  representation: 'original' | 'translation';
  contentHash?: string;
  blockAnchor?: string;
  offsetRatio?: number;
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
  if (target.offsetRatio !== undefined) params.set('position', String(target.offsetRatio));
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
    ...(params.has('position') &&
    Number.isFinite(Number(params.get('position'))) &&
    Number(params.get('position')) >= 0 &&
    Number(params.get('position')) <= 1
      ? { offsetRatio: Number(params.get('position')) }
      : {}),
    ...(params.get('anchor') ? { blockAnchor: params.get('anchor')! } : {}),
    ...(params.get('contentHash') ? { contentHash: params.get('contentHash')! } : {}),
  };
}
