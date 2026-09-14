# 예약 snapshot 고정 체인

2026-09-10 [결정 6](DECISIONS-2026-09-10.md)의 예약 체인 통합 계약이에요. 공통 실행은 `server/reservation-snapshot.ts`의 동기 함수 `freezeReservationSnapshot`이 맡고, 호출자가 명시적인 `purpose`를 전달해요.

## 소유권

- 호출자는 모델·profile 선택, 명령 CAS와 idempotency, transaction, 시각 생성, DB 저장·이벤트·worker 시작을 소유해요. 공통 함수는 이 경계를 새로 만들거나 모델을 호출하지 않아요.
- `run`과 `authored`는 호출자의 transaction 안에서 실행해요. 옵션 소비, 패키지 상태 초기화, 행동·추첨 영수증은 기존 예약과 함께 rollback돼요.
- helper는 profile의 채팅 고정 옵션을 **resources 생성 전에** 적용한 뒤 공통 함수에 전달해요. pending 옵션을 소비하지 않아요.
- preview의 시각 생성 callback은 공통 함수가 logical history를 고정한 뒤, 패키지 상태를 읽기 직전에 한 번 호출해요. 미저장 program·values의 compile과 번역 원문 snapshot 선택은 route가 소유해요.
- 이미 예약된 snapshot의 모델·옵션·원문·resources·시각은 대기 재개 때 다시 선택하지 않아요.

## purpose별 순서

| purpose | 호출 위치 | 고정 순서 |
| --- | --- | --- |
| `run` | `Store.createRunInTransaction` | 옵션 소비 → override·package resources → source segments → story → 선택된 outline → logical history → 패키지 상태 초기화 → before-turn 행동·추첨 예약 → Risu 호환 CBS 평가 → lore → context → compile |
| `authored` | 같은 Store 경로의 작성된 도입문·transcript import | 옵션 소비 → override·package resources → source segments → 선택된 outline → logical history → 패키지 상태 초기화 → Risu 호환 CBS 평가 → lore → compile |
| `helper-artifact` | `helperWritingSnapshot(..., 'artifact')` | caller의 고정 옵션·resources → source segments → story → logical history → 패키지 상태 읽기 → lore → context → 적합한 이전 요약 |
| `helper-context` | `helperWritingSnapshot(..., 'context')` | helper artifact와 같은 읽기 순서이며 `executionPurpose: 'artifact'` 표시는 붙이지 않아요. |
| `preview-main` | `promptRoutes` | source segments → story → logical history → caller 시각 캡처 → 패키지 상태 읽기 → lore → route에서 compile |
| `preview-translation` | `promptRoutes` | story → logical history → caller 시각 캡처 → 패키지 상태 읽기 → route에서 원문 시점 snapshot과 번역 program·values로 compile |
| `resume-state` | `StoryStore.resumeWaiting` | caller의 head·lineage·canon 검증 및 고정 state 채움 → lore → compile |

`authored`는 실제 `packageStart.mode === 'authored'` 또는 `transcriptImport` 표식과 일치해야 해요. story·before-turn 행동·context 준비를 생략하지만 기존 compile은 유지해요. 일반 `run`도 상태 또는 context가 대기 중이면 기존 `compileSnapshotPrompt` 정책에 따라 최종 compile을 미뤄요.

preview는 기존대로 채팅 옵션 freeze와 context seed를 실행하지 않아요. 이 통합은 미리보기의 의미를 새로 바꾸지 않아요. 기존 원문의 번역 미리보기는 그 원문 Run의 snapshot과 source hash를 사용해요.

## snapshot 영수증

