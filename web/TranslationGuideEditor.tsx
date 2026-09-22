import { Plus, Trash2, Languages } from 'lucide-react';
import { TRANSLATION_GUIDE_LIMITS, type TranslationGuide } from '../core/translation-guide.js';
import './translation-guide.css';

export function TranslationGuideEditor({
  value,
  onChange,
}: {
  value: TranslationGuide;
  onChange: (value: TranslationGuide) => void;
}) {
  const term = (index: number, change: Partial<TranslationGuide['terms'][number]>) =>
    onChange({
      ...value,
      terms: value.terms.map((item, i) => (i === index ? { ...item, ...change } : item)),
    });
  return (
    <section className="translation-guide-editor" aria-label="봇 번역 지침 편집기">
      <div className="translation-guide-intro">
        <Languages size={22} aria-hidden="true" />
        <div>
          <h3>이 봇의 번역 지침</h3>
          <p>
            번역 프리셋의 공통 원칙에 이 작품의 표기와 말투를 더해요. 같은 봇의 모든 채팅에서 다음
            번역·재번역부터 사용하며, 저장된 번역과 진행 중인 작업은 바꾸지 않아요.
          </p>
        </div>
      </div>
      <label>
        말투·호칭·문체 지침
        <textarea
          aria-label="봇 번역 지침"
          rows={6}
          placeholder="예: 미라는 평소 담담하게 말하고 로언에게는 존댓말을 사용해요. 원문에서 의도적으로 말투가 바뀌면 그 변화를 보존해 주세요."
          value={value.instructions}
          maxLength={TRANSLATION_GUIDE_LIMITS.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
        />
      </label>
      <div className="translation-guide-terms-heading">
        <div>
          <h3>이름·용어 표기</h3>
          <p className="muted">
            조건과 문맥을 함께 전달해요. 번역문을 기계적으로 치환하는 규칙은 아니에요.
          </p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={value.terms.length >= TRANSLATION_GUIDE_LIMITS.terms}
          onClick={() =>
            onChange({ ...value, terms: [...value.terms, { source: '', target: '' }] })
          }
        >
          <Plus size={16} aria-hidden="true" /> 표기 추가
        </button>
      </div>
      {!value.terms.length && (
        <p className="translation-guide-empty">
          아직 지정한 표기가 없어요. 인명이나 조직 이름처럼 일관되게 번역할 표현을 추가해 보세요.
        </p>
      )}
      <div className="translation-guide-terms">
        {value.terms.map((item, index) => (
          <fieldset className="translation-guide-term" key={index}>
            <legend>표기 {index + 1}</legend>
            <label>
              원문 표기
              <input
                aria-label={`표기 ${index + 1} 원문`}
                value={item.source}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder="Mira"
                onChange={(e) => term(index, { source: e.target.value })}
              />
            </label>
            <label>
              사용할 표기
              <input
                aria-label={`표기 ${index + 1} 번역`}
                value={item.target}
                maxLength={TRANSLATION_GUIDE_LIMITS.term}
                placeholder="미라"
                onChange={(e) => term(index, { target: e.target.value })}
              />
            </label>
            <label className="translation-guide-term-note">
              <span>
                조건·설명 <span className="muted">선택</span>
              </span>
              <input
                aria-label={`표기 ${index + 1} 조건·설명`}
                value={item.note ?? ''}
                maxLength={TRANSLATION_GUIDE_LIMITS.note}
                placeholder="인물 이름일 때만 적용"
                onChange={(e) => term(index, { note: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="ghost translation-guide-term-delete"
              aria-label={`표기 ${index + 1} 삭제`}
              onClick={() =>
                onChange({ ...value, terms: value.terms.filter((_, i) => i !== index) })
              }
            >
              <Trash2 size={16} aria-hidden="true" /> 삭제
            </button>
          </fieldset>
        ))}
      </div>
      <details className="translation-guide-preview">
        <summary>번역에 전달할 지침 미리보기</summary>
        <p className="muted">
          현재 편집 내용이에요. ‘변경사항 저장’ 후 다음 번역 요청에 전달하며, 미리보기는 모델을
          호출하지 않아요. 기존 봇·페르소나·로어는 별도 참고 자료로 계속 사용해요.
        </p>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
      <p className="muted translation-guide-help">
        도우미에게 ‘이 봇의 설명과 로어를 참고해 번역 지침 초안을 만들어줘’라고 요청할 수 있어요.
        지침은 요청했을 때만 작성·저장하며, 새 용어를 자동으로 누적하지 않아요.
      </p>
    </section>
  );
}
