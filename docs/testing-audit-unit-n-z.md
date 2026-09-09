# 단위·통합 테스트 점검: n–z

범위는 `tests/*.test.ts`에서 basename 첫 글자가 n–z인 82파일이에요. `quality-architecture.test.ts`는 메인 점검 범위여서 제외했어요. 실행 경로와 case 본문 assertion, 같은 기능의 계층별 차이를 대조했어요. 제목 유사성만으로 서로 다른 parser/transport/store/HTTP 계약을 제거하지 않았어요.

## 커버리지와 결정

- 점검 시작: **82파일 / 633개 정적 test·it 선언**. `test.each`는 한 선언으로 집계하고 입력 행별 분기·assertion 계약을 포함해 검토했어요.
- 점검 후: **82파일 / 631개 정적 선언**. 구형 archive 버전 6개 실행 case와 중복 번역 캐시/수동archive 1개 실행 case를 기존 계약 검사에 흡수했어요.
- 부분 통합도 기존 선언 아래에 기록했어요. 삭제된 assertion의 의미가 남는 흡수 대상을 명시했으며, 기본 suite에 optional skipped case를 추가하지 않았어요.

## 실제 변경

1. `provider-definitions.test.ts`: 프로토콜 개수7 대신 정의목록의 유일성과 등록프로토콜 완전성을 확인해요. revision1·특정 checkedAt 날짜 대신 양의 정수 revision 및 유효 ISO 날짜를 검사해요. provider별 endpoint/env/auth/옵션은 외부 계약이므로 유지했어요.
2. `schema-baseline-reset.test.ts` BASE04: 구형 archive v2–7 거절을 흡수해 같은 source/target에서 무변경을 확인해요. `package-behavior-archive`의 동일 버전 진입 검사와 `source-editing`의 v2 진입 부분을 제거했어요. 의미상 위조된 edit history의 rollback 검사는 유지했어요.
3. `source-editing.test.ts`: plain generated 캐시 재확인은 기존 캐시 검사로, 수동 번역 sourceRevision 위조 거절은 whole-translation archive/fork 검사로 합쳤어요. 위조된 import 후 target이 비어 있는 assertion도 유지했어요.
4. `story-performance.test.ts`: 기본은 각 조건 한 번·warmup0으로4차원 기능 결과를 검증해요. `NR_BENCHMARK=1`일 때만 warmup1+sample5와 `story-performance.json`을 생성해요. 200,000자 원문 회수, 비활성 source 격리, catalog/lore/asset 증가의 기능 assertion은 항상 실행해요.
5. `prose.test.ts`: 폐기된 many-to-one 번역 segments/anchor fixture를 전체 text와 `data-block-anchor` 없음으로 바꿨어요. 원문 보존·렌더 무호출은 그대로예요.
6. `redesign-integration.test.ts`: 동작이 현재 archive인데 제목만 v11이었던 case를 current archive로 정정했어요. `story.test.ts`의 동일 상태에서 반복하는 attempts 빈배열 assertion 하나를 제거했어요.

## 검증

- 변경 관련 8파일: **58 PASS / 0 FAIL / 0 SKIP** (`output/testing-audit/unit-n-z-changed.json`).
- 선택 benchmark 경로: **1 PASS**, 4차원 모두 각 larger 조건5샘플·warmup1 생성 확인 (`output/testing-audit/benchmark/story-performance.json`).
- `npx tsc --noEmit` 통과. 변경 파일 Biome 적용/검사 통과.
- 이는 합성 임시 SQLite·mock/loopback 검사예요. live provider, 실제 성능 개선 또는 물리기기 증거로 해석하지 않아요. 전체 suite 최종 판정은 메인 작업의 통합 검증 결과를 따라요.

## 파일별 전수 결정

아래 각 파일의 계약 그룹 이유는 해당 KEEP case 전체에 적용해요. MERGE와 OPTIONAL은 case별로 흡수 대상·부분범위를 덧붙였어요. 최초 제목을 남겨 삭제/이름 변경까지 추적할 수 있어요.

### native-wire.test.ts

정적 선언 13개. 네 코덱 공통 role 순서·cache·서명 continuation의 wire 불변성. 개별 decoder 검사는 동일한 native prompt 경로를 대체하지 않음.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| preserves roles/order and sends current/history once across four codecs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| native cache is explicit for eligible Responses and Anthropic while compatible chat remains unsupported | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Responses %s cache mode retains authored points and selected 30m TTL | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Claude applies TTL %s to automatic caching and every authored point | KEEP | 위 계약 그룹의 고유 경계 유지 |
| %s reserves one automatic slot and never silently displaces a preferred point | KEEP | 위 계약 그룹의 고유 경계 유지 |
| %s cache OFF overrides authored required points with explicit diagnostics | KEEP | 위 계약 그룹의 고유 경계 유지 |
| unreviewed model IDs do not inherit explicit cache support | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects prefill and unsupported mid-system instead of flattening the prompt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| maps every non-leading system to user only on the wire for %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Responses two tool rounds preserve native prefix, original signed items, cache and call IDs; altered prompt rejected | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Chat native continuation retains provider reasoning and matches exact call IDs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Anthropic signed content and Vertex thought signatures survive native continuation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Anthropic accepts M2 state and memory roles without enabling a model call | KEEP | 위 계약 그룹의 고유 경계 유지 |

### network-policy.test.ts

정적 선언 7개. HTTP Host/Origin·세션·self-host 진입 조건과 로컬 허용 경계. provider outbound origin 정책과 별개.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| keeps local defaults and requires an explicit authenticated HTTPS origin for non-loopback binding | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects malformed public origin %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires a usable token and denies test routes before creating a database | KEEP | 위 계약 그룹의 고유 경계 유지 |
| canonicalizes the configured host/default port but grants no wildcard or subpath | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires same-origin mutations and denies foreign/null origins and cross-site reads | KEEP | 위 계약 그룹의 고유 경계 유지 |
| enforces policy on actual session/data routes and never trusts forwarded host or protocol | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains same-host local API calls without requiring an Origin header | KEEP | 위 계약 그룹의 고유 경계 유지 |

### new-story-model-defaults.test.ts

정적 선언 5개. 최근 선택·단일 적합 모델·비활성/미검토 제외의 신규 작품 기본값.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| a sole compatible model starts the main role without enabling an unrequested translation model | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a recent valid choice wins while absent or malformed history never picks arbitrarily among models | KEEP | 위 계약 그룹의 고유 경계 유지 |
| remembered disabled, missing-connection, changed-protocol and incompatible models are never suggested | KEEP | 위 계약 그룹의 고유 경계 유지 |
| official unknown model IDs are excluded while custom-endpoint and fixture model contracts remain usable | KEEP | 위 계약 그룹의 고유 경계 유지 |
| invalid history falls back only to the remaining compatible main model | KEEP | 위 계약 그룹의 고유 경계 유지 |

### openai-chat-protocol.test.ts

정적 선언 14개. Chat codec의 indexed delta·reasoning extension·DONE/finish 이중 종료·정확한 call ID 및 생성옵션.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| does not silently send or discard unreviewed native option %j | KEEP | 위 계약 그룹의 고유 경계 유지 |
| registered GPT Chat models retain Flex across exact tool continuation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| encodes the selected model and explicit options without assuming native structured output support | KEEP | 위 계약 그룹의 고유 경계 유지 |
| assembles interleaved indexed calls, retains reasoning extensions, and matches results by exact original IDs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires both finish_reason and DONE; missing usage remains unknown | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves observed text and zero usage through %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects %s rather than inventing a tool identity | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects changed IDs and names for an already indexed tool delta | KEEP | 위 계약 그룹의 고유 경계 유지 |
| binds continuation to original %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects wrong result names, reused call IDs, old-result mutation and cross-protocol continuation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| plain translation keeps tools and complete source across continuation without a JSON format | KEEP | 위 계약 그룹의 고유 경계 유지 |
| refusal classification does not receive translation output instructions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects foreign generation option %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects multiple choices, swapped response IDs, negative usage and data after finish | KEEP | 위 계약 그룹의 고유 경계 유지 |

### openai-protocol.test.ts

정적 선언 18개. Responses item/sequence·signed reasoning·완료/부분/거절·continuation 및 native cache/옵션.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| keeps editable model, explicit zero/reasoning, optional tool semantics and collision-free aliases | KEEP | 위 계약 그룹의 고유 경계 유지 |
| assembles tool argument deltas and replays full signed reasoning/items with exact original call IDs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| streamed message deltas and done snapshots do not duplicate visible text or lose annotations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires a terminal event and preserves observed text when the provider fails | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not parse or execute truncated arguments on an incomplete response | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects provider output item ID reuse independently from tool call IDs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| redacts opaque reasoning objects while retaining configured reasoning effort | KEEP | 위 계약 그룹의 고유 경계 유지 |
| distinguishes terminal %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects malformed tool %s without fallback | KEEP | 위 계약 그룹의 고유 경계 유지 |
| binds continuation to original %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects %s tool continuation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| translation requests complete prose without native JSON formatting | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps every selected Responses option alongside plain translation and signed continuation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| omits unselected reasoning and verbosity while rejecting unsupported Astra effort | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Responses cache %s reaches requests without a native prompt and preserves translation formatting | KEEP | 위 계약 그룹의 고유 경계 유지 |
| never mistakes content disguised as a reasoning setting for safe diagnostics | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects foreign generation option %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects swapped stream item IDs, response IDs, replayed sequence numbers and negative usage | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-authoring-controls.test.ts

