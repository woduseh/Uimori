import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { defaultHiddenStoryConfig, hiddenReaderSettings, hiddenConfigIssues, parseHiddenStory, HIDDEN_COLORS, type HiddenSource, type HiddenSegment, type HiddenStoryConfig, type HiddenReaderSettings } from '../core/hidden-story.js';
import { Prose } from './Prose.js';
import './hidden-story.css';

export type HiddenTranslatedSegment = { body: string; title?: string; scene?: { place: string; time: string; subjectLabel?: string } };
export type HiddenTranslationView = { sourceRevision: string; sourceHash: string; segments: Record<string, HiddenTranslatedSegment> };
export type HiddenStoryReaderProps = {
  source: HiddenSource; config?: HiddenStoryConfig; translation?: HiddenTranslationView;
  renderText?: (text: string, segment: HiddenSegment) => ReactNode;
  /** The host resolves a pinned, authorized image ref. Raw hsPortrait strings are never HTML. */
  renderPortrait?: (segment: HiddenSegment) => ReactNode;
  onToggle?: (event: { segmentId: string; expanded: boolean }) => void;
};

function SceneInfo({ scene, part = 'all' }: { scene: NonNullable<HiddenTranslatedSegment['scene']>; part?: 'all' | 'place-time' | 'subject' }) {
  return <dl className="native-hidden-scene" aria-label="이 장면의 장소와 시점">
    {part !== 'subject' && <><div><dt>장소</dt><dd>{scene.place}</dd></div><div><dt>때</dt><dd>{scene.time}</dd></div></>}
    {part !== 'place-time' && scene.subjectLabel && <div><dt>시점</dt><dd>{scene.subjectLabel}</dd></div>}
  </dl>;
}

/** Expansion is local reader state. It never changes source text or character knowledge. */
export function HiddenStorySegmentView({ source, segment, settings, translation, renderText, renderPortrait, onToggle }: Omit<HiddenStoryReaderProps, 'config' | 'translation'> & { segment: HiddenSegment; settings: HiddenReaderSettings; translation?: HiddenTranslatedSegment }) {
  const [expanded, setExpanded] = useState(settings.defaultExpanded);
  useEffect(() => { setExpanded(settings.defaultExpanded); }, [settings.defaultExpanded, segment.id]);
  const original = source.text.slice(segment.bodyRange.start, segment.bodyRange.end), body = translation?.body ?? original;
  const text = renderText ? renderText(body, segment) : <Prose text={body}/>;
  if (segment.kind === 'main') return <div className="native-main-segment" data-segment-id={segment.id}>{text}</div>;
  if (segment.kind === 'evaluation') return <details className="native-hidden-evaluation" data-segment-id={segment.id}><summary>{settings.showEvaluation ? '인풋 평가와 발전 기록' : '보관된 인풋 평가 기록'}</summary><p className="native-hidden-note">서술 본문과 구분된 평가 기록이에요.</p>{text}</details>;
  const scene = translation?.scene ?? segment.scene;
  const portrait = settings.showPortrait && segment.portrait ? renderPortrait?.(segment) : null;
  const sceneVisible = settings.scene !== 'none' && !!scene;
  const background = [[11, 11, 10, .4], [250, 250, 250, .2], [69, 69, 69, .5], [3, 3, 3, .5]][settings.background];
  const style = { '--hidden-accent': HIDDEN_COLORS[settings.color], '--hidden-background': `rgba(${background[0]},${background[1]},${background[2]},${settings.opacity ?? background[3]})` } as CSSProperties;
  return <details className="native-hidden-story" data-segment-id={segment.id} data-styled={settings.styled} data-border={settings.border} data-decoration={settings.decoration} data-round={settings.round} data-align={settings.align} style={style} open={expanded} onToggle={event => { const next = event.currentTarget.open; setExpanded(next); onToggle?.({ segmentId: segment.id, expanded: next }); }}>
    <summary>{translation?.title ?? segment.title ?? '다른 시점의 이야기'}</summary>
    <div className="native-hidden-body">
      <p className="native-hidden-note">다른 시점의 이야기 · 펼쳐 읽어도 등장인물에게 정보가 전달되지는 않아요.</p>
      {sceneVisible && (settings.scene !== 'bottom' || !portrait) && <SceneInfo scene={scene} part={settings.scene === 'split' && portrait ? 'place-time' : 'all'}/>}
      {portrait && <div className="native-hidden-portrait">{portrait}</div>}
      {settings.showPortrait && segment.portrait?.raw && !portrait && <small className="native-hidden-note">이 장면에 연결된 이미지를 표시할 수 없어요.</small>}
      {sceneVisible && portrait && settings.scene === 'bottom' && <SceneInfo scene={scene}/>}
      {sceneVisible && portrait && settings.scene === 'split' && scene.subjectLabel && <SceneInfo scene={scene} part="subject"/>}
      <div className="native-hidden-prose">{text}</div>
    </div>
  </details>;
}

export function HiddenStoryReader({ source, config = defaultHiddenStoryConfig(), translation, ...props }: HiddenStoryReaderProps) {
  const read = useMemo(() => { try { return { document: parseHiddenStory(source), error: '' }; } catch { return { document: null, error: '이 원문의 구간 정보를 확인할 수 없어 원문 그대로 표시해요.' }; } }, [source.sourceRevision, source.sourceHash, source.text]);
  let settings: HiddenReaderSettings, issues: string[];
  try { settings = hiddenReaderSettings(config); issues = hiddenConfigIssues(config); }
  catch { return <div className="native-hidden-reader"><p role="alert">히든 스토리 표시 설정을 확인해 주세요. 원문은 그대로 보존돼요.</p><Prose text={source.text}/></div>; }
  const translated = translation?.sourceRevision === source.sourceRevision && translation.sourceHash === source.sourceHash ? translation : undefined;
  if (!read.document) return <div className="native-hidden-reader"><p role="alert">{read.error}</p><Prose text={source.text}/></div>;
  return <div className="native-hidden-reader" data-hide-dividers={settings.hideDividers}>
    {read.document.diagnostics.length > 0 && <details className="native-hidden-diagnostics"><summary>원문 구간 확인 사항 {read.document.diagnostics.length}개</summary><p>구분하지 못한 표식은 원문 그대로 표시해요. 내용을 자동 수정하지 않아요.</p><ul>{read.document.diagnostics.map((issue, index) => <li key={index}>{issue.code}{issue.range && ` · ${issue.range.start}–${issue.range.end}`}</li>)}</ul></details>}
    {issues.includes('HIDDEN_INVASIVE_CSS_SCOPED') && <p className="native-hidden-note">원본의 침범 스타일은 이 이야기 상자 안에서만 적용해요.</p>}
    {translation && !translated && <p role="alert">다른 원문 버전의 번역이라 표시하지 않았어요.</p>}
    {read.document.segments.map(segment => <Fragment key={segment.id}><HiddenStorySegmentView source={source} segment={segment} settings={settings} translation={translated?.segments[segment.id]} {...props}/></Fragment>)}
  </div>;
}
