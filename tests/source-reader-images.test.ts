import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Asset } from '../core/product.js';
import type { Job, Source } from '../core/types.js';
import { SourceReader } from '../web/SourceReader.js';
import { Prose } from '../web/Prose.js';

const uploadUrl = '/api/assets/fd28e099-4932-4d7f-a44a-52e813d70c2a';
const packageUrl = `/api/package-image-blobs/${'a'.repeat(64)}`;
const outsideUrl = '/api/assets/another-chat';
const portraitUrl = '/api/assets/portrait-only';
const unknownUrl = '/api/assets/unregistered';
const externalUrl = 'https://example.com/tracking.png';
const text = [
  `![업로드](${uploadUrl})`,
  `![패키지](${packageUrl})`,
  `![다른 채팅](${outsideUrl})`,
  `![프로필 전용](${portraitUrl})`,
  `![미등록](${unknownUrl})`,
  `![외부](${externalUrl})`,
  `\`![코드](${uploadUrl})\``,
].join('\n\n');

const imageReferences: Pick<Asset, 'url' | 'chatId' | 'allowedUse'>[] = [
  { url: uploadUrl, chatId: 'chat', allowedUse: 'inline' },
  { url: packageUrl, chatId: 'chat', allowedUse: 'both' },
  { url: outsideUrl, chatId: 'other-chat', allowedUse: 'inline' },
  { url: portraitUrl, chatId: 'chat', allowedUse: 'profile' },
  { url: externalUrl, chatId: 'chat', allowedUse: 'inline' },
];
const assets: Asset[] = imageReferences.map((asset, index) => ({
  id: `asset-${index}`,
  revision: 1,
  title: '등록 이미지',
  mime: 'image/webp',
  hash: 'bytes',
  description: '',
  actor: '',
  outfit: '',
  location: '',
  ...asset,
}));

for (const representation of ['original', 'translation'] as const) {
  for (const imageOwner of [false, true]) {
    test(`${representation} only renders this chat's registered writer images with JEV owner ${imageOwner}`, () => {
      const sourceText = representation === 'original' ? text : '원문 본문';
      const source: Source = {
        id: 'source',
        runId: 'run',
        chatId: 'chat',
        parentRevision: null,
        text: sourceText,
        hash: createHash('sha256').update(sourceText).digest('hex'),
      };
      const jobs: Job[] =
        representation === 'translation'
          ? [
              {
                id: 'translation',
                chatId: source.chatId,
                sourceRevision: source.id,
                sourceHash: source.hash,
                kind: 'translation',
                status: 'completed',
                attempt: 1,
                error: null,
                result: { mock: false, sourceRevision: source.id, sourceHash: source.hash, text },
              },
            ]
          : [];
      const before = structuredClone({ source, jobs, assets });
      const html = renderToStaticMarkup(
        createElement(SourceReader, {
          source,
          jobs,
          assets,
          imageOwner,
          index: 0,
          refresh: async () => {},
          onError: () => {},
          onFork: async () => {},
        })
      );
      expect(html.match(/<img /gu) ?? []).toHaveLength(imageOwner ? 0 : 2);
      if (!imageOwner) {
        expect(html).toContain(`src="${uploadUrl}"`);
        expect(html).toContain(`src="${packageUrl}"`);
        expect(html).toContain(`<code>![코드](${uploadUrl})</code>`);
      }
      for (const url of [outsideUrl, portraitUrl, unknownUrl, externalUrl])
        expect(html).not.toContain(`src="${url}"`);
      expect({ source, jobs, assets }).toEqual(before);
    });
  }
}

test('registered upload image URLs stay literal without the caller allowlist', () => {
  const html = renderToStaticMarkup(createElement(Prose, { text: `![이미지](${uploadUrl})` }));
  expect(html).not.toContain('<img ');
  expect(html).toContain(`![이미지](${uploadUrl})`);
});
