export type ReaderTarget = {
  chatId: string;
  sourceId: string;
  representation: 'original' | 'translation';
  contentHash?: string;
  blockAnchor?: string;
  offsetRatio?: number;
  changedParagraph?: number | null;
};

export function paragraphPosition(
  text: string,
  blocks: readonly { anchor: string; start: number; end: number }[],
  paragraph: number
): { anchor: string; ratio: number; share: number } | null {
  let offset = 0;
  for (let line = 0; line < paragraph; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const block =
    blocks.find((item) => offset >= item.start && offset < item.end) ??
    blocks.find((item) => item.start >= offset);
  if (!block) return null;
  const length = block.end - block.start;
  return {
    anchor: block.anchor,
    ratio: length > 0 ? Math.min(1, Math.max(0, (offset - block.start) / length)) : 0,
    share: text.length > 0 ? offset / text.length : 0,
  };
}

export function readerTargetUrl(target: ReaderTarget): string {
  const params = new URLSearchParams({
    chat: target.chatId,
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
