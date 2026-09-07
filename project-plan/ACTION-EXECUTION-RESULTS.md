# 공통 행동 실행과 배포 전 계약 정리

기준일: 2026-09-07. 자동·사용자·모델 호출이 같은 함수 실행기를 사용하도록 구현했어요. 구버전 자료·채팅 보존을 위한 호환성은 정식 배포 전 요구사항에서 제외했어요.

## 구현

- `core/package-behavior.ts`: 행동별 `triggers`, 자동 입력, 명시적 결과. 조건·효과·결과의 공유 실행 예산, 결과 JSON 8,000자 한도.
- `core/package-behavior-tools.ts`: 장착 역할과 모델 권한으로 제한한 행동별 domain Tool, 입력 schema 변환, 20개 상한·확정된 도구 미지원 사전 검사.
- `server/package-behavior-run.ts`: 원문 생성 전 자동 실행, 생성 중 임시 행동 상태, DB에 고정한 판정 기회·추첨, 후보·취소 후 재요청의 재사용, 다른 패키지 상태 의존성 검사.
- `server/package-behavior-host.ts`: 여러 패키지의 행동·authoritative parser를 함께 게시하거나 되돌려요. annotation parser의 실패는 이미 검증된 행동 결과를 유지해요. 원문은 별도로 보존해요.
- `server/main-request.ts`, `server/model-runner.ts`, `server/app.ts`: 자동 결과와 최소 Tool schema를 전달하고, 허용된 모델 행동을 호스트가 처리해요. 메인 원문 생성만 행동을 요청할 수 있어요.
- `web/PackageFields.tsx`, `web/PackageBehaviorPanel.tsx`: 행동별 호출 방법 선택, 자동 입력 편집, 사용자 행동 폼과 상태를 바꾸지 않는 계산의 결과 표시.
- 서재·채팅 시작·설정: 봇·페르소나·모듈·프롬프트 중심으로 정리하고 이전 자료·이전 채팅·이전 창작 프리셋 경로를 제거했어요.
- schema/archive v8: 현재 형식만 허용해요. 복원은 추첨·순수 함수 결과·상태 순서·패키지 의존성·원문 귀속을 검증해요. 개발용 초기화는 `npm run reset:dev`로 명시 실행해요.

[사용 안내](../docs/PACKAGE-BEHAVIOR.md), [붙여 넣을 수 있는 혼합 호출 예제](../fixtures/hybrid-actions-behavior.json)

## 검증

최종 타입 검사와 빌드를 통과했어요. 전체 단위·통합 **932/932 PASS**, 브라우저 **55/55 PASS**이며 실패·skip은 없어요. 브라우저 실행의 소스·빌드 일치와 cleanup도 PASS예요.

| 근거 | 결과 |
| --- | --- |
| `npm run check`, `npm run build` | PASS. Vite의 529.02KB 청크 크기 경고는 남아 있어요. |
| [단위·통합 reporter](../output/action-execution-unit-tests-final.json) | 932 PASS / 0 FAIL / 0 skip |
| [브라우저 summary](../output/playwright/redesign-2026-09-07T09-38-45-396Z-b5f22e0c/summary.json) | 55 PASS / 0 FAIL / 0 skip, cleanup PASS |
| `git diff --check` | PASS |
| `npm run reset:dev` | 실제 기본 개발 DB와 WAL/SHM, 구형 자동 백업 6개 삭제. 0바이트 소유권 mutex 파일은 유지해요. |

source/build는 `495184aec55eba8fa6e0128c7e2a960cf08a32473f5e9476a1681c927a111531`, dist는 `3445133c68f9733696bd1174bfa964fb1c1f0b30c662a8165393d9d9a1382767`예요. 최종 빌드 이후 제품·테스트 코드는 변경하지 않았어요.

처음 전체 실행의 [단위 931 PASS / 1 FAIL](../output/action-execution-unit-tests.json), [브라우저 54 PASS / 1 FAIL](../output/playwright/redesign-2026-09-07T09-33-30-737Z-9d5728ea/summary.json)도 보존했어요. 단위 실패는 테스트의 독립 복사 자료가 새 entropy 행을 누락한 문제였고, 브라우저 실패는 boolean 선택 상자를 체크박스로 검사한 문제였어요. 해당 테스트를 수정한 뒤 전체 검사를 다시 실행했어요.

390px 화면에서 [호출 방법과 자동 입력](../output/playwright/redesign-2026-09-07T09-38-45-396Z-b5f22e0c/browser/package-behavior-browser-B-47721-thout-user-buttons-at-390px/behavior-method-editor-mobile.png), [계산 결과](../output/playwright/redesign-2026-09-07T09-38-45-396Z-b5f22e0c/browser/package-behavior-browser-B-52f19-d-reload-does-not-reroll-it/behavior-action-result-mobile.png), [정리한 서재](../output/playwright/redesign-2026-09-07T09-38-45-396Z-b5f22e0c/browser/package-editor-browser-PKU-f6c18-ect-internal-lore-authoring/package-library-mobile.png)를 직접 확인했어요. 입력과 안내가 화면 안에 배치되고 결과의 HTML 형태 문자열은 텍스트로 표시돼요.

검사에는 다음 실패·경합 경계를 포함해요.

- 같은 Tool의 다른 call ID 재요청, 다른 입력 거부, 취소·거절 뒤 상태 미게시
- candidate의 원래 자동 결과 재사용과 이중 적용 방지
- 다른 패키지의 선행 상태 없이 기존 결과만 재사용하는 요청 거부
- authoritative parser 실패의 전체 행동 rollback, annotation 실패의 검증된 행동 유지
- source 수정·state CAS·중단한 Run의 늦은 행동 요청
- 현재 형식 보관·복원·포크와 변조된 결과·추첨·출처·journal의 원자적 거부
- 제작 체크박스·자동 입력의 초안 보존, 모델 전용 행동의 사용자 버튼 차단, 순수 계산 결과 표시와 390px 배치

## 범위

실제 공급자 토큰·지연·요금 절감률이나 창작 품질은 측정하지 않았어요. 외부 유료 호출·배포·개인 작품 검사는 수행하지 않아요. 공급자별 Tool schema와 호출 순서는 합성 전송으로 검증해요.

자동 실행 시점은 `before-turn` 하나예요. 임의 JavaScript/Lua 실행, 새 종류의 보조 모델 job, 범용 hook, 전용 달력·전투판은 이번 구현에 포함하지 않아요. 같은 판정 기회의 재요청은 같은 입력·상태 의존성을 요구하며, 모델이 원할 때마다 새 주사위를 받는 기능은 제공하지 않아요.