정적 선언 13개. 작성 중 초안 보존·typed controls·가시성 조건·instruction AST/role·module option scope.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| accepts forward references and group metadata through the existing package validator | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unknown references and unsupported or oversized metadata before save | KEEP | 위 계약 그룹의 고유 경계 유지 |
| hides UI controls without changing values or prompt execution | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses prompt truth rules including null and evaluates conditions within a shared budget | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps every scalar option type and validates ranges and dangling instruction references | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains malformed display condition drafts and original data on failed validation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| renders groups, hides controls, and separates numeric and string select values | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves templates while ordinary text changes and removes them only in explicit text mode | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses existing syntax parser and validates template, condition and attachment-role references | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps exact template JSON when parsing or semantic validation fails | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves authored controls and defaults while a generic source policy is detached and reattached | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects dangling option references and ambiguous delimiters without overwriting authored drafts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps required-module values and explicit null while filtering removed scopes and controls | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior-archive.test.ts

정적 선언 4개. 상태/추첨/저널 무손실 복원과 위조·source ownership 원자적 거절. 버전 진입 거절만 BASE04로 합침.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| roundtrips clocks, frozen states, original text, draw seed, action and parser journals | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects forged definition hashes, state values, draws, payloads and source ownership atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps historical source hashes and ready dependency rows after a source edit | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unsupported archive v%i without compatibility mutation | MERGE | 선언 제거 → schema-baseline-reset BASE04; 같은 버전 선행거절/target 무변경 |

### package-behavior-evaluation.test.ts

정적 선언 13개. 순수 계산기 trigger/input/state/result 형식·before-state·결정론·공유 예산·getter 비실행.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| keeps omitted triggers as user actions and preserves explicitly disabled actions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects invalid trigger declarations %j | KEEP | 위 계약 그룹의 고유 경계 유지 |
| validates automatic input at registration and allows the empty-record default only for its matching schema | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires record inputs for model tools while retaining typed direct-user inputs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| produces the same state and compact result from the same supplied draw without ambient randomness | KEEP | 위 계약 그룹의 고유 경계 유지 |
| projects an explicit result from before state, input, draws, host context and validated next state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| evaluates every effect against the before state and hides nextState until result projection | KEEP | 위 계약 그룹의 고유 경계 유지 |
| checks eligibility before effects and result, and requires a boolean condition | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects a bad whole next state or result without mutating any supplied state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| enforces the exact serialized 8000-character result bound, including JSON escaping | KEEP | 위 계약 그룹의 고유 경계 유지 |
| shares one execution budget across condition, effects and result | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects getter-bearing host data before reading or copying it | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unsupported ambient operations in result expressions at registration | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior-integration.test.ts

정적 선언 10개. HTTP/store/source 완료를 연결한 preview 무쓰기·state CAS·source stale·branch/fork·명시 reset.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| BINT01 GET and preview do not initialize, draw, journal or alter source-bound state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| compatible latest content preserves state and dice; incompatible behavior requires explicit reset and roundtrips | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT02 user action freezes state and recorded draw into Run and composed provider input | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT03 malformed output and lost state CAS preserve source and fence the next authoritative run | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT04 source edits stale derived state; reset requires current hash and retains the journal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT09 replaying an earlier reset cannot acknowledge a later source edit or write metadata again | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT05 source branching restores post-source state and candidates restore original pre-source state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT06 branching after an ancestor edit cannot mark old derived state fresh or replay an old candidate | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT07 an ancestor edit during a run preserves completed prose but fails package output and blocks its successor | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BINT08 a selected-source chat fork preserves frozen state, draws and outputs, acts independently and roundtrips | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior-run-archive.test.ts

정적 선언 5개. 실행 중 임시 opportunity와 커밋 저널의 archive 소유권·취소·실패상태·entropy rollback.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| RBA01 automatic result projection is compact and committed journals roundtrip exactly | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RBA02 cancelled staged outcomes restore without committing state and replay the same opportunity | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RBA03 candidate and fork preserve recorded outcomes with their respective opportunity ownership | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RBA03b failed %s output restores only the states actually committed by the host | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RBA04 forged staged calculations and missing current tables reject atomically, restoring local entropy | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior-run.test.ts

정적 선언 16개. Run 전 자동행동/모델행동/사용자행동의 기회 재사용·원자성·의존성·취소·authoritative/annotation 차이.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| BRUN01 previews have no draws or writes; automatic actions are staged and frozen before the prompt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN02 one domain tool resolves effects and returns a compact result; repeated call IDs cannot reroll | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN03 cancellation leaves no applied state and a new request at the same source reuses the recorded opportunity | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN04 candidate uses the original dice and pre-automatic state without applying the automatic action twice | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN05 UI cannot invoke a model/automatic-only action even through the API | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN06 failed output parsing rolls all staged effects back while preserving the completed original source | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN07 source edits reject subsequent actions and fence stale completion without changing original prose | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN08 automatic when=false does not draw; dual-trigger action can be requested once later | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN09 state CAS rejects tool execution and rolls completion effects back | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN10 cancelling a request before its first tool does not expose or commit hidden state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN11 current-format archive and chat fork retain staged outcomes and independent successor state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN12 authoritative parser failure rolls dependent actions back across all packages | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN13 annotation parse failure preserves the shared action facts and does not fence the authoritative successor | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN14 a cached result cannot be reused before its cross-package dependencies have been applied | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN15 result-only user functions expose the persisted result without requiring a state effect | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BRUN16 the published hybrid fixture executes all three invocation paths with one local engine | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior-tools.test.ts

정적 선언 7개. host action tool schema/권한과 provider continuation·공유 tool 한도·evaluation 도구 공존.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| BT01 converts constraints recursively without exposing internal rules or state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT02 defaults to user only and exact attachment/role selection, excluding disabled persona | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT03 enforces the shared tool limit and rejects known unsupported models before attempts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT04 %s native preview carries the same selected input schema | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT05 executes exact frozen bindings, resumes with compact results and keeps prompt inputs stable | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT06 %s cannot fall through to read permissions or another provider call | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BT07 preset evaluation tools coexist with host actions on Responses and preserve continuation into the final artifact | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-behavior.test.ts

정적 선언 16개. SQLite 상태저장기 CAS·idempotency·draw journal·parser·호스트 transaction·fork. 순수 evaluator와 저장 계층이 다름.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| runs the published daily-state fixture with typed inventory, costs, stable dice and a new dated schedule | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rolls back an action whose individually bounded effects exceed the shared action budget | KEEP | 위 계약 그룹의 고유 경계 유지 |
| records host context but uses authoritative state/input/draws and replays the original host projection | KEEP | 위 계약 그룹의 고유 경계 유지 |
| skips only completely absent optional marker pairs and rejects partial or malformed optional output | KEEP | 위 계약 그룹의 고유 경계 유지 |
| evaluates all effects against the same before state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| resets explicitly with source/state CAS and records its before state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reads and previews defaults without rows or draws; preserves zero and false | KEEP | 위 계약 그룹의 고유 경계 유지 |
| replays identical payload, conflicts on changed input and rejects stale revisions/source | KEEP | 위 계약 그룹의 고유 경계 유지 |
| journals host seed and draw results and reuses them | KEEP | 위 계약 그룹의 고유 경계 유지 |
| checks conditions and validates whole next state before saving any effect | KEEP | 위 계약 그룹의 고유 경계 유지 |
| applies grouped output fields atomically with distinct provenance and late-result rejection | KEEP | 위 계약 그룹의 고유 경계 유지 |
| parses fixed delimiters, refuses extra markers, unsafe data and overlapping parser destinations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps state across content revisions and requires reset for changed behavior definitions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| joins host transactions so later host failure rolls state and journal back | KEEP | 위 계약 그룹의 고유 경계 유지 |
| fork copies isolated state and does not reuse the original idempotency namespace | KEEP | 위 계약 그룹의 고유 경계 유지 |
| validates nested state bounds and rejects prototype-bearing records without mutating input | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-context.test.ts

정적 선언 9개. source-time attachment/revision 및 역할별 context·prompt·display projection.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| leaves legacy requests and slots exactly unchanged for absent versus empty package fields | KEEP | 위 계약 그룹의 고유 경계 유지 |
| freezes role instructions and control values independently of later package edits | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rebuilds controls and frozen state for each prompt while preserving earlier results | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps catalog metadata separate from pinned references in main and translation inputs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| fails missing frozen revisions rather than returning partial context | KEEP | 위 계약 그룹의 고유 경계 유지 |
| provides main body and instructions both in simple input and composed host context | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps persona package lore out of main when disabled while allowing translation reads | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supplies translation-only context and package slots to an independent composed translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| projects displays from frozen definitions and rejects translation from another hash | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-features.test.ts

