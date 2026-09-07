# M2 상태·기억·표현 후처리 · 2026-09-07

원문을 먼저 보존하고, 원문에 연결된 상태·기억 작업을 별도로 실행해요. 메인에는 준비된 상태와 필요한 기억을 실제 입력으로 전달하고, 오래된 원문은 같은 이야기의 허용된 ancestry 안에서 검색·읽기로 회수해요. 이번 결과는 합성 자료와 로컬 실행 계약을 다뤄요. 실제 추출 의미·전체 유료 비용을 평가하는 Q04와 특정 사용자 봇의 native module 포팅은 별도로 남아요.

**M2 로컬 S01–S07 PASS, 전체 M2는 외부 전제 BLOCKED예요.** [최종 근거](../output/m2-final/2026-09-07/summary.json): 전체 Vitest 567, M0 13+3, M1-local 55+6, UI 9+19, M2 78+4와 실패 탐지 selftest 11이 통과했어요. 모든 검증 서버 cleanup PASS, 필수 skip·실패 0이며 source/dist가 같아요. source/build는 `f1bd1f6aa5914f1519d5a0c4ce8ca692f496ffde71c74c01b1666225f8fdfaec`, dist는 `4e60cc3d37a17a9040b0f8cdecfb457775dae69b57d09ebc4d2d32f7220ebc89`예요.

## 시나리오별 구현 계약

| 시나리오 | 실제 동작 | 주요 근거 |
| --- | --- | --- |
| S01 상태 제안·계산·표시 | 보조 역할에 원문, 직전 상태, 필드 의미·범위, 버전 있는 규칙과 출력 schema를 제공해요. 모델은 근거가 있는 operation을 제안하고 reducer가 계산해요. 합성 지출 규칙은 코인 10에서 3을 빼 7로 만들며 다음 메인 입력에도 7이 들어가요. annotation은 canonical state가 아니에요. | [state reducer](../core/state.ts), [상태 회귀](../tests/state.test.ts), [역할 입력·protocol 왕복](../tests/story-runner.test.ts), [실제 파일 SQLite 통합](../tests/story.test.ts) |
| S02 늦은 상태와 다음 턴 | authoritative state가 필요한 다음 요청은 `waiting_for_state`로 저장돼요. 원문 읽기는 가능하고, 적합한 상태가 준비되면 고정된 요청을 재개해요. continuity는 다음 원문 작성을 막지 않지만 그 원문의 상태 추출은 이전 상태가 준비된 뒤 진행해요. annotation은 이 barrier를 만들지 않아요. | [상태 의존성 회귀](../tests/story-state-dependencies.test.ts), [HTTP hold·취소·실패·재시도](../tests/story.test.ts), [브라우저 흐름](../tests/story-browser.spec.ts) |
| S03 실패·재시도·규칙 변경 | 완료 transaction은 source/hash, ancestry, canon, module, parent state와 worker ownership/generation을 재검사해요. 중복 완료는 수치를 다시 적용하지 않아요. 늦은 결과와 무효한 결과는 현재 사실에 합류하지 않으며 원문·과거 산출물은 남아요. 불확실한 실행은 자동 재생하지 않아요. | [작업 저장](../server/story-store.ts), [원문·재시작·중복 완료](../tests/story.test.ts), [archive·fork 검증](../tests/story-archive.test.ts) |
| S04 작가 선언·사건·믿음 | `author-canon`, `observed-story`, `derived-summary`, `character-belief`, `hypothesis`, `preference`를 구분해요. 작가 선언은 작성자와 선언문 자체가 출처이며 transcript가 없으면 source anchor를 null로 저장해요. 추출 기억에는 실제 source revision/hash/range/quote가 필요하고 믿음·가설에는 actor가 필요해요. | [기억 타입·scope](../core/memory.ts), [선언·분기·retcon 저장](../server/story-memory.ts), [기억 회귀](../tests/memory.test.ts), [저장 회귀](../tests/story-memory.test.ts) |
| S05 장기 checkpoint·원문 회수 | 해당 ancestry에서 연속으로 indexing이 완료된 마지막 source가 watermark예요. 완료 순서가 뒤바뀌어도 중간 누락을 건너뛰지 않아요. 그 이후 원문 tail과 설정한 최근 원문은 실제 메인 입력에 남고, 이전 원문 전체와 원래 Run snapshot은 DB에 보존돼요. | [context 계획](../core/memory.ts), [메인 입력·도구](../core/provider.ts), [원문·기억 페이지 읽기](../core/story-context.ts), [20만 자 회수](../tests/story-performance.test.ts) |
| S06 상태창·장면 예약·표현 | 원고별 상태는 그 원고의 저장된 산출물을 표시해요. 장면 예약은 성공한 원문 commit과 함께 소비하며 실패·취소 때는 소비하지 않아요. 제한 regex는 별도 worker에서 실행하고, 결과는 HTML 실행 없이 텍스트 미리보기로 표시해요. 원문·번역·canonical state를 덮지 않아요. | [StoryPanel](../web/StoryPanel.tsx), [장면 예약 통합](../tests/story.test.ts), [표현 제한 회귀](../tests/presentation.test.ts), [브라우저 표시·네트워크](../tests/story-browser.spec.ts) |
| S07 데이터 증가와 에셋 | 같은 활성 경로에서 무관 보관량, 로어 수, 단일 원고 길이, 에셋 수를 각각 늘려 측정해요. 에셋은 정확한 ID/revision/hash와 actor/outfit/location/use 조합으로 선택해요. 없는 조합은 명시적인 `no-image` fallback이며 manifest 응답에 이미지 bytes·base64·URL을 일괄 넣지 않아요. | [에셋 manifest](../core/asset-manifest.ts), [에셋 회귀](../tests/asset-manifest.test.ts), [분리 측정](../tests/story-performance.test.ts) |

