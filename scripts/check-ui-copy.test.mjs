import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { scanSource } from './check-ui-copy.mjs';

const help = '입력한 설정은 다음 작업부터 적용하며 기존 기록은 바꾸지 않아요.';
const long = '가'.repeat(98) + '😀나';

test('Korean JSX indentation and inline emphasis preserve exact local duplicate text and location', () => {
  const warnings = scanSource(
    `const view = <section>
  <p>
    입력한 <strong>설정</strong>은 다음 작업부터 적용하며
    기존 기록은 바꾸지 않아요.
  </p>
  <small>${help}</small>
</section>;`,
    'web/example.tsx'
  );
  assert.deepEqual(warnings, [
    {
      file: 'web/example.tsx',
      line: 6,
      rule: 'duplicate-help',
      text: help,
      relatedLine: 2,
    },
  ]);
  assert.deepEqual(
    scanSource('const view = <><p>아<em>주</em>짧음</p><small>아 주 짧음</small></>'),
    []
  );
});

test('long help counts Unicode characters and retains literal expressions without evaluating variables', () => {
  const warnings = scanSource(`const view = <section>
    <p>${'가'.repeat(98)}😀</p>
    <p>${'가'.repeat(98)}<strong>😀</strong>{'나'}</p>
    <p>{manuscript}</p>
    <p>${long}{dynamic}</p>
  </section>;`);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, 'long-help');
  assert.equal(warnings[0].line, 3);
  assert.equal(warnings[0].text, long);
});

test('exact duplicates stay within one JSX parent and one conditional branch', () => {
  const warnings = scanSource(`const view = <main>
    <section><p>${help}</p><small>${help}</small></section>
    <section><p>${help}</p></section>
    {flag ? <p>${help}</p> : <p>${help}</p>}
    {other && <p>${help}</p>}
    <p>저장됨</p><small>저장됨</small>
  </main>;
  const First = () => <p>${help}</p>;
  const Second = () => <p>${help}</p>;`);
  assert.deepEqual(
    warnings.map(({ rule, line, relatedLine }) => ({ rule, line, relatedLine })),
    [{ rule: 'duplicate-help', line: 2, relatedLine: 2 }]
  );
});

test('closed disclosures, user prose, status and control text are outside the copy rules', () => {
  const paragraph = `<p>${long}</p>`;
  const excluded = [
    `<details>${paragraph}</details>`,
    `<details open={false}>${paragraph}</details>`,
    `<details open={expanded}>${paragraph}</details>`,
    `<LazyDiagnostics>{() => ${paragraph}}</LazyDiagnostics>`,
    `<pre>${paragraph}</pre>`,
    `<code>${paragraph}</code>`,
    `<Prose>${paragraph}</Prose>`,
    `<RisuMessageSurface>${paragraph}</RisuMessageSurface>`,
    `<div dangerouslySetInnerHTML={{__html: manuscript}}>${paragraph}</div>`,
    `<div contentEditable>${paragraph}</div>`,
    `<div hidden>${paragraph}</div>`,
    `<div hidden={hidden}>${paragraph}</div>`,
    `<div aria-hidden="true">${paragraph}</div>`,
    `<div className="sr-only">${paragraph}</div>`,
    `<div className="validation-message">${paragraph}</div>`,
    `<div className="error">${paragraph}</div>`,
    `<div className="connection-notice">${paragraph}</div>`,
    `<div role="alert">${paragraph}</div>`,
    `<div role="alertdialog">${paragraph}</div>`,
    `<div role="status">${paragraph}</div>`,
    `<p role="button">${long}</p>`,
    `<div aria-live="polite">${paragraph}</div>`,
    `<Tooltip>${paragraph}</Tooltip>`,
    `<div role="tooltip">${paragraph}</div>`,
    `<label>${paragraph}</label>`,
    `<button>${paragraph}</button>`,
    `<details open><summary>${paragraph}</summary></details>`,
    `<div title="${long}" aria-label="${long}" />`,
    `<div data-testid="source-text">${paragraph}</div>`,
    `<p><span hidden>${long}</span>짧은 설명</p>`,
  ];
  for (const source of excluded)
    assert.deepEqual(scanSource(`const view = ${source};`), [], source);
  const visible = scanSource(
    `const view = <details open={true}><div hidden={false} aria-hidden={false}>${paragraph}</div></details>;`
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].rule, 'long-help');
});