정적 선언 6개. 현재 module dependency graph·공유 모듈 dedupe·revision 충돌·chat/branch 상태 격리.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| shared requirements follow latest modules once while preserving captured runs and archives | KEEP | 위 계약 그룹의 고유 경계 유지 |
| dependency revisions, missing packages, non-package references and cycles are rejected | KEEP | 위 계약 그룹의 고유 경계 유지 |
| one required module keeps state separate across chats and branch source boundaries | KEEP | 위 계약 그룹의 고유 경계 유지 |
| common module controls freeze source rules and instructions equally for preview and accepted runs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| duplicate rules resolve once and conflicting package delimiters fail atomically for the current profile | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archive validation rejects forged common-module references and source declarations and rolls back restore | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-image-evaluation.test.ts

정적 선언 1개. evaluation artifact의 source/asset 검증과 notice 비저장.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| image evaluation artifact passes source and asset validation without treating notice as a caption | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-image-reader.test.ts

정적 선언 3개. 정확한 asset revision/hash·hidden 경계 이미지 누출 방지·번역/표시변환의 위치 미확정 처리.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| Reader resolves only the exact approved inline revision and bytes in this chat | KEEP | 위 계약 그룹의 고유 경계 유지 |
| an image on a block spanning main and hidden text never leaks onto the main segment | KEEP | 위 계약 그룹의 고유 경계 유지 |
| transformed prose suppresses unplaceable images and identifies an authored opening as source content | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-image-upload.test.ts

정적 선언 3개. 브라우저 File 업로드의 MIME/크기·읽기 중 취소·늦은 응답 무효화.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| profile and inline authoring share upload validation and preserve the requested use | KEEP | 위 계약 그룹의 고유 경계 유지 |
| cancel while reading a selected file prevents sending bytes to the server | KEEP | 위 계약 그룹의 고유 경계 유지 |
| an aborted late response and mismatched server MIME cannot become draft images | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-images.test.ts

정적 선언 7개. package image blob 저장/예약/재선택/fork/archive/reader catalog의 역할 및 버전 귀속.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| one reusable package supplies distinct bot, persona and module IDs without embedding image bytes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source reservation and delayed worker keep old names and removed images; explicit reselection uses CAS | KEEP | 위 계약 그룹의 고유 경계 유지 |
| blob decoding enforces allowed signatures, canonical encoding and the per-file size limit | KEEP | 위 계약 그룹의 고유 경계 유지 |
| bundle prepare validates every reference and rolls back inserted blobs on a later mismatch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| completed package images survive fork and archive, and forged or missing blob records roll back | KEEP | 위 계약 그룹의 고유 경계 유지 |
| one Reader page retains different revisions of the same package image ref and resolves exact hashes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Reader and detail expose each explicitly selected fixture module, chat and bot image version once | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-presentation.test.ts

정적 선언 5개. HTTP 소유권·frozen transform·최신 수동 번역·state card의 안전한 렌더.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| presentation API rejects a source owned by another chat and returns frozen display without changing raw | KEEP | 위 계약 그룹의 고유 경계 유지 |
| legacy source with no package returns unchanged text and no cards | KEEP | 위 계약 그룹의 고유 경계 유지 |
| hidden-story sources preserve their stored body and report disabled transforms | KEEP | 위 계약 그룹의 고유 경계 유지 |
| manual translation projection uses the latest verified revision and never changes its saved text | KEEP | 위 계약 그룹의 고유 경계 유지 |
| state cards render package text without executing HTML and label missing values explicitly | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-request.test.ts

정적 선언 11개. 사용자 행동의 제안→Run 소비 receipt CAS·중복·취소·source/ancestor stale·archive/fork.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| PREQUEST01 common data supports arbitrary state axes, language choices, lore, starts and images without a specialized bot model | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST02 proposal actions preserve source/state CAS, idempotency and the original draw with no model call | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST03 a user action request is consumed by exactly one accepted Run and an action retry cannot requeue it | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST04 invalid request output and failed Run admission roll back both state and reservation atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST05 source and ancestor edits invalidate proposals without rewriting captured Run or source originals | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST06 language and response size are package preferences and never overwrite state rules | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST07 replacement, cancellation and chat scopes cannot replay or steal a pending request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST08 archive/fork preserve common state and frozen inputs while pending proposals stay in their original chat | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST09 archive cannot erase or resurrect a %s receipt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST10 archive cannot replace a captured ancestor hash to revive a stale proposal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| PREQUEST11 completed consumption survives fork while branch and chat deletion remove only owned receipts | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-runtime.test.ts

정적 선언 7개. 공통 패키지 순수 실행의 namespace·역할·state view·ECMAScript 치환과 worker 제한.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| isolates role namespaces, keeps discoverable bodies out of pinned, and selects role instructions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects stale attachment and evaluates typed controls without rewriting instruction text | KEEP | 위 계약 그룹의 고유 경계 유지 |
| renders typed state as plain descriptors and distinguishes missing values from zero/false | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supports multiline captures without changing the supplied raw text and respects target | KEEP | 위 계약 그룹의 고유 경계 유지 |
| matches ECMAScript replacement semantics including empty unicode matches | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reports invalid regex and output expansion instead of swallowing them | KEEP | 위 계약 그룹의 고유 경계 유지 |
| terminates catastrophic backtracking and allows the next independent transform | KEEP | 위 계약 그룹의 고유 경계 유지 |

### package-start.test.ts

정적 선언 8개. authored/generated 도입문·초기행동 단회성·원자성·저자성·archive/fork·유실 응답 복구.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| starts validate typed choices and existing explicit actions; preview preserves exact author text and does not draw | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a module is used directly as bot; authored confirmation stores one immutable source and selected state with no calls or auxiliary jobs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| start settings CAS and commit failure roll back initial action, run, source, events and draws | KEEP | 위 계약 그룹의 고유 경계 유지 |
| generated opening uses the existing queue once; cancellation and retry never reapply its initial state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| authored source state and authorship survive archive and fork without a second initial action | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archive rejects forged authored markers and original prose and rolls back the import | KEEP | 위 계약 그룹의 고유 경계 유지 |
| authorship archive validation permits later source edits and a standalone fork without the origin chat | KEEP | 위 계약 그룹의 고유 경계 유지 |
| lost start response retries the saved command without another profile write or source | KEEP | 위 계약 그룹의 고유 경계 유지 |

### presentation.test.ts

정적 선언 5개. 사용자 표시 치환의 literal replacement·입출력 한도·worker timeout. package 치환의 ECMAScript 의미와 달라 유지.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S06 renders a derived plain text value and preserves original source including HTML | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S06 terminates catastrophic regex and can run a subsequent worker | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S06 enforces input, rule, pattern, replacement and expanded output limits | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S06 rejects invalid flags and patterns without leaking regex error details | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S06 advances zero-length Unicode matches without looping or splitting characters | KEEP | 위 계약 그룹의 고유 경계 유지 |

### product-auxiliary.test.ts

정적 선언 3개. 보조 runner/store bridge의 실제 합성 HTTP 도구 라운드·source-time context·prompt/취소.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| P07 P05 records actual selected transport attempts, paired batched calls and opaque source-time results | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P07 P13 disabled transport uses labeled local fixture; annotations stay separate and cancellation preserves source | KEEP | 위 계약 그룹의 고유 경계 유지 |
| custom translation prompt survives tool continuation and refusal retry without inheriting later edits | KEEP | 위 계약 그룹의 고유 경계 유지 |

### product.test.ts

정적 선언 15개. 제품 store/HTTP 원문·snapshot·후보 분기·archive/backup·세션·catalog·번역 연결의 종단 계약.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| P01 P02 P03 freezes exact content/profile revisions and the explicit persona scope | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P04 keeps manual model IDs and credential references separate from content and transport options | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P09 preserves sibling candidates from the exact original snapshot and each descendant ancestry with branch CAS | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 P06 P12 records fixture refusals and partials without source/jobs; duplicate attempt finishes cannot rewrite usage | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 import status includes %s-only data and a prior empty result never authorizes overwriting it | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 exports/restores source bytes, lineage and assets while disabling connections and unfinished work | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 rejects changed source/asset bytes and invalid ancestry atomically in an empty restore target | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 rejects unsupported schema %i without automatic migration or backup | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 reopens actual backup bytes as standalone SQLite while the source database remains owned | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P11 import status is uncached metadata and import rejects changes made after the read | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P07 P08 P12 explicit retry translates the whole scene with the current model and retains source-time references | KEEP | 위 계약 그룹의 고유 경계 유지 |
| invalid queued translation snapshot fails once before any provider request and leaves the HTTP server responsive | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 P06 P09 routes selected main through fetch, preserves source on refusal/partial and creates a sibling over HTTP | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P04 catalog refresh updates data only and retains prior data on HTTP failure without changing model routes or credentials | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P12 protects data, events and asset bytes with an HttpOnly session, rejects foreign origins and revokes logout cookies | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-authoring.test.ts

정적 선언 6개. TS authoring 1회 실행·detached AST·재사용·문자열 비재파싱·typed options.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| executes authoring once and reuses a data artifact with different runtime options | KEEP | 위 계약 그룹의 고유 경계 유지 |
| builds role, history, slot, cache and prefill contracts without reparsing data | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains existing conditions when a reusable block is wrapped again | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supports typed enum options and fixed string operations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| validates authoring output and returns a detached snapshot | KEEP | 위 계약 그룹의 고유 경계 유지 |
| applies ordinary JavaScript decisions only while creating the artifact | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-defaults.test.ts

