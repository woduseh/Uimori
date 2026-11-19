import { A2uiGenerator, CatalogConfig, ExpressFormatFactory } from '@a2ui/agent';
import { describe, expect, it } from 'vitest';
import { storyUiCatalog } from '../core/story-ui-catalog.js';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { parseStoryUi, projectStoryUiText, validateStoryUiAction } from '../core/story-ui.js';
import { resolveStoryUiPresentation, resolveStoryUiStyle } from '../core/story-ui-style.js';
import { prepareStoryUiTranslation } from '../core/story-ui-translation.js';
import {
  defaultThemePreferences,
  emptyTheme,
  type Theme,
  type ThemeCatalog,
} from '../core/themes.js';
import { normalizeStoryUiOutput, storyUiPrompt } from '../server/story-ui.js';

describe('story UI', () => {
  it('teaches placement with examples that compile, without form-assistant boilerplate', () => {
    const prompt = storyUiPrompt();
    const examples = parseStoryUi(
      normalizeStoryUiOutput(
        prompt.slice(prompt.indexOf('## Examples'), prompt.indexOf('## Rules'))
      )
    );
    const kinds = examples.map((part) => part.kind);
    expect(kinds.filter((kind) => kind === 'ui').length).toBeGreaterThanOrEqual(4);
    expect(kinds).not.toContain('invalid');
    expect(kinds).not.toContain('pending');
    // The first example shows blocks inside a scene: prose, block, prose, block, prose.
    expect(kinds.slice(0, 5)).toEqual(['prose', 'ui', 'prose', 'ui', 'prose']);
    for (const noise of ['dummy click', 'Surface targeting', '- weight:'])
      expect(prompt).not.toContain(noise);
    expect(prompt).toContain('One chat bubble.');
    expect(prompt.indexOf('## Where it goes')).toBeLessThan(prompt.indexOf('## Block syntax'));
  });
  it('keeps the SDK’s positional and required arguments in the compact writing reference', () => {
    const catalog = new CatalogConfig(storyUiCatalog);
    const sdk = new A2uiGenerator([catalog], undefined, new ExpressFormatFactory());
    const processor = sdk.createProcessor({ '1.0': { supportedCatalogIds: [catalog.catalog.id] } });
    const signatures = [...processor.promptSnippet.matchAll(/^• (\w+)\((.*)\)$/gm)];
    expect(signatures).toHaveLength(storyUiCatalog.components.size + storyUiCatalog.functions.size);
    const lines = storyUiPrompt().split('\n');
    for (const [, name, args] of signatures) {
      const line = lines.find((entry) => entry.startsWith(`${name}(`));
      expect(line, name).toBeDefined();
      const signature = line!
        .split(') ')[0]
        .slice(name.length + 1)
        .replace(/\{[^{}]*\}/g, '{}');
      const names = [...signature.matchAll(/(?:^|, )(\w+\??):/g)].map((match) => match[1]);
      expect(names, name).toEqual(args.replace(/ \([^)]*\)/g, '').split(', '));
    }
  });
  it('keeps decoration and block CSS out of wording and translation, and images on stored paths', () => {
    const block = (frame: string) => `<a2ui>
$/_uimori/css = r"""& { --story-paper: #101018; } .look-plate { letter-spacing: .2em; }"""
root = Frame(body, "관제실", ${frame})
body = Column([
  Hero("제7구역", "접근 제한", "/api/assets/city", "LOCATION"),
  Dialogue("돌아보지 마.", "레이", "/api/assets/ray", "낮게"),
  Ring("동기화", 72, 0, 100, "%"),
  Text("판정", variant="display", look="plate")
])
</a2ui>`;
    const stored = normalizeStoryUiOutput(
      block('surface="glow", ornament="corners", backdrop="/api/assets/city"')
    );
    expect(parseStoryUi(stored)[0].kind).toBe('ui');
    const wording = projectStoryUiText(stored);
    for (const value of ['관제실', '제7구역', 'LOCATION', '레이', '돌아보지 마.', '낮게', '72'])
      expect(wording).toContain(value);
    for (const hidden of ['story-paper', 'look-plate', 'glow', 'corners', '/api/assets'])
      expect(wording).not.toContain(hidden);
    const translation = prepareStoryUiTranslation(stored);
    expect(translation.text).toContain('레이');
    expect(translation.text).not.toContain('story-paper');
    expect(translation.text).not.toContain('plate');
    for (const invalid of ['surface="lava"', 'look="Not Valid!"'])
      expect(parseStoryUi(normalizeStoryUiOutput(block(invalid)))[0].kind).toBe('invalid');
  });
  it('translates day headings and entries of a schedule without touching its indexes', () => {
    const stored = normalizeStoryUiOutput(`<a2ui>
root = Column([
  Schedule(["월", "화"], [{day: 1, title: "보컬 레슨", time: "16:00"}], "이번 주", current=1),
  Rank("S", "보컬", stars=5),
  Slot("응원봉", value=12, rarity="rare"),
  Compare([{label: "사키", value: 152}, {label: "탑", value: 620, text: "무대"}], unit="cm"),
  Combatant("아리엘", [{label: "체력", value: 412, max: 520}], "성기사", effects=[{label: "중독", tone: "danger"}], state="active")
])
</a2ui>`);
    expect(parseStoryUi(stored)[0].kind).toBe('ui');
    const wording = projectStoryUiText(stored);
    for (const value of ['월', '화', '보컬 레슨', '이번 주', 'S', '응원봉', '12', '사키', '무대'])
      expect(wording).toContain(value);
    // A battle readout is read as who, how much of what, and what afflicts them.
    for (const value of ['아리엘', '성기사', '체력', '412', '520', '중독'])
      expect(wording).toContain(value);
    expect(wording).not.toContain('active');
    const translation = prepareStoryUiTranslation(stored);
    const strings: string[] = JSON.parse(
      translation.text.replace(/<\/?UIMORI_UI_TRANSLATION_0>/g, '')
    );
    expect(strings).toEqual(expect.arrayContaining(['월', '화', '보컬 레슨', '응원봉', '무대']));
    expect(strings).not.toContain('rare');
    const restored = translation.restore(
      translation.text.replace('"화"', '"Tue"').replace('"보컬 레슨"', '"Vocal lesson"')
    );
    const segment = parseStoryUi(restored)[0];
    if (segment.kind !== 'ui') throw new Error('translated schedule did not validate');
    const schedule = (
      segment.messages[0] as unknown as {
        createSurface: { components: Record<string, unknown>[] };
      }
    ).createSurface.components.find((component) => component.component === 'Schedule')!;
    expect(schedule.days).toEqual(['월', 'Tue']);
    expect(schedule.items).toEqual([{ day: 1, title: 'Vocal lesson', time: '16:00' }]);
    expect(schedule.current).toBe(1);
  });
  it('reads relations with their ends, translates map and calendar wording, and pins node portraits', () => {
    const stored = normalizeStoryUiOutput(
      `<a2ui>
root = Column([
  Graph([{id: "me", label: "나"}, {id: "yun", label: "한서윤", text: "소꿉친구", image: "{{img::서윤}}"}, {id: "x", label: "발신인", state: "unknown"}], [{from: "yun", to: "me", label: "짝사랑"}, {from: "x", to: "me", line: "dashed"}], "관계도", center="me"),
  Map(4, 3, [{x: 0, y: 0, w: 2, label: "교실", terrain: "floor"}], [{x: 1, y: 2, label: "경비원", mark: "경", text: "순찰 중", tone: "danger"}], coords=true),
  Calendar("12월", [{date: 24, title: "크리스마스 공연", time: "19:00"}], month="2026-12", days=["일", "월", "화", "수", "목", "금", "토"], current=19)
])
</a2ui>`,
      (name) => ({ 서윤: '/api/assets/yun' })[name]
    );
    const segment = parseStoryUi(stored)[0];
    if (segment.kind !== 'ui') throw new Error('graph, map and calendar did not validate');
    expect(segment.imageUrls).toEqual({ 서윤: '/api/assets/yun' });
    const wording = projectStoryUiText(stored);
    expect(wording).toContain('한서윤 → 나: 짝사랑');
    expect(wording).toContain('발신인 → 나');
    for (const value of [
      '소꿉친구',
      '교실',
      '경비원',
      '순찰 중',
      '12월',
      '크리스마스 공연',
      '19:00',
    ])
      expect(wording).toContain(value);
    for (const value of ['yun', 'dashed', 'floor', '2026-12']) expect(wording).not.toContain(value);
    const translation = prepareStoryUiTranslation(stored);
    const strings: string[] = JSON.parse(
      translation.text.replace(/<\/?UIMORI_UI_TRANSLATION_0>/g, '')
    );
    expect(strings).toEqual(
      expect.arrayContaining([
        '한서윤',
        '짝사랑',
        '교실',
        '경비원',
        '순찰 중',
        '크리스마스 공연',
        '일',
      ])
    );
    // Ids, the token mark and the month are host-owned: translating them would break the layout.
    for (const value of ['yun', 'me', '경', '2026-12']) expect(strings).not.toContain(value);
  });
  it('reads composed media as wording, or as the expression a writer continues from', () => {
    const expression = `<a2ui>
root = Frame(chat, "한서윤", kind="app", accent="amber")
chat = Column([
  Message("어디야", "한서윤", "23:41"),
  Post("본문", "익명", "제목", tag="목격"),
  Stat("상태", "양호"),
  Gauge("체력", 64, 0, 120),
  KeyValue([{label: "종족", value: "엘프"}]),
  ChoicePicker("진입로", "mutuallyExclusive", [{label: "북쪽 능선", value: "north"}], $/route)
])
</a2ui>`;
    const stored = normalizeStoryUiOutput(`앞
${expression}
뒤`);
    expect(parseStoryUi(stored)[1].kind).toBe('ui');
    const wording = projectStoryUiText(stored);
    for (const value of [
      '한서윤',
      '23:41',
      '어디야',
      '목격',
      '제목',
      '양호',
      '64',
      '엘프',
      '북쪽 능선',
    ])
      expect(wording).toContain(value);
    for (const hidden of ['amber', 'app', 'north', 'Frame']) expect(wording).not.toContain(hidden);
    expect(wording.indexOf('한서윤')).toBeLessThan(wording.indexOf('어디야'));
    expect(projectStoryUiText(stored, 'expression')).toBe(`앞
${expression}
뒤`);
    const prepared = prepareStoryUiTranslation(stored);
    expect(prepared.text).toContain('양호');
    expect(prepared.text).toContain('엘프');
    for (const hidden of ['amber', 'north', '"64"']) expect(prepared.text).not.toContain(hidden);
  });
  it('keeps a block whose portrait is not a stored image, pinning only names the card knows', () => {
    const block = (avatar: string) => {
      const part = parseStoryUi(
        normalizeStoryUiOutput(
          `<a2ui>root = Message("안녕", "미라", avatar=${JSON.stringify(avatar)})</a2ui>`,
          (name) => (name === 'Mira_smile' ? '/api/assets/mira' : undefined)
        )
      )[0];
      return part.kind === 'ui' ? (part.imageUrls ?? {}) : part.kind;
    };
    const pinned = { Mira_smile: '/api/assets/mira' };
    for (const known of [
      '{{img::Mira_smile}}',
      '{{ img::Mira_smile }} ',
      '{{raw::Mira_smile}}',
      '{{emotion::Mira_smile}}',
    ])
      expect(block(known), known).toEqual(pinned);
    for (const unknown of [
      '/api/assets/mira',
      '{{img::Mira_frown}}',
      'Mira_smile',
      '<img src="Mira_smile">',
      'https://example.com/mira.png',
    ])
      expect(block(unknown), unknown).toEqual({});
  });
  it('accepts ordinary event data whose field names resemble function metadata', () => {
    const source = normalizeStoryUiOutput(
      '<a2ui>root = Button(Text("Call"), action=Event("contact", {call: "Mira", functionCall: "phone"}))</a2ui>'
    );
    const segment = parseStoryUi(source)[0];
    expect(segment.kind).toBe('ui');
    expect(
      validateStoryUiAction(source, segment.id, 'contact', { call: 'Mira', functionCall: 'phone' })
    ).not.toBeNull();
  });
  it('persists a model-selected style through translation and honors the chat override', () => {
    const expression = '<a2ui>\n$/_uimori/style = "blue-archive"\nroot = Text("Hello")\n</a2ui>';
    const stored = normalizeStoryUiOutput(expression);
    const segment = parseStoryUi(stored)[0];
    expect(segment.kind).toBe('ui');
    if (segment.kind !== 'ui') throw new Error('UI missing');
    expect(resolveStoryUiStyle(undefined, segment.messages)).toBe('blue-archive');
    expect(resolveStoryUiStyle('auto', segment.messages)).toBe('blue-archive');
    expect(resolveStoryUiStyle('default', segment.messages)).toBe('default');
    expect(resolveStoryUiStyle('modern', segment.messages)).toBe('modern');
    expect(projectStoryUiText(stored)).not.toContain('blue-archive');
    const prepared = prepareStoryUiTranslation(stored);
    expect(prepared.text).not.toContain('blue-archive');
    const restored = prepared.restore(prepared.text.replace('Hello', '안녕'));
    const translated = parseStoryUi(restored)[0];
    if (translated.kind !== 'ui') throw new Error('Translated UI missing');
    expect(resolveStoryUiStyle(undefined, translated.messages)).toBe('blue-archive');
    expect(projectStoryUiText(restored)).toContain('안녕');
    const unknown = normalizeStoryUiOutput(expression.replace('blue-archive', 'unknown'));
    const fallback = parseStoryUi(unknown)[0];
    if (fallback.kind !== 'ui') throw new Error('UI missing');
    expect(resolveStoryUiStyle(undefined, fallback.messages)).toBe('default');
  });
  it('resolves story UI themes in chat, bot and model order', () => {
    const botTheme: Theme = {
      ...emptyTheme('Bot theme'),
      id: 'bot-theme',
      revision: 1,
      storyUi: { baseStyle: 'fantasy', css: ':host { color: red; }' },
    };
    const chatTheme: Theme = {
      ...emptyTheme('Chat theme'),
      id: 'chat-theme',
      revision: 2,
      storyUi: { baseStyle: 'east-asian', css: ':host { color: blue; }' },
    };
    const catalog: ThemeCatalog = {
      themes: [botTheme, chatTheme],
      preferences: { ...defaultThemePreferences(), botStoryUiThemes: { bot: botTheme.id } },
    };
    const [segment] = parseStoryUi(
      normalizeStoryUiOutput(
        '<a2ui>\n$/_uimori/style = "theme:chat-theme"\nroot = Text("Hello")\n</a2ui>'
      )
    );
    if (segment.kind !== 'ui') throw new Error('UI missing');
    const { messages } = segment;
    expect(resolveStoryUiPresentation('modern', messages, catalog, 'bot')).toEqual({
      style: 'modern',
    });
    expect(resolveStoryUiPresentation('theme:chat-theme', [], catalog, 'bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    for (const setting of ['auto', undefined] as const)
      expect(resolveStoryUiPresentation(setting, messages, catalog, 'bot')).toEqual({
        style: 'fantasy',
        theme: botTheme,
      });
    expect(resolveStoryUiPresentation('auto', messages, catalog, 'another-bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    expect(resolveStoryUiPresentation('theme:deleted', messages, catalog, 'bot')).toEqual({
      style: 'east-asian',
      theme: chatTheme,
    });
    expect(resolveStoryUiPresentation('auto', messages, { ...catalog, themes: [] }, 'bot')).toEqual(
      {
        style: 'default',
      }
    );
  });
  it('reads a long valid block after storing both expression and compiled content', () => {
    const expression = `<a2ui>root = Column([${Array.from({ length: 10 }, () => `Text("${'x'.repeat(6000)}")`).join(',')}])</a2ui>`;
    const normalized = normalizeStoryUiOutput(expression);
    expect(normalized.length).toBeGreaterThan(100_000);
    expect(parseStoryUi(normalized)[0].kind).toBe('ui');
  });
  it('compiles independent blocks and preserves prose and the original expression', () => {
    const expression =
      '<a2ui>root = Column([Text("Archive"), BarChart(title="Years", items=[{label: "Spring", value: 12}])])</a2ui>';
    const source = `Before\n${expression}\nAfter`;
    const result = normalizeStoryUiOutput(source);
    const segments = parseStoryUi(result);
    expect(segments.map((segment) => segment.kind)).toEqual(['prose', 'ui', 'prose']);
    expect(segments[1]).toMatchObject({ expression });
    expect(projectStoryUiText(result)).toContain('Spring\n12');
    expect(normalizeStoryUiOutput(result)).toBe(result);
  });
  it('renders an inline expression as a block while preserving surrounding text', () => {
    const source = 'Before <a2ui>root=Text("x")</a2ui> After';
    const result = normalizeStoryUiOutput(source);
    const segments = parseStoryUi(result);
    expect(segments.map((part) => part.kind)).toEqual(['prose', 'ui', 'prose']);
    expect(result.startsWith('Before \n')).toBe(true);
    expect(result.endsWith('\n After')).toBe(true);
    expect(normalizeStoryUiOutput(result)).toBe(result);
    const slots = segments
      .filter((part) => part.kind === 'ui')
      .map(({ id, start }) => ({ id, start }));
    expect(compileReadingMarkdown(result, [], [], slots).html).toContain(
      `data-story-ui-slot="${slots[0].id}"`
    );
  });
  it('preserves Markdown inline and fenced code containing expressions', () => {
    for (const source of [
      'Before `<a2ui>root=Text("x")</a2ui>` After',
      'Before ``<a2ui>root=Text("x")</a2ui>`` After',
      'Before `<a2ui>root=Text("x")\n</a2ui>` After',
      '```example\n<a2ui>root = Text("code")</a2ui>\n```',
    ]) {
      expect(normalizeStoryUiOutput(source)).toBe(source);
      expect(parseStoryUi(source).map((part) => part.kind)).toEqual(['prose']);
    }
  });
  it('keeps repeated list data and accepts bound images and icons', () => {
    const expression = `<a2ui>
$/people = [{name: "Mira", portrait: "/api/assets/mira", icon: "person"}, {name: "Sol", portrait: "/api/assets/sol", icon: "person"}]
item = Row([Image($portrait, description=$name), Icon($icon), Text($name)])
root = List(_template($/people, item))
</a2ui>`;
    const result = normalizeStoryUiOutput(expression);
    expect(parseStoryUi(result)[0].kind).toBe('ui');
    expect(projectStoryUiText(result)).toContain('"name":"Mira"');
    expect(projectStoryUiText(result)).toContain('"name":"Sol"');
    const party = normalizeStoryUiOutput(`<a2ui>
$/party = [{name: "Mira", hp: 30, state: "Hurt"}]
row = Row([Stat($name, $state), Gauge($name, $hp, 0, 100)])
root = List(_template($/party, row))
</a2ui>`);
    expect(parseStoryUi(party)[0].kind).toBe('ui');
  });
  it('pins card image names for literal and bound images without rewriting text or action values', () => {
    const expression = `<a2ui>
$/people = [{portrait: "{{img::미라_미소}}"}]
root = Column([List(_template($/people, row)), Avatar("솔", "{{img::솔}}"), Image("{{img::없는그림}}")])
row = Button(Image($portrait), action=Event("select", {original: $portrait}))
</a2ui>`;
    const stored = normalizeStoryUiOutput(
      expression,
      (name) => ({ 미라_미소: '/api/assets/mira', 솔: '/api/assets/sol' })[name]
    );
    const segment = parseStoryUi(stored)[0];
    expect(segment.kind).toBe('ui');
    if (segment.kind !== 'ui') throw new Error('Expected a compiled block');
    expect(segment.imageUrls).toEqual({ 미라_미소: '/api/assets/mira', 솔: '/api/assets/sol' });
    expect(segment.expression).toBe(expression);
    expect(segment.messages[0]).toMatchObject({
      createSurface: { dataModel: { people: [{ portrait: '{{img::미라_미소}}' }] } },
    });
    const translated = prepareStoryUiTranslation(stored);
    expect(parseStoryUi(translated.restore(translated.text))[0]).toEqual(segment);
    expect(
      parseStoryUi(stored.replace('/api/assets/mira', 'https://outside.invalid/1'))[0].kind
    ).toBe('invalid');
  });
  it('keeps invalid and unfinished output visible without losing adjacent text', () => {
    const source = 'A<a2ui>root = Unknown()</a2ui>B<a2ui>root =';
    expect(normalizeStoryUiOutput(source)).toBe(source);
    expect(parseStoryUi(source).map((part) => part.kind)).toEqual([
      'prose',
      'invalid',
      'prose',
      'pending',
    ]);
  });
  it('rejects tampered components', () => {
    const valid = normalizeStoryUiOutput('<a2ui>root = Text("hello")</a2ui>');
    expect(parseStoryUi(valid)[0].kind).toBe('ui');
    expect(parseStoryUi(valid.replace('"component":"Text"', '"component":"Video"'))[0].kind).toBe(
      'invalid'
    );
  });
  it('accepts resolved function context for a declared button event', () => {
    const source = normalizeStoryUiOutput(`<a2ui>
$/name = "Mira"
root = Button(Text("Greet"), action=Event("greet", {message: formatString("Hello \${/name}")}))
</a2ui>`);
    const segment = parseStoryUi(source)[0];
    expect(segment.kind).toBe('ui');
    expect(
      validateStoryUiAction(source, segment.id, 'greet', { message: 'Hello Mira' }, 'root')
    ).not.toBeNull();
    expect(
      validateStoryUiAction(source, segment.id, 'greet', { message: 'Hello Mira' }, 'other')
    ).toBeNull();
    expect(validateStoryUiAction(source, segment.id, 'greet', { other: 'Hello Mira' })).toBeNull();
    expect(
      validateStoryUiAction(source, segment.id, 'other', { message: 'Hello Mira' })
    ).toBeNull();
  });
  it('requires declared fixed dice dimensions and rejects tampered or out-of-range rolls', () => {
    const source = normalizeStoryUiOutput(
      '<a2ui>root=Button(Text("Roll"), action=Event("roll", {sides: 6, count: 2}))</a2ui>'
    );
    const segment = parseStoryUi(source)[0];
    expect(
      validateStoryUiAction(source, segment.id, 'roll', { sides: 6, count: 2 })
    ).not.toBeNull();
    expect(validateStoryUiAction(source, segment.id, 'roll', { sides: 20, count: 2 })).toBeNull();
    const invalid = normalizeStoryUiOutput(
      '<a2ui>root=Button(Text("Roll"), action=Event("roll", {sides: 1001}))</a2ui>'
    );
    expect(
      validateStoryUiAction(invalid, parseStoryUi(invalid)[0].id, 'roll', { sides: 1001 })
    ).toBeNull();
  });
});
