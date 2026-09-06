import type { CreativeControls } from '../core/product.js';

export function CreativeEditor({ value, onChange, prefix = 'creative' }: { value: CreativeControls; onChange: (value: CreativeControls) => void; prefix?: string }) {
  const update = <K extends keyof CreativeControls>(key: K, next: CreativeControls[K]) => onChange({ ...value, [key]: next });
  return <fieldset className="control-grid"><legend>기본 Phēmē 제어</legend>
    <label>작성 형식<select aria-label={`${prefix} 작성 형식`} value={value.mode} onChange={event => update('mode', event.target.value as CreativeControls['mode'])}><option value="novel">소설</option><option value="rp">RP</option></select></label>
    <label>원문 언어<select aria-label={`${prefix} 원문 언어`} value={value.language} onChange={event => update('language', event.target.value as CreativeControls['language'])}><option value="en">영어</option><option value="ko">한국어</option></select></label>
    <label>서술 시점<select aria-label={`${prefix} 서술 시점`} value={value.pov} onChange={event => update('pov', event.target.value as CreativeControls['pov'])}><option value="auto">자동</option><option value="first">1인칭</option><option value="third">3인칭</option></select></label>
    <label>문체<select aria-label={`${prefix} 문체`} value={value.style} onChange={event => update('style', event.target.value as CreativeControls['style'])}><option value="auto">자동</option><option value="calm">차분하게</option><option value="vivid">선명하게</option></select></label>
    {(['personaReference', 'worldFocus', 'coNarration', 'declarationFinal'] as const).map((key, index) => <label className="check" key={key}><input aria-label={`${prefix} ${['페르소나 참조', '세계·상황 중심', '공동 서술', '선언 결과 확정'][index]}`} type="checkbox" checked={value[key]} onChange={event => update(key, event.target.checked)}/>{['페르소나 참조', '세계·상황 중심', '공동 서술', '선언 결과 확정'][index]}</label>)}
    <label>분량 설정<select aria-label={`${prefix} 분량 설정`} value={value.lengthMode} onChange={event => update('lengthMode', event.target.value as CreativeControls['lengthMode'])}><option value="auto">자동</option><option value="range">단어 범위</option><option value="custom">직접 지정</option></select></label>
    <div className="range-fields"><label>최소 단어<input aria-label={`${prefix} 최소 단어`} type="number" min={1} max={50000} disabled={value.lengthMode !== 'range'} value={value.minWords} onChange={event => update('minWords', Number(event.target.value))}/></label><label>최대 단어<input aria-label={`${prefix} 최대 단어`} type="number" min={1} max={50000} disabled={value.lengthMode !== 'range'} value={value.maxWords} onChange={event => update('maxWords', Number(event.target.value))}/></label></div>
    <label>직접 지정 단어<input aria-label={`${prefix} 직접 지정 단어`} type="number" min={1} max={50000} disabled={value.lengthMode !== 'custom'} value={value.customWords} onChange={event => update('customWords', Number(event.target.value))}/></label>
    <small>선택한 분량 방식만 적용해요. 이 제어는 기본 native 구현이며 원본 CBS 실행 호환은 제공하지 않아요.</small>
  </fieldset>;
}
