# 상태 준비와 본문 진행

정상적으로 진행할 수 있는 이야기 상태 준비는 기다리고, 실패하거나 사용자가 건너뛰면 같은 Run으로 본문을 계속해요. 구현은 `server/story-store.ts`·`server/story-routes.ts`, 입력 계약은 `core/story.ts`예요. 패키지 내부 상태와 행동의 별도 실행은 [PACKAGE-BEHAVIOR](PACKAGE-BEHAVIOR.md)를 봐요.

## 준비 상태

`StorySnapshot.preparation`은 `ready/pending/failed/skipped`와 원문 revision/hash 기준 누락 범위, 마지막 유효 상태를 보관해요. 과거 snapshot에는 없을 수 있어요.

- `ready`: 요청의 정확한 부모 상태를 사용할 수 있어요.
- `pending`: 필요한 상태 작업과 선행 작업이 실제로 대기/실행 중이에요. 기존 authoritative 모드는 같은 Run을 `waiting_for_state`로 보관해요. 명시적으로 선택한 continuity 모드의 비대기 동작은 유지해요.
- `failed`: 실패·취소·중단·stale·작업 부재 또는 사용할 수 없는 상태 모델 때문에 정상 준비를 기대할 수 없어요. 기다림을 해제해 본문을 진행해요.
- `skipped`: 사용자가 기다림을 건너뛰었어요. 상태 작업 자체를 취소하거나 다시 보내지 않아요.

본문 입력의 `storyInputState()`는 마지막 유효 상태를 참고할 수 있어요. 다음 상태 계산에 쓰는 `story.state`는 정확한 부모 상태만 허용해요. 뒤처진 상태를 다음 상태 계산의 부모로 사용하거나, 누락된 변화를 이미 반영한 것으로 표시하지 않아요. 원문 수정으로 출처를 검증할 수 없으면 이전 상태도 참고하지 않아요.

## 사용자 개입과 예약

기존 작업 내역에서 **상태 준비 건너뛰기** 또는 **원문 생성 취소**를 선택해요. 건너뛰기 API는 `POST /api/runs/:id/skip-state-wait`이며 chat/branch/부모 revision과 idempotency key를 검사해요. 같은 요청 재전송은 본문·추첨·상태 작업을 중복 생성하지 않아요.

준비가 끝나거나 건너뛸 때 바꾸는 것은 미뤄 둔 상태 입력뿐이에요. 처음 예약한 모델·프롬프트·옵션·시각·원문 이력·패키지 추첨을 현재 설정으로 다시 고정하지 않아요. 늦은 상태 결과는 원래 source/hash에 저장하고 이미 진행한 Run의 snapshot을 변경하지 않아요.

대기 중 원문·분기·작가 설정의 귀속이 바뀌면 그 요청은 실패로 남겨요. 한 대기 요청의 프롬프트 오류가 다른 채팅의 재개를 막지 않지만, DB 실패나 알려지지 않은 저장 오류를 부가 실패로 삼켜서는 안 돼요. 서버 재시작 때 기다리던 Run도 중단 상태로 보존하며 본문을 자동 전송하지 않아요.

작업 내역에는 준비 실패/건너뛰기, 마지막 확인 상태 사용 여부와 누락된 원문 개수를 보여줘요. 목록 조회에 실제 상태 본문을 추가로 노출하지 않아요. 아카이브·포크·채팅 백업은 이 참조를 검증하고 새 원문 ID로 옮겨요.

## 확인한 범위

`tests/story.test.ts`, `tests/story-state-dependencies.test.ts`, `tests/story-browser.spec.ts`의 S02/BPREP 검사가 파일 SQLite·HTTP·화면·지연 결과·중복·재시작을 합성 자료로 확인해요. 실제 상태 추출 모델의 의미 정확성은 별도 검증이에요.
