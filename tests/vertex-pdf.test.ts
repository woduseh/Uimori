import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { expect, test } from 'vitest';
import { PROMPT_COMPILER_VERSION } from '../core/risu-prompt.js';
import type { ProviderRequest } from '../core/transport.js';
import { encodeVertex } from '../core/vertex-protocol.js';

type Conversation = { role: 'user' | 'model'; parts: { text: string }[] }[];

function encodeConversation(conversation: Conversation): string {
  const request: ProviderRequest = {
    role: 'main',
    modelId: 'gemini-3.8-flash',
    stable: { contract: 'Continue the conversation.', tools: [] },
    generation: { maxOutputTokens: 1024, temperature: null, pdfInput: true },
    input: { task: 'Continue.', controls: {} },
    prompt: {
      compilerVersion: PROMPT_COMPILER_VERSION,
      values: {},
      messages: conversation.map((message, index) => ({
        id: String(index),
        role: message.role === 'model' ? 'assistant' : 'user',
        content: message.parts.map(({ text }) => ({ type: 'text', text })),
        completion: 'complete',
        provenance: { blockId: String(index), origin: 'prompt' },
      })),
      cachePlan: [],
    },
  };
  const wire = encodeVertex(request).body as Record<string, any>;
  expect(wire.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
  return wire.contents[0].parts[0].inlineData.data;
}

async function extractPages(data: string): Promise<string[]> {
  const loading = getDocument({
    data: new Uint8Array(Buffer.from(data, 'base64')),
    disableFontFace: true,
    useSystemFonts: false,
  });
  const document = await loading.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: true });
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}

test('an independent PDF reader restores Unicode and escaped conversation whitespace', async () => {
  const conversation: Conversation = [
    {
      role: 'user',
      parts: [{ text: '한글 🌊 🧑‍🚀 café e\u0301\nreal newline, literal \\n\t  two spaces\r\n' }],
    },
    { role: 'model', parts: [{ text: 'Earlier assistant with "quotes" and \\slashes.' }] },
    { role: 'user', parts: [{ text: 'Continue.' }] },
  ];
  const pages = await extractPages(encodeConversation(conversation));

  expect(pages).toHaveLength(1);
  const restored = pages.join('');
  expect(JSON.parse(restored)).toEqual(conversation);
});

test('an independent PDF reader restores ordered conversation across a page boundary', async () => {
  // Just over one machine-readable page, with distinct text on each side of the boundary.
  const conversation: Conversation = [
    { role: 'user', parts: [{ text: '앞쪽 🌊' + 'abcdefghij'.repeat(100100) + '뒤쪽 🧑‍🚀' }] },
    { role: 'model', parts: [{ text: 'The following message must also survive.' }] },
    { role: 'user', parts: [{ text: 'Continue.' }] },
  ];
  const source = JSON.stringify(conversation);
  const pages = await extractPages(encodeConversation(conversation));

  expect(pages).toHaveLength(2);
  expect(pages.every((page) => page.length > 0)).toBe(true);
  const restored = pages.join('');
  // A failed assertion should report a bounded digest, not dump a million-character fixture.
  const restoredConversation: Conversation = JSON.parse(restored);
  expect(createHash('sha256').update(JSON.stringify(restoredConversation)).digest('hex')).toBe(
    createHash('sha256').update(source).digest('hex')
  );
  expect(restoredConversation).toEqual(conversation);
});
