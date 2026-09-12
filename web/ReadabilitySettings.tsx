import { Switch } from './BooleanControls.js';
import { Prose } from './Prose.js';
import {
  DEFAULT_READABILITY,
  QUOTE_PAIRS,
  type ReadabilitySettings as ReadingStyle,
  type QuoteRole,
} from './reading-preferences.js';
import './reading.css';

const previewText =
  '그녀는 문 앞에서 돌아섰다. “정말 같이 갈 거야?” 나는 고개를 끄덕였다. ‘이번에는 도망치지 않겠어.’\n\n「그럼 출발하자.」 그녀는 『별의 기록』을 가방에 넣었다.';
const preset = (name: string): ReadingStyle => ({
  ...DEFAULT_READABILITY,
  ...(name === 'dialogue' ? { emphasis: 'subtle', dialogueBreaks: true } : {}),
  ...(name === 'relaxed' ? { lineHeight: 2.2, paragraphSpacing: 1.5 } : {}),
});
function currentPreset(value: ReadingStyle) {
  return (
    ['default', 'relaxed', 'dialogue'].find((name) => {
      const expected = preset(name);
      return (
        value.emphasis === expected.emphasis &&
        value.dialogueBreaks === expected.dialogueBreaks &&
        value.thoughtBreaks === expected.thoughtBreaks &&
        value.lineHeight === expected.lineHeight &&
        value.paragraphSpacing === expected.paragraphSpacing
      );
    }) ?? 'custom'
  );
}

export function ReadabilitySettings({
  value,
  onChange,
}: {
  value: ReadingStyle;
  onChange: (value: ReadingStyle) => void;
}) {
  return (
    <section className="reading-settings" aria-label="읽기 스타일 설정">
      <label>
        읽기 스타일
        <select
          aria-label="읽기 스타일"
          value={currentPreset(value)}
          onChange={(event) =>
            onChange({ ...preset(event.target.value), quoteRoles: value.quoteRoles })
          }
        >
          <option value="default">기본</option>
          <option value="relaxed">여유롭게</option>
          <option value="dialogue">대사 중심</option>
          <option value="custom" disabled>
            사용자 설정
          </option>
        </select>
      </label>
      <div className="reading-preview" aria-label="읽기 스타일 미리보기">
        <small>미리보기</small>
        <div className="prose" data-testid="reading-preview">
          <Prose text={previewText} reading={value} />
        </div>
      </div>
      <label>
        인용 강조
        <select
          aria-label="인용 강조"
          value={value.emphasis}
          onChange={(event) =>
            onChange({ ...value, emphasis: event.target.value as ReadingStyle['emphasis'] })
          }
        >
          <option value="off">끄기</option>
          <option value="subtle">은은하게</option>
          <option value="strong">뚜렷하게</option>
        </select>
      </label>
      <div className="reading-toggles">
        <label className="check">
          <Switch
            checked={value.dialogueBreaks}
            onChange={(event) => onChange({ ...value, dialogueBreaks: event.target.checked })}
          />
          대사 줄바꿈
        </label>
        <label className="check">
          <Switch
            checked={value.thoughtBreaks}
            onChange={(event) => onChange({ ...value, thoughtBreaks: event.target.checked })}
          />
          생각 줄바꿈
        </label>
      </div>
      <div className="reading-spacing">
        <label>
          줄 간격
          <select
            aria-label="줄 간격"
            value={value.lineHeight ?? 'default'}
            onChange={(event) =>
              onChange({
                ...value,
                lineHeight: event.target.value === 'default' ? null : Number(event.target.value),
              })
            }
          >
            <option value="default">기본</option>
            <option value="1.6">촘촘하게</option>
            <option value="1.9">보통</option>
            <option value="2.2">여유롭게</option>
          </select>
        </label>
        <label>
          문단 간격
          <select
            aria-label="문단 간격"
            value={value.paragraphSpacing ?? 'default'}
            onChange={(event) =>
              onChange({
                ...value,
                paragraphSpacing:
                  event.target.value === 'default' ? null : Number(event.target.value),
              })
            }
          >
            <option value="default">기본</option>
            <option value="0.5">좁게</option>
            <option value="1">보통</option>
            <option value="1.5">여유롭게</option>
            <option value="2">넓게</option>
          </select>
        </label>
      </div>
      <details className="reading-quote-settings">
        <summary>표기별 스타일</summary>
        <p>부호에 따라 표시해요. 대사나 생각의 실제 의미를 판단하지 않아요.</p>
        <div className="reading-quote-rules">
          {QUOTE_PAIRS.map(({ id, label }) => (
            <label key={id}>
              {label}
              <select
                aria-label={`${label} 스타일`}
                value={value.quoteRoles[id]}
                onChange={(event) =>
                  onChange({
                    ...value,
                    quoteRoles: { ...value.quoteRoles, [id]: event.target.value as QuoteRole },
                  })
                }
              >
                <option value="dialogue">대사</option>
                <option value="thought">생각</option>
                <option value="quote">일반 인용</option>
                <option value="off">처리 안 함</option>
              </select>
            </label>
          ))}
        </div>
      </details>
      <div className="reading-settings-footer">
        <small>이 브라우저의 본문과 도우미 내용에 적용해요.</small>
        <button type="button" className="secondary" onClick={() => onChange(DEFAULT_READABILITY)}>
          읽기 스타일 초기화
        </button>
      </div>
    </section>
  );
}
