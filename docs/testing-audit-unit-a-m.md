# 단위·통합 테스트 감사: a–m

검토 범위는 `tests/[a-m]*.test.ts` 48개이며 `harness.test.ts`는 별도 도구 감사 소유예요. 모든 테스트 본문과 assertion을 읽고 아래 계약군별로 판단했어요. 파일 이름만 보고 일괄 유지하지 않았어요.

337개 source case 선언에서 4개를 흡수·제거해 333개가 남아요. 현재 분류는 KEEP 331개, MERGE 1개(`library-loading`), OPTIONAL 1개(`codex-installed`)예요. `.each`와 loop 안의 동적 case는 선언 1개로 세므로 Vitest 실행 개수와 다르며, 내부 assertion 수를 테스트 개수로 주장하지 않아요. ET01 일부 assertion 이동은 case 삭제에 포함하지 않아요.

## 적용한 정리

| 위치 | 판단 | 흡수 위치 / 보존 계약 |
|---|---|---|
| agent-collaboration-config: 오류 클래스 단독 생성 | MERGE | rejects helper가 실제 validator 예외의 class/code/name/message를 한 번 호출로 확인 |
| chat-organization: schema 재개방 단독 case | MERGE | 첫 정렬·archive case에 재개방 chat/revision 및 불필요한 .pre 파일 부재 흡수 |
| live-journey: execute=true 재활성화 단독 case | MERGE | 옵션 property 접근 자체를 거부하는 Proxy case가 더 강하게 보호. CLI는 journey/retry의 빈 인자·preflight·execute를 함께 검증 |
| main-request: NMR06 | REMOVE | body 존재만 확인. NMR01 실제 preview/runner/body 동등성, lore-placement native 4codec prefix, custom-prompts native 5codec HTTP가 의미 있는 동작 검증을 제공 |
| evaluation-tools ET01 옵션 validation 일부 | MERGE | evaluation-settings 첫 case에 undefined/extra 및 valid roundtrip을 합침. session/generation/tool 정의 검사는 ET01 유지 |
| library-loading | MERGE | 대용량 fixture와 무기준 시간 기록을 제거하고 응답 크기·본문 미전송·CAS/shape 확인 유지 |

## 검증

- 첫 수정 4파일: Vitest 33 PASS.
- 추가 수정 evaluation-tools/evaluation-settings/main-request 3파일: Vitest 24 PASS.
- 후속 journey/retry CLI 확장: Vitest 3 PASS, Biome check PASS.
- 변경 7파일 Biome check와 전체 tsc --noEmit 통과. 최종 통합 quality 검사는 상위 작업에서 수행해요.
- 설치 CLI opt-in은 실행하지 않았으며, 실제 외부 모델·사용자 DB·실기기 검증은 이 감사의 증거가 아니에요.

## 계약군별 판단과 전체 case 대응

### `access-session.test.ts` — 14개 선언

보안 계약을 유지해요. 선택적 local 인증과 remote 필수 인증, 12시간 절대 만료, 32세션 퇴거, 10회/15분 제한, cookie 모호성, 실제 HTTP no-store·logout·인코딩 경로 우회는 서로 다른 실패 경로예요.

| 현재 case | 판단 |
|---|---|
| 'local access stays optional and configured local tokens use the existing HTTP cookie' | KEEP |
| 'remote access rejects absent or weak configuration without repeating the configured value' | KEEP |
| 'remote login uses fresh independent secure sessions and logout revokes only its session' | KEEP |
| 'session expiry is absolute at 12 hours and requests do not extend it' | KEEP |
| 'session count is bounded to 32 and replacing the oldest session reports revocation' | KEEP |
| 'expired sessions are removed before capacity eviction' | KEEP |
| 'unknown, malformed, ambiguous and non-session cookies never authenticate' | KEEP |
| 'remote failures throttle the whole workspace after ten attempts until the 15 minute window ends' | KEEP |
| 'a successful remote login resets prior failures and local mode does not throttle' | KEEP |
| 'session routes preserve optional local access and do not cache authentication state' | KEEP |
| 'remote session routes protect API resources, revoke logout and emit matching secure cookie attributes' | KEEP |
| 'remote route throttling ignores spoofed forwarded IPs, sets Retry-After and never echoes tokens' | KEEP |
| 'capacity eviction invokes the existing revocation notification used by active streams' | KEEP |
| 'matched API routes require authentication even with encoded request paths (remote=%s)' | KEEP |

### `agent-collaboration-config.test.ts` — 14개 선언

순수 검증 경계예요. 기본 OFF와 독립 복사, 템플릿의 읽기 전용·불확실성 지침, 인원/호출/문자열/참조 경계, 엄격한 JSON·getter·prototype 거부를 유지해요. Error 클래스 단독 echo는 실제 validator 실패 검증으로 흡수했어요. 템플릿 문구 검사는 창작 품질 증거가 아니에요.

| 현재 case | 판단 |
|---|---|
| 'starts disabled with independent mutable arrays' | KEEP |
| '%s is editable and reads only' | KEEP |
| 'specialist templates preserve perspective, evidence and uncertainty' | KEEP |
| 'empty agents are allowed only when disabled; disabled agents still validate' | KEEP |
| 'accepts six agents and enforces shared and individual ceilings independently' | KEEP |
| '%s requires integers within inclusive limits' | KEEP |
| '%s preserves text and enforces inclusive lengths' | KEEP |
| 'agent IDs use bounded ASCII lowercase names and reject unsafe names' | KEEP |
| 'shared controls accept existing prompt IDs, enforce uniqueness and optionally check existence' | KEEP |
| 'supports both triggers, every read scope, no tools and explicit or inherited models' | KEEP |
| 'rejects missing fields, unknown fields and unsafe keys at every object level' | KEEP |
| 'does not execute accessors or toJSON hooks' | KEEP |
| 'rejects sparse arrays, added array properties, inherited arrays and non-JSON values' | KEEP |
| 'clones frozen or null-prototype records and every mutable nested container' | KEEP |