`RunSnapshot.risuCompat`은 [가져온 카드가 보존한 Risu CBS](RISU-IMPORT.md#기본-변수와-읽기-cbs)를 예약 시점에 한 번 평가한 영수증이에요. `prepareRisuCompatReceipt`가 before-turn 행동 예약 직후, 즉 시각·profile·대화가 모두 고정되고 compile이 시작되기 전에 계산하므로 예약이 만든 프롬프트부터 평가문을 담아요. `run`과 `authored` 예약이 모두 이 영수증을 계산하며, 작성된 도입문은 영수증의 `start:<id>` 평가문을 그대로 원문으로 저장해요. 항목마다 필드 key, 평가문, 서비스할 수 없는 함수 이름, 그 평가가 실행한 `setvar`류 쓰기(`writes`, 호출 순서), 그리고 그 평가가 읽은 내용을 묶는 `inputHash`를 보관해요. `writes`는 원문을 저장할 때 분기 공유 변수로 채택하는 값이며 `inputHash`는 덮지 않아요. 이후 compile·후보·문맥 축약·포크·복원은 저장된 평가문만 투영하고 카드를 다시 평가하지 않아요. `inputHash`는 원문·이름·변수·대화·요청·예약 시각만 덮고 run ID는 덮지 않아요. 추첨 seed는 run에서 뽑지만, 포크와 채팅 백업 복원이 같은 영수증을 새 run ID로 옮겨도 검증이 성립해야 하기 때문이에요. 평가문 자체는 그 영수증이 만든 compile 결과가 묶어요. `server/snapshot-archive.ts`는 복원에서 영수증 구조와 각 `inputHash`를 평가 없이 다시 계산하고, 장착 패키지가 선언하지 않은 key나 값이 다른 항목을 거절해요. 전송 기록이 있는 Run에서 영수증이 사라지면 [전송 변환 영수증](PROMPT-TRANSFORMS.md#실행과-보존)과 같은 규칙으로 거절해요.

`RunSnapshot.loreActivation`은 같은 자리에서 계산하는 두 번째 영수증이에요. `prepareLoreActivationReceipt`가 `keyword` 모드인 장착 패키지마다 [키워드 활성화](LORE-CONTEXT.md#키워드-활성화) 엔진을 고정된 대화·요청·채팅 로어 정책에 대해 한 번 실행하고, 항목마다 패키지 key, 적용한 문자 예산, 활성화된 로어 ID 목록, 제외된 ID와 이유(`budget`·`probability`·`decorator`·`inactive`), 그리고 규칙·본문 hash·대화 hash·설정을 묶는 `inputHash`를 보관해요. 확률 지시문의 seed는 CBS 영수증과 같은 이유로 run에서 뽑되 hash에는 넣지 않아요. compile은 이 목록만 투영해 활성 항목을 고정 자료로, 나머지 규칙 있는 항목을 제외하며, 엔진이 실패한 항목은 결정 없음으로 보고 `loading`대로 돌아가요. 복원 검증은 CBS 영수증과 같은 규칙으로 구조·key 집합·`inputHash`·ID 소속을 다시 계산하고 전송 기록이 있는 Run의 누락을 거절해요.

`RunSnapshot.loreSelection`은 예약이 아니라 예약 직후의 worker가 계산하는 세 번째 영수증이에요. [모델 선별](LORE-CONTEXT.md#모델-선별)은 모델 호출이 필요해 예약 transaction 안에서 만들 수 없으므로, 아직 결정하지 못한 `run` 예약은 compile 없이 `contextBase`만 붙여 저장하고 worker가 답을 받은 뒤에 compile해요. worker는 행동 투영 전의 예약 snapshot을 그대로 읽어 `model` 모드인 장착 패키지마다 문맥 정리 모델을 한 번 부르고, 항목마다 패키지 key, 적용한 문자 예산, 고른 로어 ID 목록(모델이 준 순서), 제외한 ID와 이유(`budget`·`unknown`), 사용한 모델 ID, 그리고 후보 목록·최근 대화·요청·예산·모델·계약 판을 묶는 `inputHash`를 보관해요. 조회 로어 유지와 입력 계획은 그 뒤에 계산하므로 고정 자료 집계가 선별 결과를 반영해요. `inputHash`는 CBS 영수증과 같은 이유로 run ID를 덮지 않아요. `authored` 예약과 전사 가져오기, 미리보기는 선별하지 않고 모든 로어가 `loading`대로 동작해요. 복원 검증은 재현할 수 없는 모델 답 대신 구조·key 집합·`inputHash`를 다시 계산하고, 고르거나 예산으로 제외한 ID가 그 패키지의 후보인지 확인해요(`unknown` 항목은 후보가 아니라는 것이 기록의 뜻이라 이 검사에서 빠져요). 전송 기록이 있는 Run에서 영수증이 사라지면 다른 영수증과 같은 규칙으로 거절해요.

## 전체 체인을 다시 실행하지 않는 경로

- `createPackageStart`의 초기 행동은 기존 callback 안에서 먼저 실행하고, 이어지는 Store 예약이 `run` 또는 `authored` 체인을 실행해요. 작성된 도입문은 초기 행동·예약·정확한 원문 완료가 같은 transaction에 남아요.
- candidate는 원래 snapshot과 추첨을 복사해요. 기존 artifact 수정도 artifact 자신의 snapshot을 유지해요.
- 원문 상태 rebuild는 원래 Run의 문맥과 해당 보조 작업 계약을 사용해요. archive 검증·fork remap도 저장된 snapshot의 검증·재귀속 경로를 유지해요.

## 검증

`tests/reservation-snapshot.test.ts`는 일곱 purpose의 단계 순서, preview의 시각 캡처 위치, authored 표식, caller 입력 보존을 확인해요. 실제 SQLite를 사용하는 helper 검사는 고정 옵션이 resources보다 먼저 적용되고 pending 옵션·DB가 바뀌지 않는 것을 확인해요.

기존 `chat-options`, `model-workspace`, `package-start`, `chat-transcript`, `package-behavior-run`, `helper-workspace`, `lore-context`, `translation-context`, `story`, `context-checkpoint-storage`, `outline`, `snapshot-archive` 회귀가 예약·재개·원문 귀속을 보호해요. `module-cycles`는 새 런타임 값 import 순환이 없는 것을 확인해요.