## 저장·의존성·복구 결정

SQLite schema는 **v4**예요. `story_configs`, `story_jobs`, `story_states`, `story_memories`, `story_indexes`, `scene_commands`를 추가하고, 실제 provider attempt는 `story_job_id`로 연결해요. 기존 데이터가 있는 migration은 변경 전에 별도 SQLite 백업을 만들어요. 정상 원문, Run 완료와 켜진 상태·기억 작업의 예약은 같은 짧은 transaction에 들어가요. provider 호출과 이벤트 전달은 그 밖에서 진행해요.

각 작업은 단순한 source ID뿐 아니라 source hash, ancestry, 관련 작가 선언, 상태 module·parent state 또는 선택된 기억 모델을 포함한 `dependency_key`로 식별해요. 같은 의미 의존성의 중복 작업을 막으면서, retcon 등으로 의존성이 달라진 명시적 재구축은 새 작업으로 남길 수 있어요. 제안 schema 통과가 의미상 사실임을 보증하지는 않아요.

상태는 실제 parent state의 불변 ID와 내용을 보존해요. continuity의 이전 상태가 늦으면 추출 job을 queued로 두고, 준비된 부모 상태를 job 입력에 고정한 뒤 claim해요. 이미 저장된 원문 Run snapshot을 그 과정에서 다시 쓰지 않아요. 상태 module의 시작 source가 편집된 경우에는 명시적 rebuild에서 그 source 직전의 초기 기준을 사용해요. module을 적용하기 전의 원문에 과거 규칙을 소급 적용하지 않아요.

`현재 장면에서 초기값으로 새 기준 적용`은 사용자가 선택한 branch/head에서 새 module revision을 만드는 명시적 동작이에요. 초기값과 영향 안내를 확인한 다음 적용해요. 과거 원문·상태·설정 revision은 남고, 이전 규칙을 기다리던 요청은 취소돼 새 요청이 필요해요.

작가 선언 수정은 새 row의 `replaces_id`로 연결해요. `retired_at`은 이력 metadata이며 전역 조회 제외 조건으로 사용하지 않아요. 현재 ancestry에서 보이는 replacement만 이전 선언을 대신하므로, 공통 조상에서 갈라진 형제 분기는 자신의 원래 선언을 계속 볼 수 있어요. 원문 이전의 null-anchor 선언은 명시적으로 chat 전체에 적용돼요.

추출 기억과 index receipt는 완료 status만으로 현재 적격성을 판단하지 않아요. 원래 job snapshot의 ancestry/hash와 그 시점의 작가 선언을 현재 자료에 대조해요. 조상 retcon·원문 변경으로 무효해진 기억은 검색·읽기·건수·watermark에서 제외해요. mutation transaction에서는 관련 작업을 stale로 표시하지만 과거 row와 snapshot을 삭제하지 않아요. 무효한 이전 receipt는 새 적격 job의 receipt로 교체할 수 있어 재구축을 막지 않아요.