test('conditionals remain inspectable and static help repeated by a map is reported once', () => {
  const warnings = scanSource(`const view = <>
    {enabled && <p>${long}</p>}
    {items.map((item) => <li>
      <p>${help}</p>
      <small>현재 저장된 모듈을 사용해요.</small>
      <p>{item.help}</p>
      <small>{item.name} ${help}</small>
    </li>)}
  </>;`);
  assert.deepEqual(
    warnings.map(({ rule, line }) => ({ rule, line })),
    [
      { rule: 'long-help', line: 2 },
      { rule: 'repeated-item-help', line: 4 },
      { rule: 'repeated-item-help', line: 5 },
    ]
  );
});

test('nearby placeholder guidance matches exact expressions through labels without evaluation', () => {
  const warnings = scanSource(`const view = <section>
    <label>계획<textarea placeholder={OUTLINE_GUIDANCE[draft.level]} /></label>
    <input placeholder={OUTLINE_GUIDANCE[draft.level]} />
    <p>{OUTLINE_GUIDANCE[ draft.level ]} 모두 채울 필요는 없어요.</p>
    <section><p>{OUTLINE_GUIDANCE[draft.level]}</p></section>
    {flag ? <input placeholder={otherGuide} /> : <p>{otherGuide}</p>}
  </section>;`);
  assert.deepEqual(warnings, [
    {
      file: 'input.tsx',
      line: 4,
      rule: 'placeholder-help',
      text: '{…} 모두 채울 필요는 없어요.',
      relatedLine: 2,
    },
  ]);
});

test('literal placeholders match explanatory text but short labels and different expressions do not', () => {
  const warnings = scanSource(`const view = <main>
    <section><input placeholder="${help}" /><p>${help} 추가 설명이에요.</p></section>
    <section><input placeholder="이름" /><p>이름을 입력해 주세요.</p></section>
    <section><input placeholder={getGuide('one two')} /><p>{getGuide('onetwo')}</p></section>
    <section><input placeholder={guide.first} /><p>{guide.second}</p></section>
  </main>;`);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, 'placeholder-help');
  assert.equal(warnings[0].line, 2);
});

test('CLI recursively reports SOURCE warnings with exit zero and syntax errors as incomplete', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-copy-'));
  const script = fileURLToPath(new URL('./check-ui-copy.mjs', import.meta.url));
  try {
    mkdirSync(join(directory, 'web', 'nested'), { recursive: true });
    writeFileSync(join(directory, 'web', 'nested', 'example.tsx'), `const view = <p>${long}</p>;`);
    writeFileSync(join(directory, 'web', 'ignored.ts'), 'not parsed: <');
    const run = () =>
      spawnSync(process.execPath, [script, '--json'], { cwd: directory, encoding: 'utf8' });
    const complete = run();
    assert.ifError(complete.error);
    assert.equal(complete.status, 0, complete.stderr);
    const report = JSON.parse(complete.stdout);
    assert.equal(report.status, 'complete');
    assert.equal(report.files, 1);
    assert.match(report.scope, /SOURCE.*runtime visibility/u);
    assert.deepEqual(
      report.warnings.map(({ file, rule }) => ({ file, rule })),
      [{ file: 'web/nested/example.tsx', rule: 'long-help' }]
    );
    writeFileSync(join(directory, 'web', 'broken.tsx'), 'const view = <p>');
    const incomplete = run();
    assert.ifError(incomplete.error);
    assert.equal(incomplete.status, 1);
    const failed = JSON.parse(incomplete.stdout);
    assert.equal(failed.status, 'incomplete');
    assert.equal(failed.warnings.length, 1);
    assert.equal(failed.errors.length, 1);
    assert.equal(failed.errors[0].file, 'web/broken.tsx');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