### `agent-collaboration-runtime.test.ts` — 11개 선언

실행 중 권한 재검사와 고정 모델·지침, 제한된 자료 읽기, attempt/usage, 취소, unavailable 캐시, recoverable 수정 한도를 확인해요. 설정 검증만으로 대신할 수 없어요.

| 현재 case | 판단 |
|---|---|
| 'absent and disabled collaboration preserve the one-call main path and its existing read permissions' | KEEP |
| 'completed advisor attempts restore with their frozen models and reject forged advisor attribution atomically' | KEEP |
| 'before advisors run in order with scoped reads, selected models and explicit shared controls; only final main prose becomes a source' | KEEP |
| 'on-demand main -> advisor read loop -> main persists attempts before HTTP and caches duplicate consultations without double-counting usage' | KEEP |
| 'host, collaboration and per-advisor budgets bound real requests while reserving the last main call' | KEEP |
| 'advisor recursive consult, state writes, final submission and ungranted reads are rejected before any mixed-turn read; inaccessible content stays excluded' | KEEP |
| 'HTTP failure, partial output and uncertain disconnect become cached unavailable advice without retries or discarded usage' | KEEP |
| 'cancelling a live advisor closes its HTTP stream, preserves completed usage and prevents any main call or source' | KEEP |
| 'model and prompt changes after reservation cannot replace frozen advisor configuration or generation parameters' | KEEP |
| 'current advisor connection authorization is checked again between read rounds while main can still finish' | KEEP |
| 'advisor can correct invalid search arguments while only successful reads become evidence' | KEEP |

### `agent-collaboration-store.test.ts` — 7개 선언

Run snapshot 불변·참조·설정 삭제·위조 archive·attempt 귀속을 DB에서 확인해요. 순수 설정 검증과 실행 권한 검증 사이의 저장 계약이에요.

| 현재 case | 판단 |
|---|---|
| 'reservation freezes each advisor and prompt; later current settings apply only to the next run' | KEEP |
| 'advisors share explicit instructions and selected options without copying the authored main prompt' | KEEP |
| 'archive restore keeps frozen advisor evidence while revoking both inherited and separate connections' | KEEP |
| 'forged or missing advisor snapshot models roll archive restoration back' | KEEP |
| 'disabled collaboration and switching the main prompt restore the ordinary execution path' | KEEP |
| 'model references, prompt role and CAS are checked before storing collaboration settings' | KEEP |
| 'advisor model deletion preserves its historical Run independently of current library references' | KEEP |

### `anthropic-protocol.test.ts` — 35개 선언

합성 native codec 경계예요. 옵션 조합, 별칭 충돌, signed/opaque 순서, continuation 변경 금지, tool ID/args 대응, stream 순서·EOF·usage·stop sequence가 각자 실패 원인이에요. 실제 네트워크 테스트와 중복으로 보지 않아요.

| 현재 case | 판단 |
|---|---|
| 'encodes the complete request and collision-free aliases without changing optional tool parameters' | KEEP |
| 'writes Opus 5 output effort, thinking and advanced options without inserting defaults' | KEEP |
| 'rejects incompatible generation settings %j' | KEEP |
| 'plain translation preserves complete source, selected options and continuation binding' | KEEP |
| 'Fable 5.1 preserves the exact system, tools, message prefix and signed thinking across tool rounds' | KEEP |
| 'Fable 5.1 rejects forced tool selection and disabled thinking without changing user options' | KEEP |
| 'Claude cache %s reaches requests without a native prompt and preserves translation formatting' | KEEP |
| 'plain translation accepts natural digits and direction words without an output envelope' | KEEP |
| 'refusal classification does not receive translation output instructions' | KEEP |
| 'does not send translation formatting for %s' | KEEP |
| 'preserves signed, redacted and opaque content in order across parallel and sequential tool rounds' | KEEP |
| 'rejects %s tool result correspondence' | KEEP |
| 'encodes a denied result as an error while preserving its payload' | KEEP |
| 'rejects changed %s during continuation' | KEEP |
| 'assembles split tool JSON including escaped strings and nested input before exposing the call' | KEEP |
| 'accepts zero-argument tool calls and signature-only thinking without displaying hidden content' | KEEP |
| 'rejects reused IDs across rounds and unadvertised wire names' | KEEP |
| 'rejects non-object or incomplete JSON at a tool terminal: %s' | KEEP |
| 'retains partial status for truncated tool JSON without executing or continuing it' | KEEP |
| 'distinguishes %s from successful prose' | KEEP |
| '%s completes a requested stop sequence after tool continuation with the original binding' | KEEP |
| 'keeps an unconfirmed stop sequence partial: %j' | KEEP |
| 'a requested stop sequence does not turn an empty response into completed prose' | KEEP |
| 'recognizes explicit refusal details without requiring visible refusal text' | KEEP |
| 'requires message_stop and preserves partial text and observed usage on EOF' | KEEP |
| 'merges cumulative usage and adds disjoint cache input buckets once, keeping detailed raw counts and null cost' | KEEP |
| 'keeps absent or explicitly unknown usage unknown: %j' | KEEP |
| 'rejects invalid usage %j' | KEEP |
| 'rejects regressing cumulative usage and arithmetic overflow' | KEEP |
| 'preserves citations and complete opaque provider blocks while exposing only text' | KEEP |
| 'ignores informational events without letting them mark successful completion' | KEEP |
| 'rejects malformed sequence: %s' | KEEP |
| 'does not accept tool calls under end_turn or an empty tool_use terminal' | KEEP |
| 'does not replay unsigned thinking or provider errors, and errors never contain raw provider text' | KEEP |
| 'snapshots are independent copies and late events cannot change a completed message' | KEEP |

### `archive-library-state.test.ts` — 3개 선언