재시작에서는 아직 시작하지 않은 queued 작업을 보존하고, 실행 중이던 불확실한 작업을 interrupted로 남겨요. 명시적 재시도 전에는 자동 재생하지 않아요. archive 복원·선택 ancestry의 fork도 source/state/memory ID와 의존성을 검증하고, provider attempt를 새 호출처럼 복사하거나 불확실한 작업을 자동 실행하지 않아요. 관련 근거는 [archive·fork 회귀](../tests/story-archive.test.ts)에 있어요.

## 실제 context와 페이지 읽기

compaction은 메인 입력을 구성하는 방법이며 DB 삭제가 아니에요. 유효한 작가 선언은 모두 필수 packet에 남아요. watermark 이후 원문 tail도 조용히 자르지 않아요. 두 필수 부분이 설정한 `maxPacketChars`를 넘으면 `ready:false`와 진단을 반환하고 새 생성 요청을 거부해요. 기억 자동 정리가 꺼져 있어도 필수 작가 선언의 한도를 우회하지 않아요. 다른 typed memory를 생략하면 생략 건수와 scoped search 경로를 알려요.

메인은 `memory.search/read`와 `story.search/read`를 실제 tool call/result 왕복에서 사용해요. `story.read`는 원문 text와 정확한 revision/hash/range를 반환하고 `nextOffset`으로 다음 구간을 읽어요. `memory.read`의 text와 provenance는 별도로 페이지화해요. 긴 evidence quote나 작가 선언 text를 metadata에 다시 넣지 않으며, 출처는 revision/hash/start/end를 유지해 원문으로 돌아갈 수 있어요.

tool result의 직렬화된 UTF-8 JSON 상한은 **24,000bytes**예요. 요청한 문자 limit보다 먼저 상한에 도달하면 본문 `nextOffset` 또는 검색 `nextOffset`을 반환해요. 출처가 많으면 `sourceContinuation`의 `sourceOffset`으로 이어 읽어요. 이 byte 상한과 context 설정의 글자 수 상한은 서로 다른 제한이에요. Unicode·NUL·emoji와 많은 source refs의 무손실 회수는 [tool context 회귀](../tests/story-context.test.ts)에 있어요.

로어의 기본 메인 catalog는 최대 100개 metadata를 보여 주고 남은 자료는 같은 허용 scope에서 `knowledge.search`·`skills.list`로 발견할 수 있어요. 이것이 로어 접근 whitelist는 아니에요. 검색 건수와 읽기에서도 다른 채팅·형제 후보·미래 원문은 제외돼요. 모든 턴에 별도 planner·selector·critic 모델을 호출하도록 만들지 않았어요.

## 사용 흐름과 API

이야기의 **상태와 기억**에서 module·상태 모델·기억 정리 모델과 기억 분량을 저장해요. 합성 항구 예제는 저장 전 초안에 넣는 시험용 module이며 사용자 봇의 실제 포팅 결과가 아니에요. 원고가 완료되면 원고별 상태와 별도 작업 진행 상황을 볼 수 있어요. 실패한 작업은 재시도하고, 원문·의존성이 달라진 작업은 해당 source에서 재구축해요. `기존 원고의 기억 정리`는 선택한 분기의 원문 indexing을 요청해요.

작가 선언은 직접 추가·수정하고, 장면 예약은 이름과 요청을 저장한 뒤 실행해요. 상태를 기다리는 동안 원문을 읽을 수 있어요. 표시 문구 변환은 원문을 보존하는 미리보기예요. regex replacement는 입력한 문자열 그대로이며 `$1` 같은 치환 확장은 지원하지 않아요. 입력·출력·규칙 수·pattern 길이 제한과 timeout이 있고 worker를 임의 코드 실행용 security sandbox로 주장하지 않아요.

