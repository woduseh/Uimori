import { auxiliaryErrorDiagnostic } from './auxiliary-error.js';

export function mainJudgmentError(error: string | null | undefined): string | undefined {
  if (error?.startsWith('JEV_')) {
    const diagnostic = auxiliaryErrorDiagnostic(error);
    return diagnostic.code
      ? `${diagnostic.message} ${diagnostic.action}`
      : 'JEV 판단을 완료하지 못했어요. 연결 설정과 보존된 출력을 확인해 주세요.';
  }
  if (error === 'MAIN_RESPONSE_REFUSED')
    return '모델이 요청 수행을 거절했다고 판단했어요. 출력은 보존했으며 확정 원문으로 채택하거나 자동 재생성하지 않았어요.';
  if (error === 'MAIN_JUDGMENT_CALL_BUDGET')
    return '본문 생성과 JEV 거절 판정에 필요한 호출 한도가 부족해요. 호출 한도를 2회 이상으로 설정해 주세요.';
  return undefined;
}
