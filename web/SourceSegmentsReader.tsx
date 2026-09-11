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

type SourceSegmentsReaderProps = {
  source: SegmentSource;
  policy: SourceSegmentPolicy;
  renderText?: (text: string, segment: SourceSegment) => ReactNode;
  onToggle?: (event: { segmentId: string; expanded: boolean }) => void;
};
function Segment({
  source,
  segment,
  rule,
  renderText,
  onToggle,
}: Omit<SourceSegmentsReaderProps, 'policy'> & {
  segment: SourceSegment;
  rule?: SourceSegmentRule;
}) {
  const [expanded, setExpanded] = useState(rule?.expanded ?? false);
  useEffect(() => setExpanded(rule?.expanded ?? false), [rule?.expanded]);
  const body = source.text.slice(segment.bodyRange.start, segment.bodyRange.end),
    text = renderText ? renderText(body, segment) : <Prose text={body} />;
  if (segment.kind === 'main')
    return (
      <div className="source-main-segment" data-segment-id={segment.id}>
        {text}
      </div>
    );
  const scene = segment.scene;
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
      <summary>{segment.title ?? rule?.label ?? '별도 구간'}</summary>
      <div className="source-segment-body">
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
        {text}
      </div>
    </details>
  );
}
/** Expansion is reader state. The stored source, its identity and the request scope never change here. */
export function SourceSegmentsReader({ source, policy, ...props }: SourceSegmentsReaderProps) {
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
      {read.segments.map((segment) => (
        <Segment
          key={segment.id}
          source={source}
          segment={segment}
          rule={policy.rules.find((rule) => rule.id === segment.ruleId)}
          {...props}
        />
      ))}
    </div>
  );
}
