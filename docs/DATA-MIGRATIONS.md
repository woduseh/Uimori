# DB와 자료 교환 형식

구현은 `server/database-schema.ts`, DB 시작 경계는 `server/store.ts`예요. 설치·백업·컨테이너 전환은 [업데이트 안내](UPDATES.md)를 봐요.

## 현재 버전

| 구분 | 현재 버전 | 소유 코드 | 의미 |
| --- | --- | --- | --- |
| 앱 | 0.0.1 | `package.json` | 개인 개발 중인 버전 |
| SQLite DB | 21 | `server/database-schema.ts`의 `DATABASE_SCHEMA_VERSION` | Risu 원본 콘텐츠를 사용하는 현재 저장 구조 |
| 전체 JSON archive | 1 (`uimori-archive`) | `server/product-store.ts` | 현재 버전의 전체 자료 내보내기와 빈 DB 복원 |
| 채팅 전체 백업 | 1 | `core/chat-backup.ts`의 `CHAT_BACKUP_VERSION` | `uimori-chat-backup` 교환 형식 |
| 자료 파일 이동 | 1 | `core/native-transfer.ts`의 `NATIVE_TRANSFER_VERSION` | `uimori-native-transfer` 교환 형식 |

현재 앱은 **비어 있는 DB와 현재 버전의 DB만 열어요.** 구형 DB를 읽거나 변환하는 migration, 구형 JSON·채팅 백업의 구조를 보충하는 호환 경로는 제공하지 않아요. 외부 Risu 카드·모듈·프롬프트의 원본 명세는 이 앱의 저장 버전과 별개예요.

기본 DB는 `.local/uimori.sqlite`예요. 기존 파일을 자동 검색·이동·삭제하지 않아요. 구형 DB를 `UIMORI_DB`로 지정하면 저널 설정·DDL·기본값 삽입·worker 시작 전에 명시적으로 거절해요. 새 작업은 별도의 빈 `UIMORI_DB` 경로에서 시작해요. 비어 있지 않은 무버전 DB와 미래 버전도 같은 원칙으로 거절해요.

빈 DB의 표·인덱스·기본값·현재 버전 표시는 한 transaction으로 만들어요. 초기화나 외래키 검증이 실패하면 전체를 되돌리고 DB와 파일 소유권을 해제해요. 이 과정에서 외부 모델을 호출하지 않아요.

`schema_metadata`는 현재 구조의 이름과 SQLite 표·인덱스 정의의 해시를 보관해요. 재개방은 이 구조가 그대로인지 확인하고, 빠지거나 바뀐 표를 자동으로 수리하지 않아요. 과거 단계별 migration 이력은 보관하지 않아요. SQLite 백업에는 현재 구조 메타데이터가 포함되지만 JSON 내보내기는 대상 DB가 생성한 메타데이터를 유지해요.

## 데이터 소유권

전체 archive 복원의 빈 DB 판정은 작업 프롬프트의 revision을 제외한 실제 설정을 비교해요. 기본 JEV 판정값은 생략되어 있거나 명시적으로 저장되어 있어도 같게 취급하지만, 판정을 끄거나 기준을 바꾼 설정은 사용자 데이터로 보아 복원을 막아요.

서버 실행·동시 채팅·분기·이야기 기억·모델 연결·삽화 작업은 현재 DB에 보관해요. 카드 변수와 원본 스크립트의 실행 영수증도 채팅과 분기에 귀속돼요. 복원은 원문·해시·소유권·참조·실행 결과의 정합성을 검사하며, 스크립트나 불확실한 외부 호출을 다시 실행하지 않아요.

개발 DB 초기화 명령인 `npm run reset:dev`는 사용자가 별도로 실행할 때만 작동해요. 현재 checkout의 기본 DB와 SQLite sidecar만 대상으로 하고, 다른 DB·명시적 백업·과거 파일은 선택하지 않아요. 실행 중인 서버·우회 경로·링크 파일을 거절하는 검사는 유지해요.

## 검증

`tests/database-schema.test.ts`는 현재 DB의 생성·재개방, 구형·미래 DB의 바이트 보존과 거절, 구조 손상 거절, 초기화 실패 rollback을 확인해요. `tests/schema-baseline-reset.test.ts`는 현재 archive 왕복과 개발 초기화 명령의 고정 대상·소유권·경로 경계를 확인해요. 검증에는 격리된 합성 DB만 사용해요.
