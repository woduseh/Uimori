import type { Job, ReaderDetail, Source, TranslationLayout } from '../core/types.js';

type BlockRange = { anchor: string; index: number; start: number; end: number; text?: string };
type WireLayout = Omit<TranslationLayout, 'blocks'> & { blocks: BlockRange[] };
type WireJob = Omit<Job, 'translationLayout' | 'previousResult'> & {
  translationLayout?: WireLayout;
  previousResult?: Omit<NonNullable<Job['previousResult']>, 'translationLayout'> & {
    translationLayout?: WireLayout;
  };
};
export type ReaderResponse = Omit<ReaderDetail, 'sources' | 'jobs'> & {
  sources: (Omit<Source, 'blocks'> & { blocks?: BlockRange[] })[];
  jobs: WireJob[];
};

function restoreBlocks(blocks: BlockRange[], fullText: string | undefined) {
  return blocks.map((block) =>
    typeof block.text === 'string'
      ? { ...block, text: block.text }
      : { ...block, text: (fullText ?? '').slice(block.start, block.end) }
  );
}
function restoreLayout(
  layout: WireLayout | undefined,
  fullText: string | undefined
): TranslationLayout | undefined {
  return layout && { ...layout, blocks: restoreBlocks(layout.blocks, fullText) };
}

function restorePrevious({
  translationLayout,
  ...previous
}: NonNullable<WireJob['previousResult']>): NonNullable<Job['previousResult']> {
  return translationLayout
    ? { ...previous, translationLayout: restoreLayout(translationLayout, previous.result.text) }
    : previous;
}

export function restoreReaderBlockText(response: ReaderResponse): ReaderDetail {
  return {
    ...response,
    sources: response.sources.map((source) =>
      source.blocks ? { ...source, blocks: restoreBlocks(source.blocks, source.text) } : source
    ) as Source[],
    jobs: response.jobs.map(
      ({ translationLayout, previousResult, ...job }): Job => ({
        ...job,
        ...(translationLayout && {
          translationLayout: restoreLayout(translationLayout, job.result?.text),
        }),
        ...(previousResult && { previousResult: restorePrevious(previousResult) }),
      })
    ),
  };
}
