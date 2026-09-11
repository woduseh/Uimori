import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  parseSourceSegments,
  type SegmentSource,
  type SourceSegment,
  type SourceSegmentPolicy,
  type SourceSegmentRule,
} from '../core/source-segments.js';
import { Prose } from './Prose.js';
import './source-segments.css';

type TranslatedSourceSegment = {
  body: string;
  title?: string;
  scene?: { place: string; time: string; subjectLabel?: string };
};
type SegmentTranslationView = {
  sourceRevision: string;
  sourceHash: string;
  segments: Record<string, TranslatedSourceSegment>;
};
type SourceSegmentsReaderProps = {
  source: SegmentSource;
  policy: SourceSegmentPolicy;
  translation?: SegmentTranslationView;
  renderText?: (text: string, segment: SourceSegment) => ReactNode;
  renderPortrait?: (segment: SourceSegment) => ReactNode;
  onToggle?: (event: { segmentId: string; expanded: boolean }) => void;
};
function Segment({
  source,
  segment,
  rule,
  translation,
  renderText,
  renderPortrait,
  onToggle,
}: Omit<SourceSegmentsReaderProps, 'policy' | 'translation'> & {
  segment: SourceSegment;
  rule?: SourceSegmentRule;
  translation?: TranslatedSourceSegment;
}) {
  const [expanded, setExpanded] = useState(rule?.expanded ?? false);
  useEffect(() => setExpanded(rule?.expanded ?? false), [rule?.expanded]);
  const body =
      translation?.body ?? source.text.slice(segment.bodyRange.start, segment.bodyRange.end),
    text = renderText ? renderText(body, segment) : <Prose text={body} />;
  if (segment.kind === 'main')
    return (
      <div className="source-main-segment" data-segment-id={segment.id}>
        {text}
      </div>
    );
  const scene = translation?.scene ?? segment.scene,
    portrait = segment.portrait ? renderPortrait?.(segment) : null;
  return (
    <details
      className="source-aside-segment"
      data-segment-id={segment.id}
      data-kind={segment.kind}
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setExpanded(next);
        onToggle?.({ segmentId: segment.id, expanded: next });
      }}
    >
      <summary>{translation?.title ?? segment.title ?? rule?.label ?? '별도 구간'}</summary>
      <div className="source-segment-body">
        <p className="muted">펼쳐 읽어도 등장인물에게 정보가 전달되지는 않아요.</p>
        {scene && (
          <dl className="source-segment-scene">
            <div>
              <dt>장소</dt>
              <dd>{scene.place}</dd>
            </div>
            <div>
              <dt>때</dt>
              <dd>{scene.time}</dd>
            </div>
            {scene.subjectLabel && (
              <div>
                <dt>시점</dt>
                <dd>{scene.subjectLabel}</dd>
              </div>
            )}
          </dl>
        )}
        {portrait}
        {segment.portrait && !portrait && <small>연결된 이미지를 표시할 수 없어요.</small>}
        {text}
      </div>
    </details>
  );
}
/** Expansion is reader state. Source identity, translation identity and knowledge never change here. */
export function SourceSegmentsReader({
  source,
  policy,
  translation,
  ...props
}: SourceSegmentsReaderProps) {
  const read = useMemo(() => {
    try {
      return parseSourceSegments(
        { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, text: source.text },
        policy
      );
    } catch {
      return null;
    }
  }, [source.sourceRevision, source.sourceHash, source.text, policy]);
  const translated =
    translation?.sourceRevision === source.sourceRevision &&
    translation.sourceHash === source.sourceHash
      ? translation
      : undefined;
  if (!read)
    return (
      <div>
        <p role="alert">구간 정보를 확인할 수 없어 원문 그대로 표시해요.</p>
        <Prose text={source.text} />
      </div>
    );
  return (
    <div className="source-segments-reader">
      {read.diagnostics.length > 0 && (
        <details>
          <summary>원문 구간 확인 사항 {read.diagnostics.length}개</summary>
          <p>구분하지 못한 표식은 원문 그대로 표시해요.</p>
          <ul>
            {read.diagnostics.map((issue, index) => (
              <li key={index}>{issue.code}</li>
            ))}
          </ul>
        </details>
      )}
      {translation && !translated && (
        <p role="alert">다른 원문 버전의 번역이라 표시하지 않았어요.</p>
      )}
      {read.segments.map((segment) => (
        <Segment
          key={segment.id}
          source={source}
          segment={segment}
          rule={policy.rules.find((rule) => rule.id === segment.ruleId)}
          translation={translated?.segments[segment.id]}
          {...props}
        />
      ))}
    </div>
  );
}
