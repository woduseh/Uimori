# DB와 자료 교환 형식

구현은 `server/database-schema.ts`, DB 시작 경계는 `server/store.ts`예요. 설치·백업·컨테이너 전환은 [업데이트 안내](UPDATES.md)를 봐요.

## 현재 형식

| 구분 | 버전 | 소유 코드 |
| --- | --- | --- |
| SQLite DB | 24 | `server/database-schema.ts` |
| Uimori 콘텐츠 투영 | 2 | `core/risu-content.ts` |
| Risu 원본 저장 봉투 | 1 | `core/risu-native.ts` |
| 전체 JSON archive | 1 (`uimori-archive`) | `server/product-store.ts` |
| 채팅 전체 백업 | 1 | `core/chat-backup.ts` |
| 자료 파일 이동 | 1 | `core/native-transfer.ts` |

콘텐츠 version 2에는 별도의 `instructions` 필드가 없어요. Risu 카드의 `post_history_instructions`는 원문에 남고 네이티브 프리셋이 배치해요. 창작·번역 프리셋, 도우미·협업 에이전트와 프로바이더의 지침은 별개의 기능이며 제거 대상이 아니에요.

현재 앱은 **빈 DB와 현재 schema-24 DB만 열어요.** schema-23을 포함한 구형 DB의 이관·자동 변환은 제공하지 않아요. 콘텐츠 version 1이나 `instructions`가 있는 Uimori 자료는 빈 배열이라도 수용하지 않으며, 누락 필드를 보충하거나 옛 형식을 현재 형식으로 위장하지 않아요. 외부 Risu 카드·모듈·RISUP 명세는 Uimori 내부 저장 버전과 별개예요.

기본 DB는 `.local/uimori.sqlite`예요. 이전 DB를 새 코드에 그대로 지정하면 시작 경계에서 거절돼요. 기존 DB·백업을 그대로 보관하고, 새 작업은 별도의 **빈** `UIMORI_DB` 경로 또는 별도 데이터 볼륨에서 시작해요. 앱은 기존 파일을 자동 검색·이동·삭제하지 않아요. 전체 archive·채팅 백업·자료 교환의 외부 봉투 버전이 같더라도 내부 콘텐츠·실행 데이터의 현재 형식 검사를 통과해야 하므로 구형 백업 복원을 보장하지 않아요.

## DB 시작과 소유권

구형·미래 DB와 비어 있지 않은 무버전 DB는 저널 설정·DDL·기본값 삽입·worker 시작 전에 거절해요. 빈 DB의 표·인덱스·기본값·현재 버전 표시는 하나의 transaction으로 만들어요. 초기화나 외래키 검증이 실패하면 롤백하고 DB와 파일 소유권을 해제해요. 이 과정에서 외부 모델을 호출하지 않아요.

`schema_metadata`는 현재 구조의 이름과 SQLite 표·인덱스 정의의 해시를 보관해요. 재개방은 이 구조가 그대로인지 확인하고, 빠지거나 바뀐 표를 자동 수리하지 않아요. SQLite 백업에는 현재 구조 메타데이터가 포함되지만 JSON 복원은 대상 DB가 생성한 메타데이터를 유지해요.

실행 예약 시의 원문·변수·프롬프트·모델과 실행 결과는 고정해요. 복원은 원문·해시·소유권·참조·실행 결과의 정합성을 검사하며, 스크립트나 불확실한 외부 호출을 다시 실행하지 않아요. 이 보장은 현재 형식의 정확성을 위한 것이며 구형 내부 형식의 호환 지원과는 달라요.

개발 DB 초기화는 사용자가 `npm run reset:dev`를 별도로 실행할 때만 수행해요. 현재 checkout의 기본 DB와 SQLite sidecar만 대상으로 하고, 실행 중인 서버·링크·우회 경로를 거절해요. 다른 DB나 백업을 선택하지 않아요.

## 스냅샷 본문 저장

긴 문자열은 SHA-256 공용 본문 테이블에 저장하고, 스냅샷은 경로별 해시를 보관해요. 읽을 때 해시를 검증해 정확한 문자열을 복원해요. 본문은 불변이며 마지막 참조가 없어질 때 같은 transaction에서 정리해요. 원문 수정은 고정된 스냅샷에 영향을 주지 않아요.

일반 JSON archive는 참조를 풀어 자체 완결된 스냅샷을 내보내고, 복원은 대상 DB의 공용 본문과 참조를 다시 만들어요. SQLite 백업은 공용 본문과 참조까지 포함해요. 이 구조가 JSON 내보내기 크기나 실행 중 메모리까지 줄여 주는 것은 아니에요.

저장 경계는 `server/snapshot-database.ts`예요. `snapshot_pack(?)`으로 본문을 분리하고 트리거가 참조와 정리를 관리해요. DB 어댑터가 읽기 결과를 복원하며, 목록 SQL은 메타데이터 또는 `snapshot_text(snapshot, JSON 경로 배열)`로 필요한 문자열만 읽어요. 참조 갱신은 차이만 반영하고 본문 정리는 해당 해시의 인덱스를 사용해요.

## 현재 DB의 물리적 성능 정리

`server/database-performance.ts`의 참조 트리거와 보조 인덱스는 새 DB 초기화에 포함돼요. `scripts/optimize-database.mjs`는 **현재 지원 버전** DB의 알려진 물리 구조만 검사·최적화하는 도구이며, 구형 schema-23을 schema-24로 바꾸는 이관 도구가 아니에요. 시작 시 자동 실행하지 않아요.

서버를 중지하고 명시적인 DB 경로를 지정해요.

```powershell
npm run build
node scripts/optimize-database.mjs --db C:\absolute\path\uimori.sqlite
node scripts/optimize-database.mjs --db C:\absolute\path\uimori.sqlite --apply
```

첫 명령은 상태 조회예요. 적용은 파일 소유권과 기존 서명을 확인하고 SQLite 백업을 먼저 만든 뒤 알려진 트리거·인덱스와 구조 서명만 transaction으로 갱신해요. 스냅샷 본문을 재작성하거나 임의 복구·전체 orphan 정리·VACUUM·모델 호출을 하지 않아요. 실행 중인 서버, 알 수 없는 구조, 외래키 오류와 다른 스키마 버전은 거절해요. 수동 DDL로 버전·서명 검사를 우회하지 않아요.

## 검증

`tests/database-schema.test.ts`와 `tests/schema-baseline-reset.test.ts`는 빈/current DB 생성·재개방, 지원하지 않는 DB의 거절·보존, 초기화 롤백과 개발 초기화 범위를 확인해요. `tests/native-content-format.test.ts`는 현재 콘텐츠와 Risu 원문의 보존, 구형 콘텐츠 및 제거된 필드 거절, schema-23 파일의 무변경 거절을 확인해요.

본문 저장·참조·물리 최적화는 `tests/database-performance.test.ts`, `tests/database-performance-store.test.ts`, 빌드 후 `node --test scripts/optimize-database.test.mjs`로 확인해요. 모두 격리된 합성 DB를 사용해야 해요.