현재 workspace 필수 행, 숨김 ID/kind 존재성, 옵션 역할/값 독립 복사를 archive에서 확인해요. 일반 archive의 source 관계 검증으로 대체되지 않아요.

| 현재 case | 판단 |
|---|---|
| 'only default working content counts as empty; explicit reset preserves import eligibility' | KEEP |
| 'archive requires one working slot and validates hidden kind and retained target before committing' | KEEP |
| 'independent option copies and removed library entries round-trip without a live preset dependency' | KEEP |

### `archive.test.ts` — 3개 선언

일반 archive의 관계 정합성, 다른 chat의 ancestry/job 오염, snapshot과 평문 번역 손상에 대한 원자적 거부를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'P11 restores complete plain translation text and normalizes asset URLs without mutating input' | KEEP |
| 'P11 rejects active asset MIME, foreign identity, cross-chat lineage and poisoned frozen references atomically' | KEEP |
| 'P08 P11 rejects foreign translation identity, malformed text and retired structured output' | KEEP |

### `asset-deletion.test.ts` — 3개 선언

목록 숨김과 과거 snapshot 참조·실제 bytes 보존, 삭제 CAS와 HTTP 접근 계약을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'upload deletion hides catalog entry and retains bytes, emits an event, and leaves archive valid' | KEEP |
| 'cross-chat and malformed deletions preserve the uploaded bytes' | KEEP |
| 'deletion preserves active execution and immutable completed image catalogs' | KEEP |

### `asset-manifest.test.ts` — 3개 선언

메타데이터 조회와 ID/revision/hash 복합 참조 검증, 페이지네이션, bytes/URL 미노출을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'S07 resolves exact stable metadata and rejects stale, missing, conflicting and denied combinations' | KEEP |
| 'S07 metadata search is scoped, paginated and never transmits URL or asset bytes' | KEEP |
| 'S07 incomplete refs and oversized metadata have explicit fallback' | KEEP |

### `auxiliary-error.test.ts` — 5개 선언

안전한 오류 코드 분류와 사용자 메시지, 불확실 요청 자동 재생 방지, 원문 오류 비노출을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'identifies exactly the missing model role' | KEEP |
| 'distinguishes provider authorization from structured auxiliary output failures' | KEEP |
| 'explains uncertain execution without promising a safe automatic replay' | KEEP |
| 'distinguishes missing classifier, failed classification, uncertainty and retry limits without replay promises' | KEEP |
| 'does not expose raw remote text, unrecognized codes or inherited object keys' | KEEP |

### `auxiliary.test.ts` — 11개 선언

source-time 고정·실제 조회 결과 범위·권한 거부·수정 한도·전체 평문 번역과 별도의 이미지 anchor/asset 검증이에요. 이미지 fixture SVG 검사는 합성 자료 무결성 검사이며 실제 이미지 선택 품질이 아니에요.

| 현재 case | 판단 |
|---|---|
| 'P07 freezes source-time identities and exposes legal unprefetched read results to translation only' | KEEP |
| 'P07 roles can finish directly and skill reads cannot expand permissions; cancellation and real loop budget apply' | KEEP |
| 'a recoverable scoped read error is returned for correction without losing the original' | KEEP |
| 'repeating an identical recoverable read is bounded before a third provider call' | KEEP |
| 'whole-source translation preserves long prose, natural numbers and exact source identity without tokens' | KEEP |
| 'reader and image paragraph anchors retain exact fenced code offsets' | KEEP |
| 'presentation without supplied assets cannot select the synthetic fixture catalog' | KEEP |
| 'P10 P13 explicitly supplied fixture assets preserve source and allow image none' | KEEP |
| 'P13 authored metadata does not require literal scene cues and display annotations cannot smuggle authoritative fields' | KEEP |
| 'image catalog pages find names beyond the first page without exposing URLs' | KEEP |
| 'image selection uses IDs for duplicate names and rejects a different content hash' | KEEP |

### `chat-activity.test.ts` — 1개 선언

Run/job 메타데이터 집계와 stale 상태 표현을 확인해요. 원문 처리나 실제 공급자 activity 증거와 구분해요.

| 현재 case | 판단 |
|---|---|
| 'sidebar activity groups all chats, excludes settled and stale work, and exposes metadata only' | KEEP |

### `chat-deletion.test.ts` — 9개 선언

CAS·active 작업·branch·공유 설정·기억 참조를 포함하는 삭제 graph와 cascade, archive/HTTP 경계를 유지해요.

| 현재 case | 판단 |
|---|---|
| 'chat deletion removes owned graph atomically and preserves independent forks and catalog' | KEEP |
| 'chat confirmation rejects stale branches, settings, profile and organization with no deletion' | KEEP |
| 'active run or outstanding provider attempt blocks deletion until completion' | KEEP |
| 'exclusive branch history is deleted while shared ancestor and default snapshots are preserved' | KEEP |
| 'unused author canon and scene commands can be deleted; referenced and retcon entries remain' | KEEP |
| 'deleting a branch preserves shared configuration and removes its package receipts' | KEEP |
| 'branch with an active global story configuration anchor is retained' | KEEP |
| 'HTTP deletion impact and delete routes return errors before mutation and success after commit' | KEEP |
| 'dependent branch prevents parent deletion and deleting child first makes it possible' | KEEP |

### `chat-fork.test.ts` — 7개 선언

선택 ancestry, source-time 리소스, 성공 artifact만 복사, literal text 보존, idempotency, 실제 SQLite trigger 실패 rollback, 원본 없는 archive를 확인해요. 각 저장 경로는 일반 fork happy path로 대체되지 않아요.

