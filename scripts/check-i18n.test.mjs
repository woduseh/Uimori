import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  checkI18n,
  koreanLiteralAllowlistPath,
  koreanLiteralErrors,
  readKoreanLiteralAllowlist,
  shrinkKoreanLiterals,
} from './check-i18n.mjs';

function withRepository(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-korean-literal-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(
        join(directory, path),
        typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`
      );
    }
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const allowlist = (permanent, debt) => ({ [koreanLiteralAllowlistPath]: { permanent, debt } });

test('a new Korean literal in an unlisted file fails and points to the catalog', () => {
  const cases = {
    'web/String.ts': "export const title = '제목';",
    'web/Template.ts': ['export const count = (n: number) => `$', '{n}개`;'].join(''),
    'web/Text.tsx': 'export const View = () => <p>불러오는 중</p>;',
    'web/Attribute.tsx': 'export const View = () => <input placeholder="입력" />;',
    'web/Jamo.ts': "export const laugh = 'ㅋㅋ';",
    'web/Cast.ts': "export const title = <string>'제목';",
    'web/content.css': '.empty::after { content: "없음"; }',
  };
  for (const [file, source] of Object.entries(cases))
    withRepository({ [file]: source }, (directory) => {
      const errors = koreanLiteralErrors(directory);
      assert.equal(errors.length, 1, file);
      assert.match(
        errors[0],
        new RegExp(`^${file}: 1 Korean literals \\(lines 1\\), none allowed;`)
      );
      assert.match(errors[0], /web\/locales/);
      assert.match(errors[0], /t\(key\)/);
      assert.match(errors[0], /uiMessage\(key\)/);
    });
});

test('comments, regular expressions, English text and the catalogs are not Korean literals', () => {
  withRepository(
    {
      'web/View.tsx': [
        '// 주석',
        '/* 블록 주석 */',
        'const hangul = /[가-힣]/u;',
        'export const View = () => <p title="Title">{\'English\'}{/* 설명 */}</p>;',
      ].join('\n'),
      'web/theme.css': '/* 제목 */\n.title { content: "Title"; }',
      'web/locales/view.ts': "export const messages = { 'view.title': { ko: '제목' } };",
    },
    (directory) => assert.deepEqual(koreanLiteralErrors(directory), [])
  );
});

test('debt allows exactly its count, and one more literal fails', () => {
  const source = (count) =>
    Array.from({ length: count }, (_, index) => `export const t${index} = '제목${index}';`).join(
      '\n'
    );
  withRepository(
    { 'web/View.ts': source(2), ...allowlist({}, { 'web/View.ts': 2 }) },
    (directory) => {
      assert.deepEqual(koreanLiteralErrors(directory), []);
      writeFileSync(join(directory, 'web/View.ts'), source(3));
      const [error, ...rest] = koreanLiteralErrors(directory);
      assert.deepEqual(rest, []);
      assert.match(error, /^web\/View\.ts: 3 Korean literals \(lines 1, 2, 3\), .* allows 2;/);
    }
  );
});

test('a converted literal fails until --shrink lowers the debt, and shrinking never raises it', () => {
  withRepository(
    {
      'web/View.ts': "export const a = '가';\nexport const b = 'Title';",
      'web/Gone.ts': "export const a = 'Title';",
      ...allowlist({}, { 'web/View.ts': 2, 'web/Gone.ts': 1 }),
    },
    (directory) => {
      assert.deepEqual(koreanLiteralErrors(directory), [
        `${koreanLiteralAllowlistPath}: web/View.ts now owes 1 Korean literals; lower its debt from 2 to 1 (node scripts/check-i18n.mjs --shrink)`,
        `${koreanLiteralAllowlistPath}: web/Gone.ts owes no Korean literals; remove its debt entry (node scripts/check-i18n.mjs --shrink)`,
      ]);
      shrinkKoreanLiterals(directory);
      assert.deepEqual(readKoreanLiteralAllowlist(directory).debt, { 'web/View.ts': 1 });
      assert.deepEqual(koreanLiteralErrors(directory), []);

      writeFileSync(
        join(directory, 'web/View.ts'),
        "export const a = '가';\nexport const b = '나';"
      );
      shrinkKoreanLiterals(directory);
      assert.deepEqual(readKoreanLiteralAllowlist(directory).debt, { 'web/View.ts': 1 });
      assert.equal(koreanLiteralErrors(directory).length, 1);
    }
  );
});

test('permanent literals are not debt: shrink leaves them alone and a stale entry is fixed by hand', () => {
  const permanent = { 'web/Language.ts': { count: 1, reason: 'The language names itself.' } };
  withRepository(
    {
      'web/Language.ts': "export const names = { ko: '한국어', en: 'English' };",
      ...allowlist(permanent, {}),
    },
    (directory) => {
      assert.deepEqual(koreanLiteralErrors(directory), []);
      shrinkKoreanLiterals(directory);
      assert.deepEqual(readKoreanLiteralAllowlist(directory), { permanent, debt: {} });

      writeFileSync(
        join(directory, 'web/Language.ts'),
        "export const names = { ko: '한국어', en: '영어' };"
      );
      assert.match(koreanLiteralErrors(directory)[0], /2 Korean literals .* allows 1;/);

      writeFileSync(join(directory, 'web/Language.ts'), "export const names = { en: 'English' };");
      assert.deepEqual(koreanLiteralErrors(directory), [
        `${koreanLiteralAllowlistPath}: web/Language.ts has 0 Korean literals but its permanent entry keeps 1; correct the entry and its reason by hand`,
      ]);
      shrinkKoreanLiterals(directory);
      assert.deepEqual(readKoreanLiteralAllowlist(directory).permanent, permanent);
    }
  );
});

test('a file with permanent and debt literals owes only what exceeds the permanent count', () => {
  withRepository(
    {
      'web/Mixed.ts': "export const a = '한국어';\nexport const b = '제목';",
      ...allowlist(
        { 'web/Mixed.ts': { count: 1, reason: 'Its own name.' } },
        { 'web/Mixed.ts': 2 }
      ),
    },
    (directory) => {
      assert.deepEqual(koreanLiteralErrors(directory), [
        `${koreanLiteralAllowlistPath}: web/Mixed.ts now owes 1 Korean literals; lower its debt from 2 to 1 (node scripts/check-i18n.mjs --shrink)`,
      ]);
      assert.deepEqual(shrinkKoreanLiterals(directory).debt, { 'web/Mixed.ts': 1 });
    }
  );
});

test('the allowlist accepts only counted sections, and permanent entries need a reason', () => {
  for (const [content, pattern] of [
    [{ permanent: {}, debt: {}, extra: {} }, /only "permanent" and "debt"/],
    [{ permanent: { 'web/A.ts': { count: 1 } } }, /needs a positive count and a reason/],
    [{ debt: { 'web/A.ts': 0 } }, /needs a positive whole count/],
  ])
    withRepository({ [koreanLiteralAllowlistPath]: content }, (directory) =>
      assert.throws(() => readKoreanLiteralAllowlist(directory), pattern)
    );
});

test('npm run quality sees the Korean literal check through checkI18n', () => {
  withRepository(
    {
      'web/locales/view.ts':
        "export const messages = { 'view.title': { ko: '제목', en: 'Title', ja: 'タイトル', zh: '标题' } };",
      'web/View.tsx':
        "import { t } from './i18n.js';\nexport const a = t('view.title');\nexport const b = '제목';",
    },
    (directory) => {
      const { errors } = checkI18n(directory);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^web\/View\.tsx: 1 Korean literals \(lines 3\), none allowed;/);
    }
  );
});