정적 선언 2개. default main/translation이 native prompt compiler와 codec preview를 거치는 계약.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| %s keeps default main references and compiles explicit instructions through the same path | KEEP | 위 계약 그룹의 고유 경계 유지 |
| %s compiles default translation with exact source context/schema and no main history | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-execution.test.ts

정적 선언 5개. storySubmission opt-in·typed 조건·shared budget 및 authoring artifact.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| absence disables submission and an empty declaration enables it without provenance | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses resolved options and frozen runtime through the same bounded expression evaluator | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects undeclared options and arbitrary tool configuration | KEEP | 위 계약 그룹의 고유 경계 유지 |
| shares the compilation work budget instead of evaluating execution out of band | KEEP | 위 계약 그룹의 고유 경계 유지 |
| trusted authoring retains explicit execution configuration in the data artifact | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-language.test.ts

정적 선언 9개. 선택 문법 parser/printer의 AST 왕복·우선순위·소스위치·입력/중첩 한도.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| parses namespaced controls, slots and conditions with precedence | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supports %s without JS | KEEP | 위 계약 그룹의 고유 경계 유지 |
| handles quoted delimiters, escapes and fixed functions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects malformed or unauthorized input: %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reports source positions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| roundtrips every native expression and template property | KEEP | 위 계약 그룹의 고유 경계 유지 |
| never reparses values, slots or chat input | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not form delimiters across printed node boundaries | KEEP | 위 계약 그룹의 고유 경계 유지 |
| enforces source, AST depth and node bounds | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-runtime.test.ts

정적 선언 16개. 표현식 연산별 타입·컬렉션·날짜·lazy branch·lexical scope·누적 예산.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| builds immutable lists and shallow records through AST, optional syntax and TS | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects list and record type, index and size violations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| shares cumulative work and aggregate result limits across a batch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains legacy scalar formatting, comparisons and null control behavior | KEEP | 위 계약 그룹의 고유 경계 유지 |
| evaluates strict numeric %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects coercion, nonfinite output and invalid arithmetic | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses null-only coalescing and lazy typed/logical branches | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reads structured paths and returns detached values without prototype access | KEEP | 위 계약 그룹의 고유 경계 유지 |
| maps and filters with lexical values and explicit indices | KEEP | 위 계약 그룹의 고유 경계 유지 |
| provides bounded aggregate, collection and string operations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| formats and advances only explicitly supplied strict UTC dates | KEEP | 위 계약 그룹의 고유 경계 유지 |
| stops oversized ranges, JSON expansion, replacement expansion and repeated work | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses each/let lexical scope and preserves data that looks like source | KEEP | 위 계약 그룹의 고유 경계 유지 |
| roundtrips dynamic literal, scoped template and expression iteration syntax | KEEP | 위 계약 그룹의 고유 경계 유지 |
| builds dynamic structures with TS without running author callbacks per request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| shares final output bounds across message blocks | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prompt-settings.test.ts

정적 선언 12개. HTTP prompt workspace/preset/CAS·복사 의미·Run/job 동결·preview 무호출·status 복구.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| rejects retired fixed creative controls and APIs while preserving explicit persona scope | KEEP | 위 계약 그룹의 고유 경계 유지 |
| saves exact whitespace, empty text and version history, rejecting stale writes and invalid shapes without generation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| one workspace supplies both chats; stale saves and obsolete chat prompt controls are rejected | KEEP | 위 계약 그룹의 고유 경계 유지 |
| applying a preset copies its exact program and values; later edits and deletion do not change the workspace | KEEP | 위 계약 그룹의 고유 경계 유지 |
| option presets copy only values into the current role and never retarget a saved prompt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| new scenes capture current working copies while prior source and candidate keep their frozen prompt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| translation reservations copy the current translation and a later retry keeps earlier jobs intact | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archive restores copied prompts and rejects forged frozen role or compiled prompt content atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| an unavailable optional translation connection does not block a main snapshot | KEEP | 위 계약 그룹의 고유 경계 유지 |
| default translation preview with stored source=%s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| freezes the new model, retains the original run and failed job, and rejects duplicate or superseded recovery | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rolls back validation failures and rejects changed source or active older workers | KEEP | 위 계약 그룹의 고유 경계 유지 |

### prose.test.ts

정적 선언 9개. Markdown/ruby/URL escaping과 SourceReader 선택·원문 불변·무호출. 폐기된 번역 anchor 기대를 text 계약으로 수정.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| renders headings, emphasis, quotes, lists and line breaks with semantic elements | KEEP | 위 계약 그룹의 고유 경계 유지 |
| escapes raw HTML, blocks executable links and never requests Markdown images | KEEP | 위 계약 그룹의 고유 경계 유지 |
| allows only attribute-free ruby and keeps other HTML literal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps fenced code, protected placeholders, template syntax and machine identifiers literal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unsafe and ambiguous URL schemes without accepting control-character obfuscation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| renders a long source without interpreting unsupported syntax as HTML | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reader defaults to Korean, preserves source identity and many-to-one translation anchors without commands | KEEP | 구형 anchor 기대 제거; whole translation text·원문 불변·명령0 유지 |
| reader shows only the latest matching translation and never a version selector | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reader without a current translation renders the original even when translation is preferred | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-cache-usage.test.ts

정적 선언 1개. 실제 usage의 0/null/누락을 구분하며 공급자별 cache 필드만 해석.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| cache usage distinguishes a confirmed read, zero, and missing data without inferring savings | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-connection-test.test.ts

정적 선언 11개. 단회 진단의 전송 전 영속화·idempotency·권한 재검사·restart/cancel·최소 옵션·비밀 제거.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| persists before send, deduplicates pending and finished requests, and isolates diagnostics from story archives | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects stale or disabled models, disabled connections, unapproved origins, and user-supplied prompt fields | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rechecks the saved model after asynchronous credential resolution and never sends a changed model | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains safe %s results and never retries | KEEP | 위 계약 그룹의 고유 경계 유지 |
| bounds returned and persisted text to 2000 characters | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses a fixed 25 second deadline and returns TIMEOUT without retry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| startup interrupts previously admitted work and repeated key returns it without replay | KEEP | 위 계약 그룹의 고유 경계 유지 |
| server shutdown aborts an in-flight request and retains interrupted state on restart | KEEP | 위 계약 그룹의 고유 경계 유지 |
| both diagnostic endpoints require the existing access session | KEEP | 위 계약 그룹의 고유 경계 유지 |
| checks Codex authority after thread setup: %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| all registered models use valid minimum test effort, no tools, cache disabled, and the selected service tier | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-definitions.test.ts

정적 선언 5개. 등록 프로토콜 완전성/유일성·유효 provenance·endpoint/env/options/불변 메타데이터. 현 개수/날짜 고정 제거.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| covers every registered protocol once without installing new protocols | KEEP | 고정7/revision1/날짜 대신 완전성·유일성·양의 revision·유효 날짜 계약 |
| retains existing endpoint/environment defaults and validates every populated endpoint | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps adapter provenance separate from unknown model capabilities and prices | KEEP | 고정7/revision1/날짜 대신 완전성·유일성·양의 revision·유효 날짜 계약 |
| does not advertise provider-specific model options on incompatible adapters | KEEP | 위 계약 그룹의 고유 경계 유지 |
| callers cannot mutate shared definitions or their nested capability/option metadata | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-endpoint-status.test.ts

정적 선언 7개. 진단 HTTP endpoint의 read-only 분류와 인증; 실행 권한을 부여하지 않는 계약.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| official endpoints are approved without environment configuration or saving the draft | KEEP | 위 계약 그룹의 고유 경계 유지 |
| custom origins distinguish configured and needs-approval without mutating saved settings | KEEP | 위 계약 그룹의 고유 경계 유지 |
| malformed and protocol-mismatched endpoints cannot report approval even for configured origins | KEEP | 위 계약 그룹의 고유 경계 유지 |
| unsupported protocols and invalid request fields return 400 | KEEP | 위 계약 그룹의 고유 경계 유지 |
| the local Codex endpoint does not require an HTTP origin | KEEP | 위 계약 그룹의 고유 경계 유지 |
| saved official connections report originApproved with an empty configured origin list | KEEP | 위 계약 그룹의 고유 경계 유지 |
| endpoint inspection requires a session when application authentication is enabled | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-fetch.test.ts

정적 선언 4개. 실제 Node/Undici 300초 경계를 가상 시간으로 넘는 회귀와 native socket 취소. 단순 mock HTTP와 다름.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| native Node fetch crosses the actual Undici 300s %s boundary using virtual time | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $connection.protocol $phase $mode closes the native local request without retry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $connection.protocol exposes only allowlisted cause $code | KEEP | 위 계약 그룹의 고유 경계 유지 |
| unknown, cyclic and throwing diagnostic properties never disclose arbitrary error data | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-http.test.ts

