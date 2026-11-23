import { expect, test } from 'vitest';
import { literalTextSpans, type LiteralTextSpan } from '../web/literal-text.js';

function backtickSpans(text: string) {
  const runs = [...text.matchAll(/`+/gu)];
  const next = new Map<number, number>();
  const spans = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    const start = run.index;
    const length = run[0].length;
    const contentStart = start + length;
    const contentEnd = next.get(length) ?? contentStart;
    spans.set(start, contentEnd === contentStart ? contentStart : contentEnd + length);
    next.set(length, start);
  }
  return spans;
}

function literalFence(text: string, offset: number): string | undefined {
  if (offset && text[offset - 1] !== '\n') return;
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  const fence = text.slice(offset, lineEnd).match(/^ {0,3}(`{3,}|~{3,})([\s\S]*)$/u);
  if (!fence) return;
  let lineStart = lineEnd + 1;
  while (lineStart < text.length) {
    lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const closing = text.slice(lineStart, lineEnd).match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
    if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length)
      return text.slice(offset, lineEnd);
    lineStart = lineEnd + 1;
  }
  return text.slice(offset);
}

function sliceScanningSpans(text: string): LiteralTextSpan[] {
  const spans: LiteralTextSpan[] = [];
  const lastRubyClose = text.lastIndexOf('</ruby>');
  const lastTemplateClose = text.lastIndexOf('}}');
  const lastTagClose = text.lastIndexOf('>');
  const lastLinkClose = text.lastIndexOf('](');
  const codeSpans = backtickSpans(text);
  let plain = '';
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    const codeEnd = codeSpans.get(offset);
    const ruby =
      offset < lastRubyClose && rest.startsWith('<ruby>')
        ? text.slice(offset, text.indexOf('</ruby>', offset + 6) + 7)
        : undefined;
    const template =
      offset < lastTemplateClose && rest.startsWith('{{')
        ? text.slice(offset, text.indexOf('}}', offset + 2) + 2)
        : undefined;
    const tag =
      offset < lastTagClose && /^<\/?[A-Za-z]/u.test(rest)
        ? text.slice(offset, text.indexOf('>', offset + 1) + 1)
        : undefined;
    const protectedText =
      literalFence(text, offset) ??
      (codeEnd === undefined ? undefined : text.slice(offset, codeEnd)) ??
      ruby ??
      template ??
      rest.match(/^\[\[p_[a-f0-9]+_\d+\]\]/u)?.[0] ??
      (offset < lastLinkClose
        ? rest.match(/^!?\[[^\]\n]{1,1000}\]\([^\s)]{1,2000}\)/u)?.[0]
        : undefined) ??
      tag ??
      rest.match(/^(?:https?:\/\/|mailto:|www\.)[^\s<>“”‘’「」『』"]+/u)?.[0];
    if (protectedText) {
      if (plain) spans.push({ start: offset - plain.length, end: offset, literal: false });
      plain = '';
      spans.push({ start: offset, end: offset + protectedText.length, literal: true });
      offset += protectedText.length;
    } else plain += text[offset++];
  }
  if (plain) spans.push({ start: offset - plain.length, end: offset, literal: false });
  return spans;
}

const corpus = [
  '',
  '평범한 문장이에요.',
  '<ruby>漢字<rt>かんじ</rt></ruby>를 읽고 <ruby>끝나지 않은 루비',
  '<ruby></ruby><ruby>a</ruby></ruby> <ruby',
  '{{user}}가 {{char}}에게 {{img::등대}} {{끝나지 않음 }} {{}} {{{x}}}',
  '[[p_0af3_12]] [[p_xyz_1]] [[p_0af3_]] [[[p_1_2]]]',
  '[등대](https://example.com/a) ![그림](asset/a.png) [깨진](링크 [빈]() [a](b',
  '!![a](b)! [a]\n(b) [a](b c) [](x) [a](x))',
  `[${'a'.repeat(1000)}](x) [${'a'.repeat(1001)}](x) [a](${'b'.repeat(2001)})`,
  '<b>굵게</b> <br/> </p> <1> < a> <a href="x">링크</a> a < b > c <unfinished',
  'https://example.com/길?a=1&b=2. http://a.b“인용” mailto:a@b.c www.example.com ww.x https:/x',
  'https://a.b<c> https://a.b「c」 hhttps://x mwww.a.b whttp://x',
  '`code` ``a`b`` ```c``` `끝나지 않은 ``두 번 `` ` ` ```',
  '```ts\nconst a = `x`;\n```\n뒤 문장',
  '   ```\n들여쓴 펜스\n   ```   \n    ```\n네 칸은 펜스가 아니에요',
  '~~~\n물결 펜스 ```\n~~~~\n뒤',
  '```\n닫히지 않은 펜스\n\n{{user}} <b>',
  '앞 ``` 줄 중간 ```\n```\n~~~\n```',
  ' ~ ` ~~ `` \n ~~~x\n~~~',
  '줄\r\n```\r\n코드\r\n```\r\n끝',
  '😀 <ruby>😀</ruby> {{😀}} [😀](😀) `😀` https://😀.example/😀 \ud83d <b\ud83d> \ude00https://x',
  '「대사」 『속』 “큰” ‘작은’ "곧은" https://a.b"c https://a.b‘c',
  '{{a}}<ruby>b</ruby>[c](d)`e`https://f [[p_a_1]]<g>',
  '<ruby>{{a}}`b`</ruby> {{<b>`c`}} [`d`](e) `<f>{{g}}`',
  '\n\n \n```\n\n```\n\n',
  'h m w ! [ { < ` ~ hm wm http mailto www. https://',
];

function fuzzed(seed: number) {
  const tokens = [
    '<ruby>',
    '</ruby>',
    '{{',
    '}}',
    '[[p_a1_2]]',
    '[',
    '](',
    ')',
    '!',
    '<',
    '</',
    '>',
    '`',
    '``',
    '```',
    '~~~',
    '\n',
    '\r\n',
    ' ',
    '   ',
    'https://a.b',
    'mailto:a',
    'www.c',
    '가',
    '😀',
    '\ud83d',
    '\ude00',
    'x',
    '"',
    '「',
  ];
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: 1 + (next() % 40) }, () => tokens[next() % tokens.length]).join('');
}

test('the linear literal scanner yields the spans of the slice-per-character scanner', () => {
  for (const text of corpus) expect(literalTextSpans(text), text).toEqual(sliceScanningSpans(text));
  for (let seed = 1; seed <= 4000; seed++) {
    const text = fuzzed(seed);
    expect(literalTextSpans(text), JSON.stringify(text)).toEqual(sliceScanningSpans(text));
  }
});

test('spans cover the text in order without gaps', () => {
  for (const text of corpus) {
    const spans = literalTextSpans(text);
    expect(spans.map((span) => text.slice(span.start, span.end)).join('')).toBe(text);
    expect(spans.every((span) => span.start < span.end)).toBe(true);
  }
});

test('a long scene is scanned in time proportional to its length', () => {
  const paragraph =
    '등대의 불빛이 파도 위를 건너갔다. "어디로 가?" 미라가 물었다. [지도](map) `코드`\n\n';
  const text = paragraph.repeat(Math.ceil(240_000 / paragraph.length));
  const started = performance.now();
  const spans = literalTextSpans(text);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(spans.map((span) => text.slice(span.start, span.end)).join('')).toBe(text);
});