| 목적 | API |
| --- | --- |
| 설정 조회·저장 | `GET /api/chats/:id/story`, `PUT /api/chats/:id/story/config` — `expectedRevision`으로 충돌 검사, 선택 branch와 명시적 `resetState` 지원 |
| 원고별 상태·작업 | `GET /api/sources/:id/story`, `GET /api/story-jobs/:id` |
| 작업 복구·취소 | `POST /api/story-jobs/:id/retry`, `/cancel`, `POST /api/sources/:id/story/rebuild` |
| 과거 원문 indexing | `POST /api/chats/:id/story/index` |
| 작가 선언·retcon | `POST /api/chats/:id/story/memory`, `POST /api/chats/:id/story/memory/:memoryId/retcon` |
| 장면 예약 | `POST /api/chats/:id/scene-commands`, `POST /api/scene-commands/:id/run`, `/cancel` |
| 표현·에셋 | `POST /api/sources/:id/presentation`, `GET /api/chats/:id/asset-manifest`, `POST /api/chats/:id/asset-manifest/resolve` |

GET 조회만으로 모델을 호출하거나 저장 상태를 바꾸지 않아요. 브라우저의 재시도·진행 표시와 실제 DB 결과는 따로 확인해요. 화면에서 선택한 원고가 바뀌었다는 이유만으로 늦게 도착한 결과를 다른 source에 저장하지 않아요.

## 독립 검토 반례와 수정

| 재현한 반례 | 수정한 계약과 회귀 |
| --- | --- |
| 동일 지출 근거를 다른 operation ID 또는 event alias로 보내면 중복 차감할 수 있었어요. | 수치 field의 같은·겹치는 evidence를 재사용한 제안을 거부하고, 서로 떨어진 실제 사건은 각각 적용해요. [state 회귀](../tests/state.test.ts) |
| continuity의 다음 원문이 이전 상태보다 빨리 완성되면 후속 추출이 초기값에서 시작할 수 있었어요. | 부모 상태가 준비될 때까지 추출 claim을 미루고 그 불변 parent ID/내용을 고정해요. 원래 Run snapshot은 보존하며 잘못된 owner/generation·중복 완료를 거부해요. [상태 의존성 회귀](../tests/story-state-dependencies.test.ts) |
| module 시작 원문을 편집하면 기존 activation hash와 맞지 않아 적격한 rebuild·대기 해제가 막힐 수 있었어요. | 명시적 rebuild는 시작 source 직전의 기준을 고정하고, 필요하면 선택 branch에서 새 초기 기준 revision을 명시 적용해요. 이전 원문·설정의 소급 해석을 막고 export/import·fork도 확인해요. [activation·reset 회귀](../tests/story-state-dependencies.test.ts) |
| 조상 retcon 후 완료된 후손 기억과 receipt가 남아 현재 조회에 섞이고 새 indexing을 막을 수 있었어요. | author-only canon hash와 원래 ancestry에 따른 freshness를 읽기와 commit에서 검사해요. 오래된 row·snapshot은 남기되 현재 노출에서 제외하고 무효 receipt 교체를 허용해요. [기억 저장 회귀](../tests/story-memory.test.ts) |
| `memory.read limit=1`이어도 metadata의 긴 source quote가 통째로 전달될 수 있었어요. | metadata에서 quote·선언 본문 중복을 제거하고 본문·출처·검색에 실제 byte 상한과 continuation을 적용해요. 짧은 읽기, 대량 refs, 검색의 모든 항목과 Unicode 원문 복원을 검증해요. [tool context 회귀](../tests/story-context.test.ts) |

## S07 측정 축과 해석 범위

각 축은 별도의 임시 파일 SQLite에서 동일한 활성 source 6개를 유지하고 한 조건만 늘려요. 조건마다 warmup 1회 뒤 5회 측정하며 원자료, median과 nearest-rank p95를 남겨요. 표본이 5개이므로 이 p95는 최대값이며 안정적인 모집단 tail latency 추정이 아니에요. fixture 생성·삽입·편집·재index와 assertion 시간은 측정 구간 밖이에요.

| 늘린 조건 | baseline → 큰 조건 | 기능 검증 |
| --- | --- | --- |
| ancestry 밖 보관 source/run | 10 → 1,000개 | 활성 source history, 검색 결과와 실제 메인 입력이 같아요. archive import/export UI의 처리 시간을 뜻하지 않아요. |
| 로어 | 50 → 500개 | 기본 catalog는 100개로 제한하고 첫 100개 밖 자료를 검색·본문 읽기로 회수해요. |
| 단일 오래된 원고 | 10,000 → 200,000자 | 완료 checkpoint가 실제 메인 입력 history를 최근 2개로 줄여도 200,000자 전체를 25페이지로 회수해요. 편집 이전 원문도 보존해요. |
| 에셋 | 10 → 1,000개 | 작은 실제 PNG BLOB을 저장하되 manifest 검색·resolve에는 metadata만 반환해요. 없는 복장 조합은 `no-image`예요. |

