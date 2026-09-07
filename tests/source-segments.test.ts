import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { defaultProfile, type ProfileSnapshot } from '../core/product.js';
import type { ContentPackage } from '../core/content-package.js';
import type { PromptControl } from '../core/prompt-program.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import {
  filterSourceSegments,
  parseSourceSegments,
  resolveSourceSegmentPolicy,
  segmentTranslationMarkers,
  validateSegmentTranslation,
  validateSourceSegmentPolicy,
  type SegmentSource,
  type SourceSegmentPolicy,
} from '../core/source-segments.js';

const source = (text: string, sourceRevision = 'synthetic-source'): SegmentSource => ({
  text,
  sourceRevision,
  sourceHash: createHash('sha256').update(text).digest('hex'),
});
const policy = (): SourceSegmentPolicy => ({
  version: 1,
  rules: [
    {
      id: 'perspective',
      kind: 'aside',
      open: '[[aside:',
      close: '[[/aside]]',
      match: 'line',
      title: true,
      label: '다른 시점',
      scene: { open: '⟬', close: '⟭', separator: '::' },
      portrait: { open: '[portrait:', close: ']' },
    },
    {
      id: 'audit',
      kind: 'annotation',
      open: '<audit>',
      close: '</audit>',
      match: 'inline',
      label: '기록',
    },
  ],
});
const sample = () =>
  source(
    'First main paragraph.\r\n\r\n  [[aside: Quiet bell  \r\n⟬Tower :: Morning :: Mira⟭\r\n[portrait: resource:coat@1]\r\n\r\nMira imagines a silent bell. 😀\r\n[[/aside]]\r\n\r\nAnother main paragraph.\r\n<audit>Only a commentary.</audit>\r\nLast main paragraph.'
  );
const excludePolicy = (): SourceSegmentPolicy => ({
  version: 1,
  rules: policy().rules.map((rule) => ({ ...rule, exclude: true })),
});

