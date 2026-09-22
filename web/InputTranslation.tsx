import { Languages, LoaderCircle, Square, Undo2 } from 'lucide-react';
import { INPUT_TRANSLATION_LANGUAGES } from '../core/input-translation.js';
import type { InputTranslationState } from './useInputTranslation.js';
import './input-translation.css';

type Props = { translation: InputTranslationState; disabled: boolean };
export function InputTranslationControls({
  translation,
  disabled,
  empty,
}: Props & { empty: boolean }) {
  return (
    <div className="input-translation-controls" role="group" aria-label="입력 번역 도구">
      <button
        type="button"
        className="input-translation-button"
        aria-label={translation.busy ? '입력 번역 취소' : '입력 번역'}
        title={translation.busy ? '입력 번역 취소' : '입력을 번역해요. 자동으로 전송하지 않아요.'}
        disabled={!translation.busy && (disabled || empty)}
        onClick={() => {
          if (translation.busy) translation.cancel();
          else void translation.translate();
        }}
      >
        {translation.busy ? (
          <Square size={15} aria-hidden="true" />
        ) : (
          <Languages size={17} aria-hidden="true" />
        )}
        <span>{translation.busy ? '취소' : '번역'}</span>
      </button>
      <select
        aria-label="입력 번역 언어"
        value={translation.language}
        disabled={disabled}
        onChange={(event) => translation.changeLanguage(event.target.value)}
      >
        {INPUT_TRANSLATION_LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function InputTranslationFeedback({ translation, disabled }: Props) {
  if (
    !translation.busy &&
    translation.original === null &&
    !translation.candidate &&
    !translation.error
  )
    return null;
  return (
    <section className="input-translation-feedback" aria-label="입력 번역 상태">
      {translation.busy && (
        <p role="status">
          <LoaderCircle size={14} aria-hidden="true" /> 입력을 번역하고 있어요. 계속 수정해도
          괜찮아요.
        </p>
      )}
      {translation.original !== null && (
        <div className="input-translation-original">
          <details>
            <summary>번역 전 원문 보기</summary>
            <pre>{translation.original}</pre>
          </details>
          <button
            type="button"
            className="link-button"
            disabled={disabled}
            onClick={translation.restore}
          >
            <Undo2 size={14} aria-hidden="true" /> 되돌리기
          </button>
        </div>
      )}
      {translation.candidate && (
        <details className="input-translation-candidate" open>
          <summary>이전 초안의 번역 · 현재 입력은 유지했어요</summary>
          <pre>{translation.candidate.text}</pre>
          <details>
            <summary>번역에 사용한 초안</summary>
            <pre>{translation.candidate.source}</pre>
          </details>
          <div className="input-translation-candidate-actions">
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              onClick={translation.applyCandidate}
            >
              이 번역으로 입력 바꾸기
            </button>
            <button type="button" className="link-button" onClick={translation.dismissCandidate}>
              닫기
            </button>
          </div>
        </details>
      )}
      {translation.error && (
        <p className="error" role="alert">
          {translation.error} 작성한 입력은 유지돼요.
        </p>
      )}
    </section>
  );
}
