import { describe, expect, it } from 'vitest';
import type { Branch } from '../core/product.js';
import type { ReaderDetail } from '../core/types.js';
import { branchLabel } from '../web/storyLabels.js';

describe('execution branch labels', () => {
  it('preserves an existing authored name as well as the default label', () => {
    const branch: Branch = {
      id: 'main:chat',
      chatId: 'chat',
      title: '기본 분기',
      headRevision: null,
      revision: 1,
      default: true,
    };
    const detail = {} as ReaderDetail;
    expect(branchLabel(branch, detail)).toBe('기본 분기');
    // A summarised or hand-written name survives the default flag.
    expect(branchLabel({ ...branch, title: '등불이 흔들린 밤', default: true }, detail)).toBe(
      '등불이 흔들린 밤'
    );
    expect(branchLabel({ ...branch, title: '사용자 전개' }, detail)).toBe('사용자 전개');
  });
});