describe('package-authored source segments', () => {
  test('arbitrary literal delimiters partition exact CRLF and UTF-16 ranges without granting knowledge', () => {
    const raw = sample(),
      before = structuredClone(raw),
      parsed = parseSourceSegments(raw, policy());
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.segments.map((segment) => segment.kind)).toEqual([
      'main',
      'aside',
      'main',
      'annotation',
      'main',
    ]);
    expect(
      parsed.segments
        .map((segment) => raw.text.slice(segment.range.start, segment.range.end))
        .join('')
    ).toBe(raw.text);
    const aside = parsed.segments[1];
    expect(aside.title).toBe('Quiet bell');
    expect(raw.text.slice(aside.titleRange!.start, aside.titleRange!.end)).toBe('Quiet bell');
    expect(aside.scene).toMatchObject({ place: 'Tower', time: 'Morning', subjectLabel: 'Mira' });
    expect(aside.portrait!.raw).toBe('resource:coat@1');
    expect(raw.text.slice(aside.bodyRange.start, aside.bodyRange.end)).toContain(
      'Mira imagines a silent bell. 😀'
    );
    expect(aside.knowledge).toEqual({
      status: 'unknown',
      mode: 'unspecified',
      perspectiveActorIds: null,
      knownByActorIds: null,
      evidence: [],
    });
    expect(raw).toEqual(before);
    expect(parseSourceSegments(raw, policy())).toEqual(parsed);
    expect(parseSourceSegments(source(raw.text + ' changed'), policy()).segments[1].id).not.toBe(
      aside.id
    );
  });

  test('unattached or disabled policies leave both current and retired marker syntax uninterpreted', () => {
    const raw = source(
      sample().text +
        '\n@hsTitle: A retired marker\nbody\n@hs\n<EvaluationReport>old report</EvaluationReport>'
    );
    for (const unselected of [undefined, { version: 1, rules: [] } as SourceSegmentPolicy]) {
      const parsed = parseSourceSegments(raw, unselected);
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0]).toMatchObject({
        kind: 'main',
        range: { start: 0, end: raw.text.length },
      });
      expect(parsed.diagnostics).toEqual([]);
      expect(segmentTranslationMarkers(raw, unselected)).toEqual([]);
    }
    expect(
      parseSourceSegments(raw, policy()).segments.filter((segment) => segment.kind === 'annotation')
    ).toHaveLength(1);
  });

  test('literal regex punctuation and inline boundaries retain surrounding prose', () => {
    const custom: SourceSegmentPolicy = {
      version: 1,
      rules: [
        {
          id: 'literal',
          kind: 'aside',
          open: '.*+?[{',
          close: '}]?+*.',
          match: 'inline',
          label: 'Literal',
          exclude: true,
        },
      ],
    };
    const raw = source('A .*+?[{private 😀}]?+*. B');
    const parsed = parseSourceSegments(raw, custom);
    expect(parsed.segments.map((segment) => segment.kind)).toEqual(['main', 'aside', 'main']);
    expect(filterSourceSegments(raw, custom).text).toBe('A  B');
    const body = parsed.segments[1].bodyRange;
    expect(raw.text.slice(body.start, body.end)).toBe('private 😀');
  });

  test('fenced examples remain ordinary source and longer matching fences close the example', () => {
    const raw = source(
      '````text\r\n[[aside: Code sample\r\nnever parsed\r\n[[/aside]]\r\n```\r\n<audit>still fenced</audit>\r\n`````\r\n~~~/text\r\n<audit>also fenced</audit>\r\n~~~\r\n<audit>actual annotation</audit>'
    );
    const parsed = parseSourceSegments(raw, policy());
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.segments.filter((segment) => segment.kind !== 'main')).toHaveLength(1);
    const view = filterSourceSegments(raw, excludePolicy());
    expect(view.text).toContain('never parsed');
    expect(view.text).toContain('still fenced');
    expect(view.text).toContain('also fenced');
    expect(view.text).not.toContain('actual annotation');
  });

  test.each([
    ['unclosed', 'A\n[[aside: Secret\nprivate text', 'SEGMENT_UNCLOSED'],
    ['orphan', 'A\n[[/aside]]\nB', 'SEGMENT_ORPHAN_CLOSE'],
    ['nested', 'A\n[[aside: Outer\n<audit>inner</audit>\n[[/aside]]\nB', 'SEGMENT_NESTED'],
    ['mismatched', 'A\n[[aside: Wrong close\nprivate</audit>\nB', 'SEGMENT_MISMATCHED_CLOSE'],
    ['missing title', 'A\n[[aside: \nprivate\n[[/aside]]\nB', 'SEGMENT_TITLE'],
  ])('%s blocks stay readable but an exclusion cannot silently leak them', (_label, text, code) => {
    const raw = source(text),
      parsed = parseSourceSegments(raw, policy());
    expect(parsed.diagnostics.map((item) => item.code)).toContain(code);
    expect(
      parsed.segments
        .map((segment) => raw.text.slice(segment.range.start, segment.range.end))
        .join('')
    ).toBe(text);
    expect(filterSourceSegments(raw, excludePolicy())).toMatchObject({
      ok: false,
      text: '',
      keptRanges: [],
      excluded: [],
    });
  });

  test('excluded ranges identify the original source and never replace its hash with a view hash', () => {
    const raw = sample(),
      before = structuredClone(raw),
      view = filterSourceSegments(raw, excludePolicy());
    expect(view.ok).toBe(true);
    expect(view.sourceRevision).toBe(raw.sourceRevision);
    expect(view.sourceHash).toBe(raw.sourceHash);
    expect(view.excluded.map((segment) => segment.kind)).toEqual(['aside', 'annotation']);
    expect(view.excluded.every((segment) => segment.sourceHash === raw.sourceHash)).toBe(true);
    expect(view.keptRanges.map((range) => raw.text.slice(range.start, range.end)).join('')).toBe(
      view.text
    );
    expect(view.text).toContain('First main paragraph.');
    expect(view.text).not.toContain('Mira imagines');
    expect(view.text).not.toContain('Only a commentary');
    expect(source(view.text).sourceHash).not.toBe(raw.sourceHash);
    expect(raw).toEqual(before);
  });

  test('translation localizes prose, titles and scene labels while preserving markers and portrait identity', () => {
    const raw = sample(),
      translated = raw.text
        .replace('Quiet bell', '조용한 종')
        .replace('Tower :: Morning :: Mira', '탑 :: 아침 :: 미라')
        .replace('Mira imagines a silent bell. 😀', '미라는 조용한 종을 상상해요. 😀');
    expect(validateSegmentTranslation(raw, translated, policy())).toEqual({
      ok: true,
      diagnostics: [],
    });
    const markers = segmentTranslationMarkers(raw, policy());
    expect(
      markers.filter((marker) => marker.kind === 'scene').map((marker) => marker.literal)
    ).toEqual(['⟬', '::', '::', '⟭']);
    expect(markers.some((marker) => marker.literal.includes('Tower'))).toBe(false);
    expect(markers.find((marker) => marker.kind === 'portrait')!.literal).toContain(
      'resource:coat@1'
    );
    expect(
      validateSegmentTranslation(
        raw,
        translated.replace('resource:coat@1', 'resource:forged@2'),
        policy()
      ).ok
    ).toBe(false);
    expect(
      validateSegmentTranslation(raw, translated.replace('탑 :: 아침', '탑 / 아침'), policy()).ok
    ).toBe(false);
    expect(
      validateSegmentTranslation(raw, translated.replace('[[/aside]]', '[[/other]]'), policy()).ok
    ).toBe(false);
    const aside = parseSourceSegments(raw, policy()).segments[1];
    const without = raw.text.slice(0, aside.range.start) + raw.text.slice(aside.range.end);
    expect(
      validateSegmentTranslation(raw, without, policy()).diagnostics.map((item) => item.code)
    ).toContain('SEGMENT_TRANSLATION_COVERAGE');
    expect(
      validateSegmentTranslation(
        raw,
        without + raw.text.slice(aside.range.start, aside.range.end),
        policy()
      ).ok
    ).toBe(false);
    expect(
      validateSegmentTranslation(
        raw,
        raw.text.replace('Mira imagines a silent bell. 😀', ''),
        policy()
      ).diagnostics.map((item) => item.code)
    ).toContain('SEGMENT_EMPTY');
  });

  test('retention uses explicit logical-message indices and the configured boundary', () => {
    const p = policy();
    p.rules[1].keepLastMessages = 2;
    const raw = sample();
    for (const context of [
      {},
      { messageIndex: -1, lastMessageIndex: 6 },
      { messageIndex: 7, lastMessageIndex: 6 },
      { messageIndex: 4.5, lastMessageIndex: 6 },
    ]) {
      expect(filterSourceSegments(raw, p, context)).toMatchObject({
        ok: false,
        text: '',
        keptRanges: [],
      });
    }
    expect(filterSourceSegments(raw, p, { messageIndex: 4, lastMessageIndex: 6 }).text).toContain(
      'Only a commentary'
    );
    expect(
      filterSourceSegments(raw, p, { messageIndex: 3, lastMessageIndex: 6 }).text
    ).not.toContain('Only a commentary');
    p.rules[1].keepLastMessages = 0;
    expect(filterSourceSegments(raw, p, { messageIndex: 6, lastMessageIndex: 6 }).text).toContain(
      'Only a commentary'
    );
    expect(
      filterSourceSegments(raw, p, { messageIndex: 5, lastMessageIndex: 6 }).text
    ).not.toContain('Only a commentary');
  });

  test('policy validation rejects ambiguous markers, unsafe fields and unbounded inputs without running getters', () => {
    const repeated = policy();
    repeated.rules[1].open = repeated.rules[0].close;
    expect(() => validateSourceSegmentPolicy(repeated)).toThrow('SEGMENT_DELIMITER_CONFLICT');
    for (const change of [
      { open: '' },
      { close: 'a\nb' },
      { keepLastMessages: -1 },
      { keepLastMessages: 10001 },
      { match: 'inline', title: true },
      { expanded: 'yes' },
    ]) {
      const invalid = policy();
      Object.assign(invalid.rules[0], change);
      expect(() => validateSourceSegmentPolicy(invalid)).toThrow();
    }
    const accessor = Object.defineProperty({}, 'rules', {
      get: () => {
        throw Error('GETTER_EXECUTED');
      },
    });
    expect(() => validateSourceSegmentPolicy(accessor)).toThrow('SEGMENT_FIELDS');
    expect(() =>
      validateSourceSegmentPolicy(JSON.parse('{"version":1,"rules":[],"__proto__":{}}'))
    ).toThrow('SEGMENT_FIELDS');
    expect(() => parseSourceSegments({ ...sample(), sourceHash: 'wrong' }, policy())).toThrow(
      'SEGMENT_SOURCE'
    );
    expect(() => parseSourceSegments(source('<audit>x</audit>'.repeat(1001)), policy())).toThrow(
      'SEGMENT_LIMIT'
    );
  });
});

