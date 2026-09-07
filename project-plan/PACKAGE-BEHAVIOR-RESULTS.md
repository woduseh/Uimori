# CBS 계열 기능과 패키지 동작 구현 결과

기준일: 2026-09-07. 사용자가 승인한 CBS 활용성 보강을 공통 읽기 문맥·계산기·패키지 상태/행동·화면에 연결했어요. 기존 작업트리 변경을 보존하며 구현했고 이번 변경은 커밋·push하지 않았어요. 실제 사용자 DB나 개인 카드·유료 provider를 검증에 사용하지 않았어요.

## 구현

- `core/prompt-program.ts`, `prompt-values.ts`: 타입 있는 객체·목록·지역 변수, map/filter/each/let, 산술·문자열·목록 CRUD·UTC 날짜. 기존 scalar 연산 의미를 보존하고 전체 식 batch의 실행량·결과 상한을 공유해요.
- `core/execution-context.ts`: 분기와 source hash에 고정된 상태/이력, 패키지별 기본 옵션과 추첨 결과, 기준 시각, 역할별 모델 metadata. 히든 제외·persona 비참조를 존중하고 credential/endpoint는 노출하지 않아요.
- `core/package-behavior.ts`, `server/package-behavior-*.ts`: typed schema, 액션의 고정 before-state 효과, 범위가 있는 추첨, 원문의 JSON/구분자 파서, CAS·중복 제출·journal. 파서 실패가 완료 원문을 지우지 않아요.
- Run/candidate/branch/fork와 schema/archive v7: 생성 전·선택 원문 후의 상태를 구분하고 기록된 난수를 유지해요. 원문이나 선행 원문이 바뀐 파생 상태를 차단하고, 명시 reset으로 새 revision을 만들어요. 오래된 reset 재전송이 새 원문 변경을 수용하지 않아요.
- `web/PackageBehaviorPanel.tsx`, `PackageFields.tsx`: 상태 읽기, 타입별 행동 폼, 중복 실행 잠금, 충돌 후 초안 보존, JSON 검증·명시 적용·이탈 확인. main 지침의 `position`은 프롬프트의 선언된 slot에 공급해요.

사용법은 [PACKAGE-BEHAVIOR](../docs/PACKAGE-BEHAVIOR.md), 계산 문법은 [PROMPT-RUNTIME](../docs/PROMPT-RUNTIME.md), 제작용 합성 자료는 [daily-state-behavior.json](../fixtures/daily-state-behavior.json)에 있어요.

## 검증

| 검사 | 최종 결과 |
| --- | --- |
| `npm run check` | PASS |
| `npm run build` | PASS |
| 전체 Vitest | **860/860 PASS**, 실패·skip 없음. [JSON 결과](../output/package-behavior-unit-tests.json) |
| `npm run verify:redesign` | **53/53 PASS**, 실패·skip 없음. [브라우저 summary](../output/playwright/redesign-2026-09-07T08-50-32-239Z-ac7a6e16/summary.json) |
| 소스/빌드 일치·cleanup | PASS. 테스트 프로세스 잔존 없음, 임시 runtime 제거, 증거 DB 보존 |
| `git diff --check` | PASS |

최종 source/build ID는 `43b99e994297335dbba0bda5633963284d08cf45529ec04f98def91aec400868`, dist hash는 `545e24da728875c6ad0e805c69fdb07e6a49f547a7d770f8e21e55fcb3f15bba`예요. 390px [행동 폼 화면](../output/playwright/redesign-2026-09-07T08-50-32-239Z-ac7a6e16/browser/package-behavior-browser-B-a5a32-render-text-safely-at-390px/behavior-mobile.png)을 직접 열어 입력·도움말·버튼 배치와 가로 넘침 없음을 확인했어요. 캡처는 충돌 뒤 입력 및 잘못된 JSON 초안이 보존된 시점이에요.

첫 전체 브라우저는 51 PASS / 2 FAIL / 0 skip이었어요. 신규 두 검사의 입력 레이블 조회가 실제 도움말/textarea DOM과 맞지 않아 접근성 이름과 도움말 연결을 명시했어요. CAS 검사도 전송 중 경쟁 요청을 넣어 SSE 자동 갱신과 무관하게 실제 충돌을 검증하도록 수정했어요. 첫 실패는 [첫 summary](../output/playwright/redesign-2026-09-07T08-44-43-955Z-66171e21/summary.json)에 그대로 보존하며 최종 PASS와 구분해요.

샌드박스에서 Vite/빌드의 자식 프로세스가 `spawn EPERM`으로 막힌 실행은 성공으로 세지 않았어요. 동일한 로컬 검사에 대한 승인 실행에서 실제 결과를 확인해요. UI 하네스는 새 포트·DB·프로필·temp를 소유하고 cleanup 결과를 기록해요.

## 한계

CBS 태그·Lua/JavaScript·HTML의 직접 실행 호환, 원본 봇 전체 포팅, 자동 before-main hooks, 패키지가 정의하는 임의 보조 model jobs, 전용 전투판/달력 view DSL은 이 구현의 완료 범위가 아니에요. 기존 상태·기억·번역·이미지 보조 경로와 패키지 지침은 유지해요. package/behavior/schema 개정 간 자동 migration은 없으며 기존 정의와 같은 상태의 명시 reset을 제공해요.

합성 인물·목록·자원·일정·주사위와 source/CAS·오류·복원 검사가 실제 카드의 전체 의미, 실제 모델 품질·비용, 장기 플레이를 보증하지 않아요. 빌드의 단일 client chunk 크기 경고는 남아 있으며 빌드 실패는 아니에요.
