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
| `run` | `Store.createRunInTransaction` | 옵션 소비 → override·package resources → source segments → story → 선택된 outline → logical history → 패키지 상태 초기화 → before-turn 행동·추첨 예약 → lore → context → compile |
| `authored` | 같은 Store 경로의 작성된 도입문·transcript import | 옵션 소비 → override·package resources → source segments → 선택된 outline → logical history → 패키지 상태 초기화 → lore → compile |
| `helper-artifact` | `helperWritingSnapshot(..., 'artifact')` | caller의 고정 옵션·resources → source segments → story → logical history → 패키지 상태 읽기 → lore → context → 적합한 이전 요약 |
| `helper-context` | `helperWritingSnapshot(..., 'context')` | helper artifact와 같은 읽기 순서이며 `executionPurpose: 'artifact'` 표시는 붙이지 않아요. |
| `preview-main` | `promptRoutes` | source segments → story → logical history → caller 시각 캡처 → 패키지 상태 읽기 → lore → route에서 compile |
| `preview-translation` | `promptRoutes` | story → logical history → caller 시각 캡처 → 패키지 상태 읽기 → route에서 원문 시점 snapshot과 번역 program·values로 compile |
| `resume-state` | `StoryStore.resumeWaiting` | caller의 head·lineage·canon 검증 및 고정 state 채움 → lore → compile |

`authored`는 실제 `packageStart.mode === 'authored'` 또는 `transcriptImport` 표식과 일치해야 해요. story·before-turn 행동·context 준비를 생략하지만 기존 compile은 유지해요. 일반 `run`도 상태 또는 context가 대기 중이면 기존 `compileSnapshotPrompt` 정책에 따라 최종 compile을 미뤄요.

preview는 기존대로 채팅 옵션 freeze와 context seed를 실행하지 않아요. 이 통합은 미리보기의 의미를 새로 바꾸지 않아요. 기존 원문의 번역 미리보기는 그 원문 Run의 snapshot과 source hash를 사용해요.

## 전체 체인을 다시 실행하지 않는 경로

- `createPackageStart`의 초기 행동은 기존 callback 안에서 먼저 실행하고, 이어지는 Store 예약이 `run` 또는 `authored` 체인을 실행해요. 작성된 도입문은 초기 행동·예약·정확한 원문 완료가 같은 transaction에 남아요.
- candidate는 원래 snapshot과 추첨을 복사해요. 기존 artifact 수정도 artifact 자신의 snapshot을 유지해요.
- 원문 상태 rebuild는 원래 Run의 문맥과 해당 보조 작업 계약을 사용해요. archive 검증·fork remap도 저장된 snapshot의 검증·재귀속 경로를 유지해요.

## 검증

`tests/reservation-snapshot.test.ts`는 일곱 purpose의 단계 순서, preview의 시각 캡처 위치, authored 표식, caller 입력 보존을 확인해요. 실제 SQLite를 사용하는 helper 검사는 고정 옵션이 resources보다 먼저 적용되고 pending 옵션·DB가 바뀌지 않는 것을 확인해요.

기존 `chat-options`, `model-workspace`, `package-start`, `chat-transcript`, `package-behavior-run`, `helper-workspace`, `lore-context`, `translation-context`, `story`, `context-checkpoint-storage`, `outline`, `snapshot-archive` 회귀가 예약·재개·원문 귀속을 보호해요. `module-cycles`는 새 런타임 값 import 순환이 없는 것을 확인해요.