| 현재 case | 판단 |
|---|---|
| 'forked runs keep source-time package resource revisions after the current owning package changes' | KEEP |
| 'copies only the selected ancestry and completed artifacts, retaining literal text and independent settings' | KEEP |
| 'makes repeated keys durable, uses distinct automatic titles and rejects conflicting selections' | KEEP |
| 'forks a nondefault branch with its owning bot profile without altering that branch' | KEEP |
| 'rejects foreign, absent and invalid inputs before creating any copy' | KEEP |
| 'rolls back chat, profile, resources, assets and copied runs after an actual SQLite insertion failure' | KEEP |
| 'round-trips copied source, prompts, translations and assets and accepts provenance without the original chat' | KEEP |

### `chat-organization.test.ts` — 9개 선언

수동 순서·CAS·잘못된 anchor/소유권·폴더 기본값·fork·archive/HTTP를 유지해요. 별도 schema 재개방 case의 저장/revision 확인은 첫 정렬·archive·재개방 case에 흡수했어요.

| 현재 case | 판단 |
|---|---|
| 'manual order survives moves, folder deletion, new chats, archive and reopen' | KEEP |
| 'invalid and stale order anchors roll back every position and revision' | KEEP |
| 'bot ownership and folder defaults apply only at creation; moves/deletion preserve profile' | KEEP |
| 'cross-bot moves, stale edits and invalid defaults fail without losing organization' | KEEP |
| 'fork inherits original owner/folder/profile without reapplying changed default' | KEEP |
| 'creation selects ownership and later attachments never infer a new owner' | KEEP |
| 'organization archive roundtrip retains defaults, ownership and CAS revisions' | KEEP |
| 'HTTP organization routes enforce bot scopes and CAS and reject missing owners' | KEEP |
| 'one package can own a chat and serve as a persona through explicit attachment roles' | KEEP |

### `codex-installed.test.ts` — 1개 선언

OPTIONAL: 기존 환경변수 opt-in을 유지해요. 실제 설치 CLI의 읽기 전용 handshake 검사이며 모델 turn을 요청하지 않아요. 합성 stdio fixture와 별도예요.

| 현재 case | 판단 |
|---|---|
| 'installed Codex initializes with isolated empty authentication' | OPTIONAL |

### `codex-integration.test.ts` — 2개 선언

앱 HTTP 인증·Origin·redaction과 모든 역할의 RPC attempt·제안·archive 연결을 확인해요. runtime을 주입하므로 실제 CLI 호출 증거는 아니에요.

| 현재 case | 판단 |
|---|---|
| 'runtime HTTP routes enforce authentication and Origin and redact failures with no-store' | KEEP |
| 'app routes every agent role through Codex and persists RPC attempts, proposals and archive contracts' | KEEP |

### `codex-process.test.ts` — 9개 선언

실제 합성 subprocess의 초기화·응답 순서·취소·timeout·잘못된 UTF-8·missing executable·늦은 응답·종료를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'handshakes and correlates concurrent responses in different order' | KEEP |
| 'rejects server approvals without granting privileges' | KEEP |
| 'cancels and times out locally, ignores late results, and keeps the session usable' | KEEP |
| 'terminates and rejects all pending work on %s' | KEEP |
| 'accepts story context larger than 1 MiB within the bounded frame limit' | KEEP |
| 'sanitizes provider errors and process exit diagnostics' | KEEP |
| 'cleans pending requests on close without a restart' | KEEP |
| 'closes a stalled initialization' | KEEP |
| 'reports a missing executable without leaking process diagnostics' | KEEP |

### `codex-protocol.test.ts` — 3개 선언

순수 turn encoding과 엄격한 output/도구 allowlist를 확인해요. subprocess 생명주기와는 별도 경계예요.

| 현재 case | 판단 |
|---|---|
| 'all six roles use injected Codex execution without HTTP authority or credentials' | KEEP |
| 'preserves ordered logical roles and explicit empty instructions while rejecting unsupported semantics' | KEEP |
| 'decodes only advertised tool requests and rejects mixed, builtin, duplicate, and malformed output' | KEEP |

### `codex-runtime.test.ts` — 14개 선언

기본 OFF·credential 격리·버전·로그인 URL·subscription·durable attempt 전송 순서·권한 재검사·불확실 실행·큐 취소/해제·close 경합을 확인해요. 합성 stdio만 사용해요.

| 현재 case | 판단 |
|---|---|
| 'starts disabled without creating credentials and rejects shell wrapper configuration' | KEEP |
| 'checks the required protocol version before starting or authorizing work' | KEEP |
| 'exposes subscription metadata and catalog without identities, credentials or a model turn' | KEEP |
| 'delegates device login to Codex and cancels it without accepting a token' | KEEP |
| 'does not offer an arbitrary provider login URL or fall back to API authentication' | KEEP |
| 'persists a truthful RPC attempt before any turn, denies environment access and decodes final output' | KEEP |
| 'does not execute when durable attempt recording fails' | KEEP |
| 'rechecks host authority after thread setup and before starting the model turn' | KEEP |
| 'bounds %s and never replays a possibly executing request' | KEEP |
| 'rejects %s without adopting a result or exposing diagnostics' | KEEP |
| 'accepts completion before the turn-start acknowledgement without losing or duplicating the result' | KEEP |
| 'cancels a waiting execution without an attempt and keeps independent turns isolated' | KEEP |
| 'lets queued ordinary work run after a slot is released' | KEEP |
| 'closes during installation and initialization without leaving a usable manager' | KEEP |

### `content-package.test.ts` — 4개 선언

엄격한 package JSON과 로어 링크·조건·정규식 worker 제약을 확인해요. 실행 결과와 별도의 입력 경계예요.

| 현재 case | 판단 |
|---|---|
| 'keeps body, internal lore and metadata byte-for-byte and accepts every attachment role without identity' | KEEP |
| 'rejects executable extension fields, unsupported versions and unresolved internal lore links' | KEEP |
| 'reuses typed controls and validates conditional templates before execution' | KEEP |
| 'accepts conventional regex data for worker execution but rejects duplicate flags' | KEEP |

### `context-authored-integration.test.ts` — 1개 선언

