# DB migration과 교환 형식

구현은 `server/schema-migrations.ts`, DB 시작 경계는 `server/store.ts`예요. 베타의 보존 원칙은 [방향 결정](DECISIONS-2026-09-12-BETA.md)을 따르고 일반 설치자의 Update·사전 백업·컨테이너 전환·복구는 [베타 계획](../project-plan/BETA-PLAN.md)의 후속 범위예요.

## 현재 버전과 지원 경로

| 구분 | 현재 버전 | 의미 |
| --- | --- | --- |
| 앱 | 0.0.1 | 베타 준비 중인 개발 버전 |
| SQLite DB | 20 | 버전별 migration 이력, 자료 이동 영수증·사용자 확장 작업·분기 공유 변수·유지보수 상태 |
| 전체 JSON archive | 15 | DB 내부 migration 이력과 독립인 기존 작품 교환 구조 |
| 채팅 전체 백업 | 1 | `uimori-chat-backup` 공개 교환 형식 |
| 자료 파일 이동 | 1 | `uimori-native-transfer` 공개 교환 형식 |

빈 DB는 기존 자료 구조를 초기화하고 같은 migration 경로로 v20에 도달해요. 고정된 15→16 단계는 알려진 삽화/구성 표와 `helper_tasks.started_at`의 누락만 보충해요. 16→17 단계는 `native_transfer_receipts`와 전체 요청 키 UNIQUE 제약을 추가해요. 17→18 단계는 `package_extension_operations`와 `package_extension_operation_attempts`를 추가해 사용자 확장 작업과 기존 attempt의 귀속을 보존해요. 18→19 단계는 `chat_variable_states`·`chat_variable_journal`·`chat_variable_outputs`를 추가해 분기 공유 변수·쓰기 영수증·source 시점 상태를 보존해요. 19→20 단계는 [유지보수 상태](SELF-HOST.md#유지보수-모드)를 보관하는 `maintenance` 한 행 표를 추가해요. 이전 migration의 SQL·기본값은 변경하지 않아요. 기존 행·원문·이미지·상태·난수·snapshot은 바꾸지 않으며 기본 변수 선언을 새 상태 표로 복사하지 않아요. 정상 v20을 다시 열 때는 migration이나 기본값 설치를 반복하지 않아요.

더 오래된 개발 버전, 비어 있지 않은 무버전 DB, 미래 버전, 현재 버전과 적용 이력의 불일치, 알려진 구조와 충돌하는 표는 명시적으로 거절해요. DB를 지우거나 버전을 낮춰서 여는 경로는 제공하지 않아요. 현재 v15~v20 지원을 모든 과거 개발 archive reader의 호환으로 확대하지 않아요.

자료 이동 영수증은 본문을 복제하지 않고 불변 자료 개정과 원래 참조·새 ID 매핑을 연결해요. 전체 archive 15에는 검증되는 선택적 collection으로 포함하고 과거 archive의 누락은 빈 목록으로 처리해요. [자료 이동 계약](NATIVE-TRANSFER.md)을 봐요. DB migration 이력은 계속 archive와 독립이에요.

사용자 확장 작업과 attempt 연결도 archive15·chat-backup1의 선택적 collection으로 보존하며 과거 파일의 누락은 빈 목록으로 처리해요. 교환 형식 버전은 그대로 유지해요.

분기 공유 변수의 세 표도 archive15와 chat-backup1의 선택적 collection이에요. 채팅 백업의 이름은 `variableStates`·`variableJournal`·`variableOutputs`이며 과거 파일의 누락은 빈 목록으로 처리해요. 복원은 분기·source 소유권, 문자열 맵 한도, revision과 쓰기 영수증의 정합성을 검증하고 상태를 재실행하지 않아요. 새 채팅으로 복사할 때 소유 ID만 바꾸며 변수 값의 문자열과 과거 snapshot은 현재 분기 값으로 보충하지 않아요. 사용자 직접 편집과 시점 복원의 의미는 [분기 공유 변수](PROMPT-RUNTIME.md#분기-공유-변수)를 봐요.

## 원자성과 소유권

DB의 소유권을 얻은 뒤 worker·복구 작업을 시작하기 전에 migration을 실행해요. 필요한 DDL·기본값 보충·`schema_migrations` 기록·`PRAGMA user_version` 변경은 한 transaction이에요. 초기화나 중간 단계, 완료 검증이 실패하면 그 transaction을 되돌리고 DB와 파일 소유권을 해제해요. 모델·브라우저·외부 요청은 이 transaction 안에 넣지 않아요.

`schema_migrations`는 적용 버전·안정된 migration 이름·완료 시각을 보관하는 내부 이력이에요. SQLite 백업에는 포함되지만 전체 JSON archive와 채팅 백업의 작품 자료에는 포함되지 않아요. 다른 설치의 자료를 복원하면서 대상 DB의 migration 이력을 원본 DB 것으로 덮어쓰지 않아요.

migration은 실행 중이던 Run/job의 상태를 직접 바꾸지 않아요. 앱의 기존 중단 복구와 분리하며, 복원·재시작이 불확실한 외부 요청을 자동 재전송하는 근거가 되지 않아요.

## 다음 변경의 규칙

- 적용된 migration의 SQL·기본값·의미는 고정해요. 다음 구조 변경은 새 버전과 migration으로 추가해요. 현재 스키마 번호를 유지하며 시작할 때 임의의 installer를 계속 실행하는 방식으로 돌아가지 않아요.
- 새 DB와 지원되는 이전 DB가 같은 결과 구조에 도달하도록 해요. 자료 교환 형식의 변경 필요성은 DB 버전과 별도로 판단해요.
- 원문·상태·참조 자료의 의미 변경이 필요하면 값 변환과 검증, 복구 방안을 함께 마련해요. 사용자 자료를 테스트 fixture로 사용하지 않아요.
- migration 도입만으로 한 번의 Update와 모든 실패 복구가 완성된 것은 아니에요. 사전 백업과 실제 복원, 업데이트 후 새 작업이 생긴 상황의 보존은 후속 제품 흐름에서 연결해요.

## 검증 근거

`tests/fixtures/schema-v15.sql`과 `schema-v15-data.json`은 시작 소스의 실제 v15 구조와 합성 사용자 데이터를 고정한 fixture예요. 최신 Store를 만든 뒤 버전 숫자만 낮춘 것을 유일한 이전 버전 증거로 사용하지 않아요.

`tests/schema-migrations.test.ts`는 fresh·재개방, 알려진 v15 변형, 행/BLOB/snapshot 보존, 충돌·future 버전 거절, 중간/최종 실패 rollback과 소유권 복구, SQLite·archive15·chat-backup1 왕복을 확인해요. 전체 결과는 [베타 진행 기록](../project-plan/BETA-PLAN.md)에 기록하며 실제 사용자 DB나 Linux 운영 업데이트 완료로 해석하지 않아요.