측정 경로는 DB의 history/resources 로딩과 context 준비·메인 입력 작성, 원문 검색·전체 페이지 회수, 로어 검색·읽기, 에셋 metadata 로딩·검색·resolve를 나누어 기록해요. 환경에는 Node/SQLite/OS/CPU, 메모리와 process 정보를 남겨요. 테스트 내부 측정은 순차 실행하지만 다른 프로세스·다른 작업자의 CPU 경쟁은 통제하지 않아요.

최종 측정 원자료는 [story-performance.json](../output/playwright/m2-2026-09-07T01-58-05-534Z-414e75fb/story-performance.json)이에요. warm-cache 로컬 backend 결과이며 브라우저 paint, 실제 모바일 기기, GPU, 외부 네트워크, provider 지연을 측정하지 않아요. 상대적인 시간 차이를 통과 기준으로 삼지 않으며 모든 기기·전체 앱이 빨라졌다고 일반화하지 않아요.

## 최종 검증과 남은 전제

| 구분 | 상태·근거 |
| --- | --- |
| `node scripts/verify.mjs --milestone M2` | localStatus **PASS**, 전체 **BLOCKED** — S01–S07 78 unit + 4 browser PASS, 실패 0. [실행 보고서](../output/playwright/m2-2026-09-07T01-58-05-534Z-414e75fb/summary.json) |
| 최종 summary·reporter·화면·DB·S07 측정 JSON | [최종 summary](../output/m2-final/2026-09-07/summary.json), [M2 실행 폴더](../output/playwright/m2-2026-09-07T01-58-05-534Z-414e75fb), [전체 unit](../output/m2-final/2026-09-07/vitest.json) |
| Q04 의미·장기 품질·전체 비용 | **BLOCKED / 이번 실행 밖** — 실제 추출의 누락·오해·무근거 정보·annotation 오염과 main-only/aux 비교를 위한 승인된 자료·모델·호출 수·비용 범위가 필요해요. |
| 특정 봇 native module 포팅 | **BLOCKED / 이번 실행 밖** — 대상 사용자 봇과 1회 포팅 권한·자료가 제공되지 않았어요. 합성 module, 제한 regex, structured state 계약이 Lua/CBS 전체 호환을 뜻하지 않아요. |

`M2-local`은 합성 로컬 계약을 판정해요. `M2`는 로컬 검사가 통과해도 Q04·native-port 전제가 남으면 BLOCKED로 끝나도록 분리했어요. `fixture-sse-v1`과 localhost protocol 왕복은 실제 서버 입력·도구·저장 경계를 확인하는 자료이며 live 모델의 추출 정확도 증거가 아니에요. 이번 구현·회귀 검증에 새 유료 provider 호출이나 개인 작품을 사용하지 않았어요. 기존 M1 실제 호출·실패·비용 기록은 [M1-RESULTS](M1-RESULTS.md)에 그대로 보존해요.

확인용 앱: [M2 합성 이야기 열기](http://127.0.0.1:54490/?chat=45ba128d-054a-466c-ac08-502b5a6236d2&branch=main%3A45ba128d-054a-466c-ac08-502b5a6236d2). 검증 DB를 별도로 복사하고 빌드를 고정했어요. 상태 coins=7과 production control endpoint 비노출(404), provider 연결 0개·허용 origin 빈 목록을 확인했어요. [소유권](../output/m2-final/2026-09-07/preview/manifest.json). 기존 M1 미리보기와 사용자 DB를 보존해요.

첫 통합 브라우저 실패는 새로 업로드한 5개 에셋의 선로딩 검사에 정상 프로필 요청까지 포함한 테스트 범위 오류였어요. 대상 ID를 추적하고 전체 요청 목록을 남겼어요. M0에서는 새 버튼과 겹친 부분 이름 선택자를 정확한 이름으로 바꿨어요. 기존 assertion을 삭제하거나 기대 동작을 완화하지 않았으며 최초 실패 보고서는 최종 summary에 보존해요.