실제 authored 시작과 일반 turn을 DB에 만든 뒤 요약·원문 수정·독립 fork·archive 위조 거부까지 host provenance가 이어지는지 확인해요. 순수 authored 입력 테스트로 대체되지 않아요.

| 현재 case | 판단 |
|---|---|
| 'real authored start and ordinary turns retain host provenance through compaction, edits, standalone forks and archive validation' | KEEP |

### `context-budget.test.ts` — 11개 선언

토큰 추정 경계와 모델별 output 예약, native body만 계산, 숨은 continuation 포함, credentials/attempt/fetch 전에 거부되는지 확인해요. 6개 프로토콜의 전달 경계를 유지해요.

| 현재 case | 판단 |
|---|---|
| 'uses stable multilingual o200k estimates with safety margin, including literal special-token spellings' | KEEP |
| 'validates host policy strictly, preserves explicit limits and applies the model default' | KEEP |
| 'accepts the inclusive boundary and never mutates oversized payloads or silently imposes an absent policy' | KEEP |
| '$protocol reserves the selected output inside the reviewed native window without rewriting settings' | KEEP |
| 'does not invent a native window for Codex, a routed model or an unknown model ID' | KEEP |
| '$protocol rejects an oversized first request with zero credential, journal and fetch calls' | KEEP |
| '$protocol measures the native body, not duplicated raw snapshot fields' | KEEP |
| '$protocol includes unredacted opaque continuation content in the budget before any wire work' | KEEP |
| '$protocol binds the budget across native continuation, including adding or removing it' | KEEP |
| 'fixture continuation content is counted before credentials and journaling' | KEEP |
| 'Codex rejects its assembled instructions, input and schema before creating session state or a process' | KEEP |

### `context-checkpoint-storage.test.ts` — 7개 선언

DB ancestry checkpoint 선택에서 hash·budget·dependency·상태·source identity·404·hidden view 만료를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'returns no checkpoint for unsummarized ancestors, including absent and null plans' | KEEP |
| 'uses ancestry order, skips a newer unsummarized run and returns independent copies' | KEEP |
| 'falls back to an older valid checkpoint after a newer %s candidate' | KEEP |
| 'rejects reuse after current source edits or changed semantic dependencies' | KEEP |
| 'rejects expired source-segment views even when original text and hashes are unchanged' | KEEP |
| 'still rejects invalid source identity: %s' | KEEP |
| 'preserves 404 errors for missing ancestors and missing originating runs' | KEEP |

### `context-compaction.test.ts` — 15개 선언

projection 원문 불변, 요약 fragment의 UTF-16 경계·전부 성공 전 미확정, checkpoint 재사용, authored 역할, hidden viewHash, 취소·실패·저장 오류·공유 호출 한도·보조 모델 선택을 확인해요. 대부분 fetch stub이며 DB 통합과 별개예요.

| 현재 case | 판단 |
|---|---|
| 'under-threshold input needs no provider call and preserves source text, roles, prompt, and current input' | KEEP |
| 'oversized Korean exchanges are summarized with user wishes intact before main generation, retaining the latest two exchanges' | KEEP |
| 'a completed ancestor summary is reused without charging its earlier calls and is merged whole when new exchanges require more space' | KEEP |
| 'one large source is split on UTF-16 boundaries and becomes compacted only after all user and assistant fragments succeed' | KEEP |
| 'an explicitly authored start can be compacted as one assistant message without inventing a user turn or leaking its host discriminator' | KEEP |
| 'an authored-start discriminator is invalid on user/current messages or an ordinary pair, and unknown discriminators are rejected' | KEEP |
| 'configured source exclusions are applied before summarization while compacted references hash the full original source' | KEEP |
| 'a checkpoint containing a formerly allowed report cannot be reused after its configured retention window expires' | KEEP |
| '%s is terminal, retains uncertainty and cannot start main or silently drop source text' | KEEP |
| 'partial failure after a successful large-source fragment never marks the source or the staged summary reusable' | KEEP |
| 'cancellation before or at durable attempt start makes no send, retains the admitted attempt, and never exposes the abort reason' | KEEP |
| 'one main call remains reserved and a fixed input that cannot fit fails before any summary provider request' | KEEP |
| 'the frozen memory model is preferred and known accounting is accumulated without modifying either model' | KEEP |
| 'an auxiliary caller can measure its own source envelope and choose a summary model without a main model' | KEEP |
| 'hash corruption, missing logical roles, revoked authority, and failed attempt persistence stop before transmission' | KEEP |

### `context-integration.test.ts` — 6개 선언

실제 App/SQLite에서 요약 attempt와 snapshot 저장·재사용, 편집 중 경합·취소 accounting·fork/archive·evaluation 호출 한도 연결을 확인해요. provider는 fetch stub이에요.

| 현재 case | 판단 |
|---|---|
| 'summarizes old Korean pairs, sends bounded main input, preserves originals, and reuses the checkpoint on the next run' | KEEP |
| 'editing a compacted source invalidates reuse while its earlier frozen summary and source remain intact' | KEEP |
| 'cancelling an in-flight summary retains observed usage without creating prose or starting main' | KEEP |
| 'an edit while summary completes prevents the main call and retains its incurred attempt' | KEEP |
| 'forks and JSON-restores summary snapshots with mapped provenance, scrubs credentials, and rejects summary tampering' | KEEP |
| 'summary calls share the host budget while a zero-round evaluation preset still receives its first main call' | KEEP |

### `context-lore-integration.test.ts` — 3개 선언

전체 입력 한도 때문에 퇴거한 자료의 재등장 금지, 원문만 요약하고 로어를 별도로 배치, 가상 측정의 무변경을 App/DB에서 확인해요.

| 현재 case | 판단 |
|---|---|
| 'evicts whole least-recently-used references for overall input pressure, preserves ordering, and never resurrects them on the next run or restore' | KEEP |
| 'summarizes only logical conversation pairs and carries old-source raw references after the summary before recent history' | KEEP |
| 'fixed-input lore fitting and hypothetical history measurement leave the supplied snapshot and database unchanged' | KEEP |