정적 선언 13개. native transport별 옵션·credential/admission 순서·헤더·HTTP/EOF/abort·무재시도.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| $protocol rejects unreviewed official models before reading credentials | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol sends the selected generation options with plain text translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Vercel does not receive native OpenAI options inferred from its routed model name | KEEP | 위 계약 그룹의 고유 경계 유지 |
| official GPT Chat sends Flex once and preserves HTTP %s without changing tier | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Fable forced tool selection is refused before credential resolution and HTTP | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol validates credentials and journals before its single exact wire request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $variant.protocol HTTP $status never retries or exposes provider error bodies | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $variant.protocol $mode interrupts a pending read and preserves observed usage | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol reports EOF without a provider terminal and retains partial evidence | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol rejects a successful HTTP response without a body | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol validates origin and credentials before journaling or fetching | KEEP | 위 계약 그룹의 고유 경계 유지 |
| $protocol honors denied admission and caller cancellation before fetch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a local compatible endpoint may omit authentication without reading environment credentials | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-management.test.ts

정적 선언 6개. prepare 무쓰기·단일 settings row CAS·catalog authority·metadata/impact·archive 권한 제거.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| prepare is read only and create/update enforce the same CAS contract | KEEP | 위 계약 그룹의 고유 경계 유지 |
| catalog/error retention uses credential authority and old connection execution is revoked | KEEP | 위 계약 그룹의 고유 경계 유지 |
| model metadata is server sourced and disabling blocks new selection while preserving a captured run | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archive roundtrip retains management metadata, strips authority, and rejects forged metadata atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| readiness reveals only presence and approved origin without authenticating | KEEP | 위 계약 그룹의 고유 경계 유지 |
| impact counts current profile model IDs after settings edits and exposes metadata only | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-origin-policy.test.ts

정적 선언 6개. 공식 root/설정 origin/loopback/Codex 경계의 순수 outbound 승인 정책.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| allows the validated %s official root without operator configuration | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects misleading or credential-bearing %s addresses | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires explicit origins for compatible remote APIs and loopback fixtures | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not let configured origins bypass endpoint or secret-in-URL validation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves the supported global Vertex contract and rejects unimplemented regions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| leaves local Codex authorization with the dedicated connection contract | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-registration-agent.test.ts · provider-registration-routes.test.ts · provider-registration-store.test.ts

등록 보조 기능 제거(2026-09-09)와 함께 세 파일을 삭제했어요. 대신 `provider-rejection.test.ts`가 4xx 거절의 필드 매핑을, `provider-http.test.ts`·`vertex-transport.test.ts`가 표에 없는 모델의 전송과 거절 필드 추출을 확인해요.

### provider-selection.test.ts

정적 선언 5개. 현재 ID 선택 적합성·disabled 유지/신규 거절·protocol 재검토·draft 무쓰기·snapshot 분리.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| disabled models retain assigned IDs but block new assignments and new snapshots while completed runs stay immutable | KEEP | 위 계약 그룹의 고유 경계 유지 |
| ID-based selections follow current connections while protocol changes require a model review before execution | KEEP | 위 계약 그룹의 고유 경계 유지 |
| state and memory retain selected IDs while rejecting a disabled model newly assigned to another role | KEEP | 위 계약 그룹의 고유 경계 유지 |
| model draft validation uses explicit matching unsaved connection without any DB writes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| model snapshots are detached from current settings and selection checks use the latest connection ID | KEEP | 위 계약 그룹의 고유 경계 유지 |

### provider-settings.test.ts

정적 선언 15개. 설정 API 입력/옵션·최신 연결을 쓰는 새 Run·catalog 페이지·archive capability 검증.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| saves supported protocols and enforces endpoints, general credential names and Vertex-only tiers | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves absent native options, explicit false and protocol-specific generation settings | KEEP | 위 계약 그룹의 고유 경계 유지 |
| stores an optional host input limit separately from provider generation options | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects cross-provider options and inconsistent thinking budgets without storing a model | KEEP | 위 계약 그룹의 고유 경계 유지 |
| updates a single settings row with CAS and removes model and connection revision endpoints | KEEP | 위 계약 그룹의 고유 경계 유지 |
| an existing chat uses current model and connection settings on its next Run while its in-flight and completed snapshot stay frozen | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archives a model against its saved capability protocol even after its current connection protocol changes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reads native catalogs using their exact base path and auth headers while retaining unknown capabilities and pricing | KEEP | 위 계약 그룹의 고유 경계 유지 |
| collects bounded Anthropic pages in order without exposing partial or malformed pagination | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects missing credentials, disabled connections and unapproved origins before any catalog request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains old catalog data for HTTP, schema, encoding and size errors | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not overwrite newer connection settings when an older catalog response arrives | KEEP | 위 계약 그룹의 고유 경계 유지 |
| restores current native settings independently from frozen run settings while removing credentials and disabling connections | KEEP | 위 계약 그룹의 고유 경계 유지 |
| validates archived current provider settings against their connection protocol and rolls back forged archives | KEEP | 위 계약 그룹의 고유 경계 유지 |
| saves Fable, cache modes and pending IDs while rejecting invalid combinations and missing archive capability revisions | KEEP | 위 계약 그룹의 고유 경계 유지 |

### reader-diagnostics.test.ts

정적 선언 1개. 목록 payload 축소와 단건 원본 진단·unknown cost 보존.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| diagnostic lists omit payloads and single-attempt detail preserves stored payload and unknown cost | KEEP | 위 계약 그룹의 고유 경계 유지 |

### reader.test.ts

정적 선언 11개. 페이지/cursor/delta·원문 변경·navigation 메타데이터·전역/페이지별 activity 격리.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| new chats leave automatic status off until explicitly enabled | KEEP | 위 계약 그룹의 고유 경계 유지 |
| 100-source HTTP reader pages retain order while execution snapshot and full detail stay intact | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source cursors and supplied known IDs cannot cross branch or chat boundaries | KEEP | 위 계약 그룹의 고유 경계 유지 |
| delta includes current edited source and matching latest translation only, with unchanged assets omitted | KEEP | 위 계약 그룹의 고유 경계 유지 |
| navigation labels use bounded requests and never authored, generated, or edited source bodies | KEEP | 위 계약 그룹의 고유 경계 유지 |
| new source joins an incomplete last page on delta and another chat does not dirty it | KEEP | 위 계약 그룹의 고유 경계 유지 |
| HTTP reader rejects invalid or future cursors | KEEP | 위 계약 그룹의 고유 경계 유지 |
| restoring any source retains its whole fixed page, including all of a short chat | KEEP | 위 계약 그룹의 고유 경계 유지 |
| activity remains page independent and retains active work beyond the terminal limit | KEEP | 위 계약 그룹의 고유 경계 유지 |
| activity completion time ignores subsequent usage updates and retries restart queue time | KEEP | 위 계약 그룹의 고유 경계 유지 |
| response activity retains older page work without expanding global activity or other pages | KEEP | 위 계약 그룹의 고유 경계 유지 |

### redesign-integration.test.ts

정적 선언 7개. package envelope·role attachment·options·archive/bot folder와 크기 제한의 제품 통합.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| package persistence normalizes envelope fields, keeps internal data and old run source-time package after editing | KEEP | 위 계약 그룹의 고유 경계 유지 |
| cross-role attachment of one package namespaces resources while invalid refs and mixed primary roles reject atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| changing attachments drops only inherited obsolete package control keys and rejects explicit stale values | KEEP | 위 계약 그룹의 고유 경계 유지 |
| prompt combinations reject nonprimitive values and controls from a different prompt | KEEP | 위 계약 그룹의 고유 경계 유지 |
| v11 archive roundtrips package refs, large internal lore, empty body, option combinations and bot folder ownership | KEEP | current archive로 제목 수정; 본문 계약 유지 |
| malformed package import and forged archive package body roll back all writes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| package body and description limits survive archive while legacy limits stay unchanged | KEEP | 위 계약 그룹의 고유 경계 유지 |

### request-validation.test.ts

정적 선언 4개. 공유 HttpError identity·record/unknown field·공백·integer 경계. helper의400검사 포함.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| preserves existing imports and the HttpError identity used by HTTP error handling | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects non-record payloads and unknown fields without copying or dropping input | KEEP | 위 계약 그룹의 고유 경계 유지 |
| preserves authored whitespace and explicit empty values while enforcing character limits | KEEP | 위 계약 그룹의 고유 경계 유지 |
| accepts inclusive integer boundaries without coercion, truncation or unsafe revisions | KEEP | 위 계약 그룹의 고유 경계 유지 |

### run-retry.test.ts

정적 선언 2개. 현재 설정으로 새 branch 재실행·원본 보존·idempotency 및 admission rollback.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| successful request repeats with current settings in a new branch and idempotency reuses the original retry snapshot | KEEP | 위 계약 그룹의 고유 경계 유지 |
| active requests cannot repeat and validation failure rolls back both new branch and run | KEEP | 위 계약 그룹의 고유 경계 유지 |

### schema-baseline-reset.test.ts

정적 선언 10개. 현재 schema/아카이브 진입 계약과 reset CLI 고정대상·owner·symlink/hardlink 안전성.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| BASE01 a fresh database creates the complete schema 14 and a current database reopens directly | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BASE02 nonempty unversioned databases are rejected without inferring an old schema | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BASE03 fresh initialization rolls back as one transaction and releases its owner after a failure | KEEP | 위 계약 그룹의 고유 경계 유지 |
| BASE04 only schema 14 archives restore, and a rejected version leaves both databases untouched | MERGE | 기존 검사 유지 + package-behavior/archive·source-editing v2–7 진입 거절 흡수 |
| RESET01 the CLI removes only the fixed development DB family and known pre-upgrade copies | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RESET02 a running owner blocks reset before any development file is deleted | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RESET03 an active owner of an old pre-upgrade copy also blocks the entire reset | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RESET04 redirected .local directories are rejected before following their files | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RESET05 hard-linked database targets and path override arguments are refused | KEEP | 위 계약 그룹의 고유 경계 유지 |
| RESET06 an absent default directory is a no-op without creating a database | KEEP | 위 계약 그룹의 고유 경계 유지 |

