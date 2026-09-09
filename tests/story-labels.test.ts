import { describe, expect, it } from 'vitest';
import type { Branch } from '../core/product.js';
import type { ReaderDetail } from '../core/types.js';
import { branchLabel } from '../web/storyLabels.js';

describe('candidate branch labels', () => {
  it('preserves global numbering when earlier candidate runs are outside the reader page', () => {
    const branch: Branch = {
      id: 'candidate-two',
      chatId: 'chat',
      title: '후보 분기',
      headRevision: null,
      revision: 1,
      default: false,
    };
    const detail = {
      reader: { candidateBranches: ['candidate-one', 'candidate-two'] },
      runs: [{ snapshot: { candidateOf: 'original', branchId: 'candidate-two' } }],
    } as ReaderDetail;
    expect(branchLabel(branch, detail)).toBe('다른 응답 2');
    detail.runs = [];
    expect(branchLabel(branch, detail)).toBe('다른 응답 2');
    expect(branchLabel({ ...branch, default: true }, detail)).toBe('기본 전개');
    expect(branchLabel({ ...branch, title: '사용자 전개' }, detail)).toBe('사용자 전개');
    expect(branchLabel({ ...branch, id: 'removed-candidate' }, detail)).toBe('보관된 다른 응답');
  });
});