### `context.test.ts` — 6개 선언

합성 main 실행에서 scoped read·pagination·source hash·hostile skill 권한 불확장·예산/취소·고정 view를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'F04 direct path uses exactly one main invocation and no tool/planner, preserves task and preset' | KEEP |
| 'F04 metadata is separate from source bodies and real call/results reach the next exact model input' | KEEP |
| 'F04 additional legal unprefetched lore is discoverable, paginated, and readable with continuation' | KEEP |
| 'F04 excluded resources are absent from counts/search/read and malicious skill text cannot grant tools' | KEEP |
| 'F04 budget and cancellation stop at actual invocation/tool boundaries without echoing abort reason' | KEEP |
| 'F04 input observation and live-setting mutation cannot rewrite the run snapshot or subsequent tool scope' | KEEP |

### `custom-prompts.test.ts` — 3개 선언

빈 문자열/공백/문자 그대로의 선택과 snapshot 독립성, 문자열 경계, 5개 native adapter의 실제 loopback HTTP에서 기본 prompt 재삽입 금지·wire hash를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'defaults stay compatible, exact empty and whitespace prompts replace defaults, and snapshots remain independent' | KEEP |
| 'transport permits explicit empty text without weakening non-prompt string validation' | KEEP |
| '$protocol preserves custom literals and empty selection at its native wire boundary' | KEEP |

### `evaluation-runtime.test.ts` — 8개 선언

App/SQLite와 실제 loopback HTTP에서 artifact/평문 번역·attempt·opaque 비노출·권한 취소·HTTP/partial·cancel/timeout·각 호출 한도·중복 terminal·source 편집 CAS를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'preset evaluation mixes permitted reads and local tools; buffered Responses translation keeps source/hash and per-request attempts' | KEEP |
| 'current connection enabled flag and credential availability are rechecked between evaluation rounds' | KEEP |
| 'HTTP failure and partial terminal output finish without provider replay or source commit' | KEEP |
| 'cancelling a live evaluated response preserves the one uncertain attempt and commits no source' | KEEP |
| 'evaluation timeout ends a stalled real HTTP response with no implicit retry' | KEEP |
| 'both host maxCalls and evaluation maximumToolRounds bound actual HTTP requests' | KEEP |
| 'duplicate call IDs and terminal plus host calls cannot commit or dispatch a skipped host operation' | KEEP |
| 'source edit CAS fences an in-flight evaluated translation without mutating the original source or run snapshot' | KEEP |

### `evaluation-settings.test.ts` — 3개 선언

옵션 검증을 이 파일로 모았어요. preset opt-in/해제와 과거 Run 불변, 단일 현재 설정 행, archive의 malformed 설정 원자 거부를 유지해요.

| 현재 case | 판단 |
|---|---|
| 'tool options are explicit and independently validated' | KEEP |
| 'only selected model presets persist evaluation tools and captured runs retain earlier settings' | KEEP |
| 'archive preserves current tool settings and rejects malformed tool settings atomically' | KEEP |

### `evaluation-story-runtime.test.ts` — 6개 선언

state/memory 경로의 실제 loopback HTTP와 host validator·cross-chat scope·authorization·공유 예산·local-tool 처리 포함 deadline을 확인해요. main/translation 실행기로 대신할 수 없어요.

| 현재 case | 판단 |
|---|---|
| 'M2 state uses preset evaluation and mixed local/host tool results while keeping native continuation private' | KEEP |
| 'M2 memory honors preloaded evaluation case selection and buffered JSON artifact with exact source evidence' | KEEP |
| 'evaluation terminal delivery still passes M2 state/hash and memory/canon validators without retry' | KEEP |
| 'M2 evaluation tools cannot bypass next-round authorization or cross-chat host read scope' | KEEP |
| 'M2 evaluation session maximumToolRounds and host maxCalls both cap real requests' | KEEP |
| 'M2 evaluation deadline includes local-tool processing and is not reset before the next HTTP round' | KEEP |

### `evaluation-tools.test.ts` — 6개 선언

ET01의 중복 옵션 입력 검사만 evaluation-settings로 흡수했어요. 정확한 문구·ID·metadata는 원본 포팅 계약이므로 유지해요. run-local receipt·notice 분리·수정/거절 재시도·truncation provenance·5개 adapter bootstrap 계약을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'ET01 exposes preset-selected tools and binds economized generation without changing later rounds' | KEEP |
| 'ET02 keeps context, reviewer, case receipt and preloaded history in one run-local session' | KEEP |
| 'ET03 applies bounded exact late corrections and keeps the notice out of returned content' | KEEP |
| 'ET04 returns validation errors for model resubmission and retries a high-confidence refusal once' | KEEP |
| 'ET05 recovers only a truncated Responses terminal artifact and marks its provenance' | KEEP |
| 'ET06 encodes preloaded history and the required first case across every current tool-capable adapter' | KEEP |

### `execution-context.test.ts` — 4개 선언

고정 clock/state의 false·0 보존, history projection·60개 한도, module scope·한 번 삽입, private 항목 제외를 순수 계산에서 확인해요.

| 현재 case | 판단 |
|---|---|
| 'preserves typed defaults and fixed clocks without reading wall time or mutating the snapshot' | KEEP |
| 'uses the main history projection and reports a bounded recent window' | KEEP |
| 'excludes disabled persona data and provider credentials from the main runtime' | KEEP |
| 'renders dynamic people and inserts scoped module instructions once at a declared slot' | KEEP |

### `library-deletion.test.ts` — 8개 선언

