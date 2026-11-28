import { expect, test } from 'vitest';
import { type ReaderResponse, restoreReaderBlockText } from '../web/reader-blocks.js';

const sourceText = '첫 문단 😀\r\n\r\n둘째 𝒳 문단';
const translationText = 'First 😀 paragraph\r\n\r\nSecond 𝒳 one';
const previousText = 'Old 😀\r\n\r\nolder';

function ranges(text: string) {
  const parts = text.split('\r\n\r\n');
  let start = 0;
  return parts.map((part, index) => {
    const block = { anchor: `a${index}`, index, start, end: start + part.length, text: part };
    start += part.length + 4;
    return block;
  });
}
const strip = (blocks: ReturnType<typeof ranges>) => blocks.map(({ text: _text, ...rest }) => rest);

function response(): ReaderResponse {
  return {
    chat: { id: 'chat' },
    runs: [],
    sources: [
      { id: 's1', text: sourceText, blocks: strip(ranges(sourceText)) },
      { id: 's2', text: 'x' },
    ],
    jobs: [
      {
        id: 'j1',
        kind: 'translation',
        result: { text: translationText },
        translationLayout: { textHash: 'h', blocks: strip(ranges(translationText)) },
        previousResult: {
          jobId: 'j0',
          revision: 1,
          result: { text: previousText },
          translationLayout: { textHash: 'p', blocks: strip(ranges(previousText)) },
        },
      },
      { id: 'j2', kind: 'status', result: null },
    ],
    reader: { cursor: 3, order: ['s1', 's2'] },
  } as unknown as ReaderResponse;
}

test('slim reader blocks regain their sliced text, with CRLF and non-BMP text', () => {
  const restored = restoreReaderBlockText(response());
  expect(restored.sources[0]!.blocks).toEqual(ranges(sourceText));
  expect(restored.jobs[0]!.translationLayout!.blocks).toEqual(ranges(translationText));
  expect(restored.jobs[0]!.previousResult!.translationLayout!.blocks).toEqual(ranges(previousText));
  expect(restored.sources[1]).toEqual({ id: 's2', text: 'x' });
  expect(restored.jobs[1]).toEqual({ id: 'j2', kind: 'status', result: null });
});