### server.test.ts

정적 선언 7개. 실제 HTTP queue/event/worker/source commit·owner·restart crash recovery. store 단위와 다른 경계.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| F02 fixes snapshots, rejects stale revisions, and deduplicates a logical command | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F03 replays durable event IDs and keeps errors out of source; F04 enforces call budget and cancellation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F05 rolls back source/run/job reservations together and honors snapshotted disabled jobs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F05 keeps delayed jobs on original revisions and retries result transactions without duplicate effects | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F01 refuses another owner before recovery; F06 disables controls and prevents cross-origin writes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F04 reads scoped SQLite references through research calls and applies package main instructions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| F03 F05 restarts after source commit before worker wake, without regenerating source | KEEP | 위 계약 그룹의 고유 경계 유지 |

### snapshot-archive.test.ts

정적 선언 6개. logical history/prompt/cache trace의 fork remap·candidate original branch·위조 거절.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| ordinary Runs retain archived logical-history and compiled-prompt validation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| ordinary fork remapping preserves text and hashes while rebinding history, summary, cache and trace identities | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source policies stay frozen after detaching a package and archive validation rejects deleted or forged policies | KEEP | 위 계약 그룹의 고유 경계 유지 |
| candidate archive keeps the original branch-dependent compilation and a fork remains independently restorable | KEEP | 위 계약 그룹의 고유 경계 유지 |
| candidate archive rejects forged execution, substituted origins and altered frozen input atomically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| HTTP candidate preserves source-time branch execution from a %s context and roundtrips | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-context.test.ts

정적 선언 2개. 원문 구간 제외를 main history/search/read와 기억 knowledge 검증에 동일 적용.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| excluded source ranges remain out of history, search and reads while current user input and source identity stay intact | KEEP | 위 계약 그룹의 고유 경계 유지 |
| memory knowledge comes from the source-time policy and cannot grant actor knowledge or change the extracted kind | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-editing.test.ts

정적 선언 12개. 최신 원문/수동번역 CAS·새 번역 snapshot·이전 성공 표시·늦은 worker·archive/fork 불변.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| new translation freezes the current prompt and retry policy while pending work keeps its reservation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| explicit retry creates a new current-policy job and preserves failed candidate plus last successful translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| archive and fork preserve whole translation text and reject changed source identity | KEEP | 수동 번역 sourceRevision 위조 및 target rollback assertion도 흡수 |
| completion never reserves translation; manual save and demand remain free | KEEP | 위 계약 그룹의 고유 경계 유지 |
| CAS manual edit fences a late owned job while preserving prior execution evidence | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source editing invalidates jobs and preserves both old and new snapshot history | KEEP | 위 계약 그룹의 고유 경계 유지 |
| versioned source restore and fork preserve edit history, manual translation and independent copies | KEEP | 위 계약 그룹의 고유 경계 유지 |
| v2 archive rejects and invalid edit history rolls back | MERGE | v2 진입만 BASE04; invalid edit history rollback은 이름을 바꿔 이 case에 유지 |
| valid generated translation caches with zero further attempts; identity corruption creates a clean reservation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| edited source exposes hidden slot CAS and rejects a stale translation editor hash | KEEP | 위 계약 그룹의 고유 경계 유지 |
| plain generated translation remains cached and malformed manual archives are rejected | MERGE | 선언 제거 → valid generated translation caches 및 archive and fork preserve whole translation text |
| unsupported v2 database refuses startup without rewriting translation reservations | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-history-storage.test.ts

정적 선언 3개. history SQL 조회의 exact text/hash·최신 edit·source policy·branch/cycle·identity 검증.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| history preserves exact original/latest edit, source-time policy, branch order and immutable run snapshots | KEEP | 위 계약 그룹의 고유 경계 유지 |
| history still rejects missing ancestors and ancestry cycles | KEEP | 위 계약 그룹의 고유 경계 유지 |
| history preserves source identity validation for %s corruption | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-segments-integration.test.ts

정적 선언 3개. hidden memory와 번역 context의 fork ID/range remap·제외 로어/기억·archive.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| completed hidden-memory fork remaps segment source identities and compiled memory slot provenance | KEEP | 위 계약 그룹의 고유 경계 유지 |
| completed hidden translation fork regenerates mapped context segment ranges and roundtrips archive | KEEP | 위 계약 그룹의 고유 경계 유지 |
| excluded hidden history stays out of memory slots/read/search and source edits retire old knowledge | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-segments-reader.test.ts

정적 선언 4개. 원문 구간 renderer HTML 안전성·actor knowledge·source identity·원문 오류 표시.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| segment reader escapes HTML and never executes raw portrait markup or grants actor knowledge | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reader refuses a translation attached to a stale source %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source reader preserves original segment order, scene labels and source identity | KEEP | 위 계약 그룹의 고유 경계 유지 |
| malformed original markers remain visible with diagnostics and an invalid policy falls back to original prose | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-segments.test.ts

정적 선언 11개. 원문 literal parser의 UTF16 range·fence·exclude/retention·typed frozen policy·공유선언 충돌.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| arbitrary literal delimiters partition exact CRLF and UTF-16 ranges without granting knowledge | KEEP | 위 계약 그룹의 고유 경계 유지 |
| unattached or disabled policies leave both current and retired marker syntax uninterpreted | KEEP | 위 계약 그룹의 고유 경계 유지 |
| literal regex punctuation and inline boundaries retain surrounding prose | KEEP | 위 계약 그룹의 고유 경계 유지 |
| fenced examples remain ordinary source and longer matching fences close the example | KEEP | 위 계약 그룹의 고유 경계 유지 |
| %s blocks stay readable but an exclusion cannot silently leak them | KEEP | 위 계약 그룹의 고유 경계 유지 |
| excluded ranges identify the original source and never replace its hash with a view hash | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retention uses explicit logical-message indices and the configured boundary | KEEP | 위 계약 그룹의 고유 경계 유지 |
| policy validation rejects ambiguous markers, unsafe fields and unbounded inputs without running getters | KEEP | 위 계약 그룹의 고유 경계 유지 |
| conditions resolve only selected controls to frozen booleans and cannot modify package data | KEEP | 위 계약 그룹의 고유 경계 유지 |
| package freezing uses exact revision and attachment option key, with persona opt-out | KEEP | 위 계약 그룹의 고유 경계 유지 |
| equivalent shared declarations execute once while conflicting package declarations are rejected | KEEP | 위 계약 그룹의 고유 경계 유지 |

### source-translation.test.ts

정적 선언 5개. whole-source compiler의 문법 보존·source-time knowledge·typed prompt·tool continuation.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| scripted whole-source output preserves exact structural source text and knowledge metadata without protection tokens | KEEP | 위 계약 그룹의 고유 경계 유지 |
| compiles exactly the frozen translation revision, ordered roles/cache and one current task | KEEP | 위 계약 그룹의 고유 경계 유지 |
| default and explicit empty instructions use the same program compiler | KEEP | 위 계약 그룹의 고유 경계 유지 |
| invalid frozen program values fail with their prompt code before an attempt is sent | KEEP | 위 계약 그룹의 고유 경계 유지 |
| actual loopback requests preserve composed messages across source-time tools and freeze later mutations | KEEP | 위 계약 그룹의 고유 경계 유지 |

### state.test.ts

정적 선언 14개. 숫자 이벤트/문자 설정·원문 evidence·중복 차감·타입·범위·prototype 방어의 순수 reducer.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S01 versioned event mapping calculates 10 minus 3 as 7 and preserves all inputs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 annotation results are never canonical; continuity is distinct from authoritative | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 exact UTF16 source spans accept whole astral characters and reject invented text and split pairs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 nonnumeric sets enforce field allowlist, enums, boolean type, text bounds and forbid numeric assignments | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 unknown keys and provider-invented deltas cannot override module rules | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 source revision/hash mismatch or corrupted source fails without rewriting previous values | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 changed rule revision invalidates proposals; duplicate operation IDs reject retries inside one proposal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 S03 the same numeric evidence cannot charge twice under different operation IDs or aliased event names | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 two disjoint same-event purchases are legitimate and each deducts exactly once | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 overlapping evidence for the same numeric field fails even with a different rule delta, while different fields may share evidence | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 out-of-range or overflowing reduction rejects all effects instead of clamping or partial mutation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 invalid modules reject nonfinite numbers, invalid rules, bounds and undeclared metadata | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 dangerous prototype names, inherited definitions, symbols and getters fail closed | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 pre-state is complete and typed; absent proposals fail while empty valid changes preserve state | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-archive.test.ts

