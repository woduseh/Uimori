import { afterEach, expect, test } from 'vitest';
import { setLocale } from '../web/i18n.js';
import { pricingNote } from '../web/pricing-display.js';

afterEach(() => setLocale('ko'));

test('translates the retained manual pricing note without changing the snapshot or other notes', () => {
  const original = '사용자가 입력한 참고 단가예요. 실제 청구액과 다를 수 있어요.';
  const custom = '사용자 메모: 할인 계약을 따로 확인해요.';
  const similar = `${original} `;
  const snapshot = { notes: [original, custom, similar] };

  for (const [locale, expected] of [
    ['ko', original],
    ['en', 'User-entered reference rates. Actual charges may differ.'],
  ] as const) {
    setLocale(locale);
    expect(snapshot.notes.map(pricingNote)).toEqual([expected, custom, similar]);
    expect(snapshot.notes).toEqual([original, custom, similar]);
  }
});