describe('source segment controls and selected package revisions', () => {
  const controls: PromptControl[] = ['enabled', 'exclude', 'expanded'].map((id) => ({
    id,
    label: id,
    type: 'boolean',
    default: false,
  }));
  const conditional = (): SourceSegmentPolicy => ({
    version: 1,
    rules: [
      {
        ...policy().rules[0],
        when: { control: 'enabled' },
        excludeWhen: { control: 'exclude' },
        expandedWhen: { control: 'expanded' },
      },
    ],
  });
  const pkg = (id = 'module', revision = 1): ContentPackage => ({
    version: 1,
    id,
    revision,
    title: id,
    description: '',
    lore: [],
    instructions: [],
    transforms: [],
    controls,
    sourceSegments: conditional(),
  });
  const profile = (): ProfileSnapshot => ({
    ...defaultProfile('chat'),
    contents: [],
    models: {},
    packages: [pkg()],
    packageAttachments: [{ id: 'module', revision: 1, role: 'module' }],
    packageValues: { 'module@1:module': { enabled: true, exclude: true, expanded: true } },
  });

  test('conditions resolve only selected controls to frozen booleans and cannot modify package data', () => {
    const authored = conditional(),
      before = structuredClone(authored);
    expect(resolveSourceSegmentPolicy(authored, controls).rules).toEqual([]);
    const resolved = resolveSourceSegmentPolicy(authored, controls, {
      enabled: true,
      exclude: true,
      expanded: true,
    });
    expect(resolved.rules[0]).toMatchObject({ exclude: true, expanded: true });
    expect(resolved.rules[0]).not.toHaveProperty('when');
    expect(resolved.rules[0]).not.toHaveProperty('excludeWhen');
    expect(resolved.rules[0]).not.toHaveProperty('expandedWhen');
    expect(authored).toEqual(before);
    expect(filterSourceSegments(sample(), resolved).text).not.toContain('Mira imagines');
    expect(() =>
      resolveSourceSegmentPolicy({ version: 1, rules: [{ ...policy().rules[0], when: 1 }] }, [])
    ).toThrow('SEGMENT_CONDITION_BOOLEAN');
    expect(() => validateSourceSegmentPolicy(authored)).toThrow();
  });

  test('package freezing uses exact revision and attachment option key, with persona opt-out', () => {
    const selected = profile(),
      before = structuredClone(selected);
    const frozen = freezeSourceSegments(selected)!;
    expect(frozen.rules[0]).toMatchObject({
      id: 'module@1:module:perspective',
      exclude: true,
      expanded: true,
    });
    selected.packageValues!['module@1:module'].exclude = false;
    expect(frozen.rules[0].exclude).toBe(true);
    expect(
      freezeSourceSegments({
        ...before,
        packageAttachments: [{ id: 'module', revision: 2, role: 'module' }],
      })
    ).toBeUndefined();
    expect(
      freezeSourceSegments({
        ...before,
        personaReference: false,
        packageAttachments: [{ id: 'module', revision: 1, role: 'persona' }],
        packageValues: { 'module@1:persona': { enabled: true } },
      })
    ).toBeUndefined();
    expect(freezeSourceSegments(undefined)).toBeUndefined();
  });

  test('equivalent shared declarations execute once while conflicting package declarations are rejected', () => {
    const selected = profile();
    const other = pkg('other');
    const rule = other.sourceSegments!.rules[0];
    other.sourceSegments!.rules[0] = {
      ...Object.fromEntries(Object.entries(rule).reverse()),
      scene: { separator: rule.scene!.separator, close: rule.scene!.close, open: rule.scene!.open },
    } as typeof rule;
    selected.packages!.push(other);
    selected.packageAttachments!.push({ id: 'other', revision: 1, role: 'module' });
    selected.packageValues!['other@1:module'] = { enabled: true, exclude: true, expanded: true };
    expect(freezeSourceSegments(selected)!.rules).toHaveLength(1);
    selected.packageValues!['other@1:module'].exclude = false;
    expect(() => freezeSourceSegments(selected)).toThrow('SEGMENT_DELIMITER_CONFLICT');
  });
});