숨김 revision CAS와 현재 프로바이더 권한 취소·과거 diagnostics/snapshot 보존, bot HTTP 404, current workspace model 선택 해제를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'removes library visibility while preserving every revision and enforcing CAS' | KEEP |
| 'historical and current content references do not block removing a library entry' | KEEP |
| 'prompt copies and chat contents survive preset deletion' | KEEP |
| 'connection deletion revokes future sends and hides dependent models while preserving active diagnostics' | KEEP |
| 'all supported kinds expose DELETE and read-only impact routes with strict request validation' | KEEP |
| 'active captured work survives library deletion with unchanged snapshots and archive restore' | KEEP |
| 'deleting a bot preserves existing chat ownership and attachments but public library reads become unavailable' | KEEP |
| 'deleting %s clears refusal selection and disables dedicated advice without substituting the main model' | KEEP |

### `library-loading.test.ts` — 1개 선언

MERGE/경량화: 응답 shape·본문 미전송·revision/CAS·invalid view를 유지하고 fixture를 content 110→4, asset 1000→3으로 줄였어요. 시간 기준이 없는 성능 파일 기록을 제거했어요. 용량 기준 100배 이상 감소 검증은 유지해요.

| 현재 case | 판단 |
|---|---|
| 'library summary omits bodies and unrelated assets; exact revision editing and historical reads remain intact' | MERGE |

### `library-organization.test.ts` — 8개 선언

전역 CAS·bulk rollback·kind/category·역할 보존·폴더 정리·archive 위조·portrait 과거 blob·HTTP를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'library folders and cross-category moves preserve exact content revisions, package roles and chat ownership' | KEEP |
| 'bulk moves validate every item and destination before mutation, and stale CAS changes nothing' | KEEP |
| 'reordering is category scoped and folder deletion moves members to unclassified without deleting contents' | KEEP |
| 'item deletion cleans placement and retains immutable references' | KEEP |
| 'archives round trip folders and reject poisoned scope or missing placement atomically' | KEEP |
| 'old standalone content kinds are rejected at creation and archive restore' | KEEP |
| 'summary cover follows the latest portrait while exact revision and archived blob references stay fixed' | KEEP |
| 'HTTP routes share one organization revision and reject hidden or unknown fields' | KEEP |

### `live-journey.test.ts` — 2개 선언

폐기된 유료 실행 진입점이 옵션 접근 전에 차단되는 Proxy 검사와 browser 진입점 차단을 유지해요. execute:true 재활성화 중복 case를 첫 검사로 흡수했어요.

| 현재 case | 판단 |
|---|---|
| 'retired browser entry points reject before inspecting options' | KEEP |
| '%s preflight and execute stop before source validation, copying, authentication or provider work' | KEEP |

### `live-runtime.test.ts` — 1개 선언

이름과 달리 외부 provider 없이 loopback HTTP를 사용해요. attempt 저장 뒤 source commit 전 취소와 known/null accounting의 1회 정산이 목적이에요.

| 현재 case | 판단 |
|---|---|
| `P05 P06 cancellation after observed HTTP usage keeps terminal state and settles usage once (${observed.costUsd === null ? 'unknown cost' : 'known cost'})` | KEEP |

### `lore-context-archive.test.ts` — 10개 선언

역사적 읽기 receipt 검증, 즉시 부모 reset/eviction 뒤 재등장 금지, ordered subset·lastUsed, 독립 fork remap·편집/retcon 무효화·authoritative wait 재개를 확인해요. 위조 snapshot은 prompt 재컴파일 후 검사하므로 단순 stale prompt 테스트가 아니에요.

| 현재 case | 판단 |
|---|---|
| 'a fork preserves verified ranges and mapped provenance with no copied execution log; its archive works without the original chat' | KEEP |
| 'archive rejects snapshot-only read, range, source and recency forgeries and rolls back all imported rows' | KEEP |
| 'archive cannot resurrect an ancestor read after the immediate parent reset and performed no new read' | KEEP |
| 'archive cannot resurrect an evicted read when a later policy provides more capacity' | KEEP |
| 'a later context budget may keep whole ordered entries but cannot reorder or falsify their last use' | KEEP |
| 'fork receipts reject invented ownership, range and use as an ordinary run receipt' | KEEP |
| 'source edits preserve historical archive proof but invalidate inherited reads in a standalone fork continuation' | KEEP |
| 'authored canon identities remap for a fresh fork, while a later retcon cannot revive past reads' | KEEP |
| 'a changed canon at the root keeps historical fork contexts invalid instead of stamping them with current canon' | KEEP |
| 'an authoritative state wait resumes with the same retained read provenance before compiling the main prompt' | KEEP |

### `lore-context-ui.test.ts` — 3개 선언

입력 bounds·escaping·provenance 표현·불변성을 확인해요. 실제 모바일 터치 검증은 아니에요.

| 현재 case | 판단 |
|---|---|
| 'accepts explicit zero retention and both inclusive policy limits' | KEEP |
| 'rejects incomplete, fractional and out-of-bound drafts without changing their text' | KEEP |
| 'renders source provenance and UTF-16 facts as escaped reference text without changing the snapshot' | KEEP |

### `lore-context.test.ts` — 12개 선언

성공한 main 읽기만 계승, 범위 중첩 append·LRU·scene reset idempotency·source/ancestor/retcon·리소스/페르소나 제외·pinned 중복 방지·preview 무변경·summary 뒤 참조 배치를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'only successful main reads retain the exact observed range; search, denied, forged and unread text do not' | KEEP |
| 'overlapping reads append uncovered pieces, repeated use leaves the rendered old reference unchanged' | KEEP |
| 'character and entry budgets evict the least recently used whole slices and do not rescan evicted reads' | KEEP |
| 'new-scene reset is part of idempotency, clears inherited lore once, and permits new scene reads' | KEEP |
| '%s edits invalidate inherited context and original read receipts' | KEEP |
| 'retcon invalidates lore while preserving past snapshots; failed and alternate branch reads stay excluded' | KEEP |
| 'resource revision and attachment removal remove retained text' | KEEP |
| 'package revision and persona-reference exclusion invalidate only currently excluded reads' | KEEP |
| 'switching an attached reference to pinned supplies it once and removes the retained copy' | KEEP |
| 'disabled retention, zero budgets and invalid policy are explicit; selection is read only' | KEEP |
| 'no-call preview accepts the selected default prompt and unsaved policy without writes' | KEEP |
| 'whole-context projection carries compacted-source lore after the summary and keeps recent source anchors' | KEEP |

