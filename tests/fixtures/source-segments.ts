import type { SourceSegmentPolicy } from '../../core/source-segments.js';

/** Legacy-looking text is ordinary fixture data; the host interprets only this selected policy. */
export function createSourceSegmentFixture(
  options: {
    excludeAsides?: boolean;
    excludeAnnotations?: boolean;
    expanded?: boolean;
    keepLastMessages?: number;
  } = {}
): SourceSegmentPolicy {
  return {
    version: 1,
    rules: [
      {
        id: 'aside',
        kind: 'aside',
        open: '@hsTitle:',
        close: '@hs',
        match: 'line',
        title: true,
        label: '다른 시점',
        expanded: options.expanded ?? false,
        exclude: options.excludeAsides ?? false,
        scene: { open: '⟦', close: '⟧', separator: '@' },
      },
      {
        id: 'annotation',
        kind: 'annotation',
        open: '<EvaluationReport>',
        close: '</EvaluationReport>',
        match: 'inline',
        label: '평가 기록',
        exclude: options.excludeAnnotations ?? true,
        ...(options.keepLastMessages === undefined
          ? {}
          : { keepLastMessages: options.keepLastMessages }),
      },
    ],
  };
}

/** A neutral annotation package: no actor, scene header or title line is involved. */
export function createNeutralAnnotationFixture(
  options: { exclude?: boolean; keepLastMessages?: number } = {}
): SourceSegmentPolicy {
  return {
    version: 1,
    rules: [
      {
        id: 'note',
        kind: 'annotation',
        open: '[note]',
        close: '[/note]',
        match: 'inline',
        label: '편집 메모',
        exclude: options.exclude ?? false,
        ...(options.keepLastMessages === undefined
          ? {}
          : { keepLastMessages: options.keepLastMessages }),
      },
    ],
  };
}