정적 선언 8개. state 재계산·memory/canon graph·retcon·nested authority 제거·selected ancestry fork.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S03 R03 completed state is recomputed; immutable snapshots and historical edited sources remain valid | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 R03 poisoned state, config, source identity, immutable dependency and memory evidence reject with rollback | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 retcon ownership, ancestry and cycles reject without altering authored text | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 restore normalization disables nested connections, strips provider continuation and never queues uncertain jobs | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 restored model snapshots remain independent of later settings and reject mismatched connection identities | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 R03 fork remaps source/state/memory identities and dependency keys, preserves prose, and copies no attempts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| R03 fork excludes sibling retcons and preserves only selected ancestry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 fork omits unresolved artifacts and reports exclusions while retaining the original source | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-context-compaction.test.ts

정적 선언 5개. state/memory 보조의 context 요약·원문 evidence 검증·예산/기존 checkpoint 재사용.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| long state ancestry is summarized through memory attempts before an exact current-source state proposal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| memory extraction validates compacted-ancestor quotes and hashes against the full original ancestry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a current source exceeding the auxiliary limit is preserved whole and fails with zero provider transmissions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a main checkpoint is reused and story.read can retrieve a compacted ancestor while other-branch IDs remain denied | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a smaller auxiliary budget requires its own summary even when the main checkpoint already fits a larger window | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-context.test.ts

정적 선언 6개. memory/story read/search의 실제 byte budget·provenance 분리·pagination·scope.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| memory.read limit1 never injects the 10000-character evidence quote through provenance | KEEP | 위 계약 그룹의 고유 경계 유지 |
| authored declaration metadata does not repeat the entire canonical text | KEEP | 위 계약 그룹의 고유 경계 유지 |
| large provenance is explicitly paginated and every exact source coordinate remains recoverable | KEEP | 위 계약 그룹의 고유 경계 유지 |
| memory.search honors the actual result byte budget and continuation retrieves every matching item | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Unicode and JSON-escaped source/memory bodies use byte-aware text continuation without data loss | KEEP | 위 계약 그룹의 고유 경계 유지 |
| individual memory reads apply the same current ancestry and chat validation as search counts | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-memory.test.ts

정적 선언 9개. SQLite 기억 추출/정사/retcon·receipt freshness·checkpoint holes·branch 격리.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| validates the entire extraction before inserts, rejects forged/cross-chat evidence and preserves atomic rollback | KEEP | 위 계약 그룹의 고유 경계 유지 |
| extractor cannot create author canon, choose IDs or anchor at another revision | KEEP | 위 계약 그룹의 고유 경계 유지 |
| shared-ancestor retcon changes only the selected descendant branch and preserves stored earlier snapshots | KEEP | 위 계약 그룹의 고유 경계 유지 |
| pre-transcript authored declaration uses null anchor and GET helpers never write | KEEP | 위 계약 그룹의 고유 경계 유지 |
| ancestral retcon invalidates descendant extraction and receipts; rebuilding preserves old rows and stored snapshots | KEEP | 위 계약 그룹의 고유 경계 유지 |
| read-only freshness excludes stale semantic data even before status refresh and receipt replacement remains possible | KEEP | 위 계약 그룹의 고유 경계 유지 |
| re-extraction replaces a stale receipt while retaining previous artifacts outside current visibility | KEEP | 위 계약 그룹의 고유 경계 유지 |
| completed no-facts receipt advances progress but pending work cannot skip a hole | KEEP | 위 계약 그룹의 고유 경계 유지 |
| source hash changes rewind progress and a completed receipt never leaks into sibling scope | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-performance.test.ts

정적 선언 1개. 4차원 증가에서 active input 불변과 200k 원문 회수는 기본 기능 검사; 반복 시간 측정만 선택.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S07 independent archive/lore/manuscript/asset growth measures actual SQLite active context; S05 200k source roundtrips | KEEP + OPTIONAL | 기능 항상 실행; threshold 없는 반복 측정/아티팩트만 NR_BENCHMARK=1 |

### story-runner.test.ts

정적 선언 9개. state/memory provider 입력·검증·권한·중복 도구·불확실 요청 무재생·mock 출처.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S01 actual provider receives original source, rules and previous state; tool results and opaque continuation stay correctly scoped | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 provider no-facts empty proposal is preserved without inventing numeric changes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 malformed terminal JSON and invalid evidence preserve usage with no automatic retry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 duplicate calls are rejected before reads; connection revocation and budget block the next fetch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 refused provider is terminal and cross-chat read cannot expand scope | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 repeated tool IDs across turns are rejected and uncertain partial output is never replayed | KEEP | 위 계약 그룹의 고유 경계 유지 |
| R03 memory provider returns validated source-bound entries and cannot forge author canon or wrong scope | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 R03 mock is explicit: numeric events need literal markers and memory is extractive with safe UTF16 evidence | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 stale source and pre-aborted jobs cannot reach provider or leak abort reason | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story-state-dependencies.test.ts

정적 선언 9개. 현재 상태 설정과 과거 snapshot·continuity hydration·초기 활성점/reset·복원/fork.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| historical story model snapshots restore after current settings release the deleted model | KEEP | 위 계약 그룹의 고유 경계 유지 |
| current story settings replace one row while completed jobs and Run snapshots survive archive and fork | KEEP | 위 계약 그룹의 고유 경계 유지 |
| fork omits a current activation outside its ancestry without reviving old settings or reusing snapshot revisions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| model IDs use latest settings for new reservations and rebuilds while existing snapshots stay fixed | KEEP | 위 계약 그룹의 고유 경계 유지 |
| continuity permits the next source but defers its state claim until the preceding state is ready; duplicate claims and completions cannot double-apply | KEEP | 위 계약 그룹의 고유 경계 유지 |
| continuity dependency hydration survives export/import and selected-ancestry fork while original Run snapshots remain unchanged | KEEP | 위 계약 그룹의 고유 경계 유지 |
| explicit rebuild of an edited first activation source rebases initial state before that source and releases a waiting Run | KEEP | 위 계약 그룹의 고유 경계 유지 |
| activation at the second source rebuilds from its parent baseline and rejects rebuilding pre-activation history | KEEP | 위 계약 그룹의 고유 경계 유지 |
| explicit state reset pins a new module revision to the selected branch and cancels old-rule waiting without rewriting history | KEEP | 위 계약 그룹의 고유 경계 유지 |

### story.test.ts

정적 선언 12개. state→다음 main·waiting/retry·원자적 예약·memory holes·retcon·HTTP 조정.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| S01 state 10→7 is applied once and is present in the next real main input | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S02 a delayed authoritative state parks generation while original remains readable; cancelled wait never resumes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S02 failed state keeps waiting until explicit retry succeeds, then freezes the resumed dependency | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 late source-edit result is stale and prior source state remains an immutable historical artifact | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S03 restart retains queued work, interrupts uncertain running work, and does not replay it automatically | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S05 out-of-order memory completion preserves holes and main tools recover actual compacted historical text | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S04 stored author canon retcon is branch scoped and does not rewrite earlier Run snapshots | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S04 persisted character belief retains actor and evidence without leaking into a sibling candidate | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S01 source transaction failure rolls back original, Run completion and all durable story reservations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S06 scene commands are consumed only with successful source commit; cancelled or failed runs never consume | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S02 held state preserves readable source; cancellation and failure require retry before the HTTP waiting Run resumes | KEEP | 위 계약 그룹의 고유 경계 유지 |
| S04 HTTP author declarations do not need transcripts and retcon preserves the old stored record | KEEP | 동일 상태의 attempts 빈배열 중복 assertion1개만 제거 |

### tool-outcome.test.ts

정적 선언 3개. 도구 schema/execution 일치·private/missing 비노출·총 correction 및 반복 중단.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| search schema and execution agree at boundaries and reject extra fields | KEEP | 위 계약 그룹의 고유 경계 유지 |
| missing and private resources retain identical safe failure, unapproved tools stay terminal | KEEP | 위 계약 그룹의 고유 경계 유지 |
| total corrections are bounded and key ordering does not evade repetition detection | KEEP | 위 계약 그룹의 고유 경계 유지 |

### translation-auto-retry.test.ts

정적 선언 11개. 분류기 prefix1000·도구 격리·확정 거절만 재시도·공유 예산·취소/권한·후보 보존.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| sends natural translation text as-is and only its first 1000 characters to the configured classifier | KEEP | 위 계약 그룹의 고유 경계 유지 |
| confirmed classifier refusal retries once by default with fresh tool state | KEEP | 위 계약 그룹의 고유 경계 유지 |
| classifier %s preserves candidate and never retries translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| live protocol requires a configured classifier before sending translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| classifier and translator share the current job policy budget | KEEP | 위 계약 그룹의 고유 경계 유지 |
| maxRetries zero retains a refused candidate without replay | KEEP | 위 계약 그룹의 고유 경계 유지 |
| cancellation after classifier response retains usage and prevents another translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| classifier authorization is rechecked and cannot cause translation replay | KEEP | 위 계약 그룹의 고유 경계 유지 |
| deterministic provider refusal retries but does not require a synthetic classifier | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not replay %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| policy validates bounded retries and classifier JSON never executes instructions | KEEP | 위 계약 그룹의 고유 경계 유지 |

### translation-context.test.ts