### `lore-folders.test.ts` — 5개 선언

엄격한 ID/2000개 한도·nested extra·독립 roundtrip과 대상별 compile 불변을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'round trips empty folders, membership and unfiled entries without mutating the input' | KEEP |
| 'rejects dangling references, malformed identifiers and duplicate folder IDs' | KEEP |
| 'requires trimmed, nonempty folder names with a 100 character limit' | KEEP |
| 'rejects nested folders and unknown metadata fields, and bounds the folder count' | KEEP |
| 'keeps resources, instructions, order and loading identical across folder moves and renames for every target' | KEEP |

### `lore-placement.test.ts` — 9개 선언

background/history/scene 순서와 1회 공급·사용된 slot에 따른 fallback·cache anchor·part/aggregate 한도·그룹 정렬·native 4codec의 고정 prefix와 append 범위를 확인해요.

| 현재 case | 판단 |
|---|---|
| 'places background before history and scene next to current exactly once' | KEEP |
| 'disabled and untaken slots cannot suppress fallback; custom cache anchors stay fixed' | KEEP |
| 'consumed custom references suppress automatic pinned delivery' | KEEP |
| 'custom lore consumes module body and identity as well as legacy pinned module content once' | KEEP |
| 'fallback cannot bypass provider part or aggregate message limits' | KEEP |
| 'ordering is stable inside package-role groups and independent of folders' | KEEP |
| 'pinned budget fails explicitly without silently dropping content' | KEEP |
| 'four native wire codecs deliver pinned bodies once and preserve fixed prefix across turns' | KEEP |
| 'a new retained read appends without changing old reference ranges or text' | KEEP |

### `main-request.test.ts` — 13개 선언

preview=runner 실제 wire·current 1회·compiled execution 권한·memory/state/pinned slot·story.submit terminal·혼합/oversize 거부·continuation prefix·모델 capability·stop sequence·recoverable read를 유지해요. body 존재만 확인하던 NMR06은 제거했어요.

| 현재 case | 판단 |
|---|---|
| 'mock style settings never enter a custom prompt request or its host context' | KEEP |
| 'submission uses the compiled explicit decision; source provenance and familiar option names grant no tool' | KEEP |
| 'NMR01 preview route and runner use byte-equivalent encoder bodies, current once, no call during preview' | KEEP |
| 'NMR02 memory remains at its chosen user slot and dynamic host data is after the static cache prefix' | KEEP |
| 'NMR03 explicitly enabled terminal body completes once with host provenance and no tool-result round' | KEEP |
| 'NMR04 mixed terminal/read, foreign source identity and empty/oversized terminal contents fail without executing tools' | KEEP |
| 'NMR05 absent or false conditions omit submission; text fallback remains supported; evaluation owns its terminal' | KEEP |
| 'NMR07 tool continuation keeps the frozen host message and original cache bindings stable' | KEEP |
| 'NMR08 unreviewed model aliases do not inherit explicit cache or mid-system capabilities' | KEEP |
| 'NMR09 explicit state and pinned context slots have no duplicate host-envelope bodies' | KEEP |
| 'NMR10 Claude stop %s keeps the requested completion contract through the main runner' | KEEP |
| 'returns %s failure for correction without treating it as success' | KEEP |
| 'repeated invalid read with fresh call IDs exhausts correction before call budget' | KEEP |

### `memory.test.ts` — 8개 선언

관찰/믿음/author canon 출처와 quote, retcon 범위·checkpoint 구멍·긴 history 읽기·미처리 예산·필수 canon을 확인해요.

| 현재 case | 판단 |
|---|---|
| 'author-canon accepts a declaration with no transcript or fake message ID' | KEEP |
| 'beliefs retain actor and category; source-free observations, fake quotes, and future evidence fail' | KEEP |
| 'other chat, sibling, future and retconned memory is excluded from reads, search and counts' | KEEP |
| 'strict inputs reject extra fields, bad hashes, duplicates and nonserializable payloads' | KEEP |
| 'out-of-order completion cannot jump holes and a hash edit rewinds the watermark' | KEEP |
| 'long indexed history compacts input, preserves unprocessed tail and original sources, and paginates actual old text' | KEEP |
| 'oversized unprocessed tail is explicit and never silently truncated' | KEEP |
| 'author canon is mandatory even when it alone exceeds the packet budget; only derived memories may be omitted' | KEEP |

### `model-capabilities.test.ts` — 4개 선언

공식 검토 capability revision과 파라미터 허용/거부·cache TTL·economized generation 계약을 확인해요. 현재 외부 모델 품질/과금 증거가 아니에요.

| 현재 case | 판단 |
|---|---|
| 'exact model support differentiates efforts, thinking defaults, Fable always-on and Gemini sampling' | KEEP |
| 'unreviewed IDs do not inherit official capabilities and a saved capability revision is required' | KEEP |
| 'cache times are explicit, provider-specific, and incompatible with OFF' | KEEP |
| 'opt-in economy can lower effort but cannot change cache, tier, stop strings or enable reasoning' | KEEP |

### `model-required.test.ts` — 2개 선언

비 testMode에서 모델 없는 main/translation/candidate가 저장을 남기지 않고 차단되는지, 명시 testMode의 합성 허용을 확인해요.

| 현재 case | 판단 |
|---|---|
| `model-free generation is only available in explicit test mode (${testMode})` | KEEP |
| 'normal translation and candidate requests with no model roll back without mock jobs or output' | KEEP |