정적 선언 5개. frozen ancestry/hash의 이전 번역·memory/원문/자료 조회·paging·tool 예산.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| SQLite scopes prior wording to frozen ancestry/hash and excludes future, siblings, foreign chats and edited originals | KEEP | 위 계약 그룹의 고유 경계 유지 |
| HTTP tool discovery/read reaches older-than-two source, typed authored memory and previous wording; SQLite attempts remain explicit | KEEP | 위 계약 그룹의 고유 경계 유지 |
| translation tools support empty memory with disabled indexing, bounded paging and immutable wording | KEEP | 위 계약 그룹의 고유 경계 유지 |
| HTTP %s tool result preserves bounded execution and durable job status | KEEP | 위 계약 그룹의 고유 경계 유지 |
| translation searches and reads frozen bot/persona/modules even when absent from the lore catalog | KEEP | 위 계약 그룹의 고유 경계 유지 |

### translation-continuity.test.ts

정적 선언 2개. bot/persona/glossary/이전 원문 동결·whole source 단일 삽입과 조회 도구 제공.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| keeps source-time bot, persona, glossary and prior originals frozen in one input | KEEP | 위 계약 그룹의 고유 경계 유지 |
| default prompt receives the full original once and offers prior source, memory and wording reads | KEEP | 위 계약 그룹의 고유 경계 유지 |

### translation-display.test.ts

정적 선언 2개. 진행/실패 때 이전 성공 보존·새 성공 교체·stale source 제외의 순수 표시 선택.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| new pending, refused and failed candidates preserve the previous successful translation | KEEP | 위 계약 그룹의 고유 경계 유지 |
| completed replacement wins and stale source identity never displays | KEEP | 위 계약 그룹의 고유 경계 유지 |

### transport.test.ts

정적 선언 14개. fixture protocol의 실제 loopback SSE·main runner 권한/도구/usage/opaque 및 유실/취소.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| P01 P02 P05 pins attached canon, compiles active controls and journals real tool turns before fetch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 rejects reused tool IDs across main rounds before executing any tools from the invalid round | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 honors main timeout from $selection and forwards selected thinking level | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P04 P05 checks current connection policy before each call and never retries a revoked route | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P01 P04 hides disabled persona in pinned context and read scope; denied model tools cannot escalate | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P01 P03 separates package translation instructions from main and keeps empty profiles free of synthetic facts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 handles fragmented UTF8, tool argument JSON, call IDs and opaque state across real fetch turns | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P02 P05 preserves exact role requests and stable prefix while dynamic controls and source change | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P04 validates catalog data separately, keeps unknown metadata and preserves manual models on refresh failure | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P12 P04 refuses unapproved origins, redirects and connection options; credentials stay server-side and redacted | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 P06 keeps refusal, trailing usage, partial output and remote errors distinct without retry | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 rejects malformed UTF8/JSON, changed or duplicate tool IDs and incomplete terminal results | KEEP | 위 계약 그룹의 고유 경계 유지 |
| P05 abort and timeout stop a real stream, retain observed text and never start another request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| custom main prompt remains literal across tools after the caller changes its profile | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-app.test.ts

정적 선언 2개. Vertex mock-wire→실제 HTTP app→SQLite의 Main/번역/후보·재시작 종단 검증; live 증거 아님.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| L01 P05 P07 P08 P09 preserves source-time Main/Aux snapshots, whole-source translations and sibling ownership across duplicate commands and restart | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P06 P11 restarting an in-flight Vertex %s stream preserves old records and never replays it | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-auth.test.ts

정적 선언 2개. ADC SDK 실패/취소에 credential/attempt/외부 생성이 새지 않는 경계.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| L01 P04 missing ADC and SDK auth errors cannot disclose credentials or start a model request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P05 abort while obtaining ADC prevents late token from starting generation | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-credentials.test.ts

정적 선언 3개. 서비스계정 업로드 파일·project/app scope·재시작·권한/MIME/비밀 비저장.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| upload persists normalized file outside SQLite and survives app restart without network | KEEP | 위 계약 그룹의 고유 경계 유지 |
| resolver mints only for matching Vertex project and app store; token failures are sanitized | KEEP | 위 계약 그룹의 고유 경계 유지 |
| upload is guarded and hostile service accounts never reach GoogleAuth or storage | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-protocol.test.ts

정적 선언 28개. Gemini codec의 signed parts·없는 native ID·generation/usage·terminal/stream 규약.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| encodes contract, complete input JSON and function schemas without unsupported sampling fields | KEEP | 위 계약 그룹의 고유 경계 유지 |
| translates complete source as plain text while preserving tools and continuation identity | KEEP | 위 계약 그룹의 고유 경계 유지 |
| plain translated text preserves natural digits, direction words and line breaks | KEEP | 위 계약 그룹의 고유 경계 유지 |
| refusal classification does not receive translation output instructions | KEEP | 위 계약 그룹의 고유 경계 유지 |
| does not add translation format constraints to %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supports explicit %s thinking level | KEEP | 위 계약 그룹의 고유 경계 유지 |
| 3.1 Pro preserves explicit zero sampling and stop sequences while omitting unselected thinking | KEEP | 위 계약 그룹의 고유 경계 유지 |
| 3.8 Flash rejects ignored sampling %j | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unsupported max output %s before wire encoding | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects unselected models, unsupported thinking and duplicate declarations | KEEP | 위 계약 그룹의 고유 경계 유지 |
| retains every provider part and strict same-name call matching over multiple rounds | KEEP | 위 계약 그룹의 고유 경계 유지 |
| supports omitted args for no-argument %s with willContinue=%s while preserving signed parts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| accepts completed arguments with willContinue false and returns the original signed part | KEEP | 위 계약 그룹의 고유 경계 유지 |
| uses independent host IDs for absent provider IDs without inserting them into returned parts or responses | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects %s tool results | KEEP | 위 계약 그룹의 고유 경계 유지 |
| binds continuation to unchanged %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects missing, corrupted and unfinished continuation while diagnostic redaction preserves actual body | KEEP | 위 계약 그룹의 고유 경계 유지 |
| appends visible text only, preserves trailing usage verbatim and counts response plus thoughts | KEEP | 위 계약 그룹의 고유 경계 유지 |
| keeps entirely missing usage unknown and retains observed thought tokens without inventing missing raw fields | KEEP | 위 계약 그룹의 고유 경계 유지 |
| returns explicit %s refusal and preserves later usage | KEEP | 위 계약 그룹의 고유 경계 유지 |
| treats explicit prompt blocking as terminal without a generated candidate | KEEP | 위 계약 그룹의 고유 경계 유지 |
| MAX_TOKENS remains partial even with a complete-looking tool object | KEEP | 위 계약 그룹의 고유 경계 유지 |
| reports %s as a terminal error | KEEP | 위 계약 그룹의 고유 경계 유지 |
| requires a terminal signal at EOF and never promotes empty or thought-only completion | KEEP | 위 계약 그룹의 고유 경계 유지 |
| refuses unexpected streamed argument representation %# | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects duplicate call IDs within a response and across provider turns | KEEP | 위 계약 그룹의 고유 경계 유지 |
| fails explicitly on malformed response %# | KEEP | 위 계약 그룹의 고유 경계 유지 |
| allows trailing metadata, rejects new parts and duplicate terminals after completion | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-settings.test.ts

정적 선언 5개. Vertex ADC/Bearer·global model defaults·local catalog·frozen archive 및 옵션 위조.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| accepts ADC and named Bearer references, normalizes the global base path and rejects unsupported authority | KEEP | 위 계약 그룹의 고유 경계 유지 |
| stores the selected model defaults and bounds while keeping fixture rows unchanged | KEEP | 위 계약 그룹의 고유 경계 유지 |
| returns only the local Vertex support manifest without fetching or requiring credentials | KEEP | 위 계약 그룹의 고유 경계 유지 |
| exports and restores optional settings and immutable snapshots, with every connection disabled and credential reference removed | KEEP | 위 계약 그룹의 고유 경계 유지 |
| rejects forged Vertex archive model options against its referenced connection and rolls back every row | KEEP | 위 계약 그룹의 고유 경계 유지 |

### vertex-transport.test.ts

정적 선언 11개. Vertex native path·auth·Flex confirmation/timeout·signed tool/SSE·no-retry.

| case 제목 | 결정 | 흡수 대상·이유 |
|---|---|---|
| the well-known Google credential variable remains an ADC file reference | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P04 P05 authenticates after validation, journals before fetch, preserves signed tool parts and late usage | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P05 $name is terminal and retains observed text and usage | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P05 timeout and cancellation stop a real stream without another model request | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P05 %s still stops a pending body read when fetch misses the abort | KEEP | 위 계약 그룹의 고유 경계 유지 |
| L01 P04 P05 HTTP 429 does not retry and denied admission never reaches the provider | KEEP | 위 계약 그룹의 고유 경계 유지 |
| explicit Flex headers and traffic confirmation %s | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a non-Vertex generation option never silently disappears before fetch | KEEP | 위 계약 그룹의 고유 경계 유지 |
| a server Flex override applies only when the model request has no conflicting selection | KEEP | 위 계약 그룹의 고유 경계 유지 |
| Gemini 3.1 Pro uses the exact global model path and selected sampling values | KEEP | 위 계약 그룹의 고유 경계 유지 |
| unreviewed Google models fail before resolving credentials or fetching | KEEP | 위 계약 그룹의 고유 경계 유지 |
