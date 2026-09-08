# 저장소 slop audit · 2026-09-08

기준은 `main`의 `48e4a73`이며 시작 시 tracked/untracked 변경이 없는 작업 트리였어요. 저장소 전체의 실행 지도·설정과 주요 공통 경로를 조사하고, 아래 다섯 변경을 구현했어요. 모든 파일의 모든 분기를 검증했다는 뜻은 아니에요. 사용자 DB·인증·외부 모델·배포·push·릴리스는 사용하거나 변경하지 않았어요.

## 조사 범위와 우선순위

`AGENTS.md`, `docs/QUALITY.md`, `project-plan/CURRENT.md`, package scripts, TypeScript/Vite/Vitest/Playwright 설정과 CI를 먼저 확인했어요. 이전 기록의 PASS를 재사용하지 않고 변경 전 전체 검사를 실행했어요.

| 영역 | 확인한 경로와 판단 |
| --- | --- |
| 서버·저장 | `index → createApp → Store/ProductStore`, HTTP 입력 검증, 생성·보조 실행, source 수정·archive·분기·권한 소비자를 확인했어요. 기본 검증 때문에 저장소 전체에 의존하는 연결을 우선 정리했어요. |
| core·프롬프트 | 역할별 패키지 컴파일, main/translation 입력, PromptProgram 슬롯·고정 문맥, 원문 구간 파싱, 공급자 HTTP/SSE·continuation 경계를 확인했어요. 동일 호출 안에서 버려지는 재계산을 제거했어요. |
| web | Reader·TurnActivity·StoryPanel·useStory, lazy 패널, 업로드 편집기와 관련 브라우저 회귀를 확인했어요. 초안·보기 교체·늦은 응답을 보호하는 래퍼와 가드는 유지했어요. UI 소스 자체의 변경은 없어요. |
| 검증·도구 | build·doctor·공통 브라우저 실행기·milestone·worktree·로딩 측정·Node 테스트 검색과 cleanup/실패 판정 회귀를 확인했어요. 실제 설정 불일치와 누락된 테스트 발견 규칙을 고쳤어요. |
| 의존성·문서 | 직접 import뿐 아니라 CLI·빌드 플러그인·타입 패키지 사용도 확인했어요. 제거 근거가 있는 의존성은 찾지 못했어요. 현행 `QUALITY.md`의 검색·격리 설명만 갱신하고 과거 증거 문서는 보존했어요. |

## 구현한 변경

### P1 · 입력 검증의 중복과 저장소 순환 의존

`server/request-validation.ts`에 기존 `HttpError`, `record/fields/text/number`를 모으고 서버 소비자가 직접 참조하도록 바꿨어요. `app.ts`의 별도 객체·필드·문자열·정수 검증 네 개를 제거했어요. 새 모듈에는 import나 DB 접근이 없어요.

이전에는 오류 하나를 만들거나 요청 필드를 검사하려고 `store.ts`/`product-store.ts`의 저장소·archive 실행 그래프를 불러왔어요. 정적 runtime import/re-export 비교에서 `store.ts` 직접 소비자는 **36→1**, `product-store.ts` 직접 소비자는 **21→5**, 저장소 중심 순환 그룹은 **21→5개 모듈**로 줄었어요. 단순히 파일을 나눈 결과가 아니라, 필요 없는 역방향 실행 의존성과 중복 구현을 제거한 변경이에요. 동적 import·타입 의존성·전체 런타임 안전성을 이 수치로 보증하지 않아요.

기존 두 모듈의 export 경로는 같은 함수·클래스를 재export해 유지했어요. 따라서 기존 `HttpError instanceof` 처리도 같아요. `app.ts`는 기존 `RecordBody`의 unknown 경계를 유지해요. `isInteger`를 공통 `isSafeInteger`로 바꾼 모든 호출은 기존 최대값이 `Number.MAX_SAFE_INTEGER` 이하라 허용 입력은 같아요. 오류 코드·문구·순서, 원문 공백, 빈 값 옵션, 길이·정수 범위를 회귀로 확인했어요.

근거: [변경 전 import 그래프](../output/slop-audit-2026-09-08/import-graph-before.json), [변경 후](../output/slop-audit-2026-09-08/import-graph-after.json), [입력 검증 회귀](../tests/request-validation.test.ts). 그래프는 기준 커밋의 `core/server/web` 사본과 현재 코드의 최상위 TS/TSX 정적 상대 import를 비교했어요.

### P1 · 한 프롬프트 안의 반복 패키지 컴파일

`core/package-context.ts`, `core/provider.ts`, `core/auxiliary.ts`, `server/prompt-snapshot.ts`, `server/main-request.ts`를 정리했어요. 같은 패키지의 역할 문맥·catalog·슬롯·위치 지정 지침을 만들 때 이미 컴파일한 결과를 지역적으로 재사용하고, 같은 main input을 두 번 만들던 호출도 합쳤어요. 이름만 필요했던 전체 `packageSlots` 계산도 제거했어요.

패키지가 있는 새 프롬프트의 정적 호출 경로에서 `compileSnapshotPrompt` 내부 `compiledPackages` 실행은 **9→3회**, `buildMainInput`과 `translationInput`은 각각 **2→1회**예요. 패키지 검증·템플릿 컴파일·clone의 불필요한 반복을 줄였어요. 시간 벤치마크나 실제 모델 응답 속도를 측정한 결과는 아니에요.

전역 캐시나 우회 옵션은 추가하지 않았고 기존 함수의 매개변수·반환 형식을 유지했어요. 상태·추첨·옵션 변경은 다음 호출에 반영되고, missing revision은 계속 실패해요. 결과 공유 때문에 catalog와 pinned 메타데이터가 같은 객체를 가리키지 않도록 필요한 복사는 유지했어요. [회귀](../tests/package-context.test.ts)

### P2 · 원문 구간 번역 검증의 재파싱

`core/source-segments.ts`에서 이미 파싱한 `SegmentDocument`로 마커를 추출하도록 바꿨어요. 검증당 원문·번역 파싱은 **4→2회**예요. 서버 번역 결과 검증과 Reader의 번역 표시에서 같은 개선을 사용해요.

공개 함수·반환 형식·마커 순서·원문과 번역의 진단 순서를 보존했어요. 동일한 손상 텍스트라도 nested/unclosed 블록은 성공으로 처리하지 않는 회귀를 보강했어요. [회귀](../tests/source-segments.test.ts)

### P1 · 합성 검증기의 환경 설정 불일치

`scripts/lib.mjs`의 `localVerificationEnv`에 합성 실행의 공통 설정을 모아 `browser-verification`, `verify`, `verify-story`, `verify-ui`, `verify-worktrees`, `measure-loading` 여섯 곳에 적용했어요.

기존 `verify-ui`는 부모 self-host origin/host를 상속했고, 공통 브라우저 실행기와 로딩 측정은 부모 Codex 실행 설정을 상속했어요. 보강한 회귀로 **수정 전 실제 자식 프로세스의 Codex 실행 경로 상속 실패를 재현**했어요. 이제 loopback·임의 포트·test mode·빈 인증·Codex 비활성화를 한곳에서 유지해요. 등록 fixture origin과 실행별 DB·temp·브라우저 경로는 보존했어요. live/self-host 실행기는 별도 설정을 유지해요. [실제 spawn 경계 회귀](../tests/harness.test.ts)

### P2 · Node 테스트 검색의 파일별 예외 제거

`scripts/test-tooling.mjs`는 기존 `tests/*.node.test.mjs`와 특정 `doctor.test.mjs`만 실행했어요. 그 때문에 `scripts/memory-evaluation.test.mjs`의 고유 회귀 네 개가 전체 검사·CI에서 누락됐어요.

파일별 예외를 없애고 `scripts/*.test.mjs`도 자동 발견해요. 기존 파일·직접 실행 CLI·assertion을 유지하면서 corpus 결정성/hash, 답변·인용 위조, 중복 인용, 승인 없는 preflight 차단 검사를 기본 검사에 포함했어요. 이 네 검사는 변경 전 직접 실행해 모두 통과했어요. 전체 Node 검사도 **26→30개**로 늘었어요. 테스트 삭제·skip 추가·assertion 약화·설정 완화는 없어요.

## 검증과 처음 발견한 실패

| 단계·명령 | 실제 결과 |
| --- | --- |
| 변경 전 `npm run quality:full` | 최초 sandbox 실행은 quality·tooling PASS 후 build `spawn EPERM`으로 BLOCKED. 이전 dist 보존·cleanup PASS. 허용된 동일 로컬 실행에서 quality·tooling 26개·build PASS, Vitest **1,354 PASS / 기존 opt-in 1 skip**. |
| 입력 검증 선보강 → 구현 후 | 구현 전 새 계약 검사 3개 PASS. 구현 후 `vitest run tests/request-validation.test.ts tests/server.test.ts tests/product.test.ts tests/access-session.test.ts tests/archive.test.ts tests/library-deletion.test.ts tests/source-editing.test.ts tests/provider-selection.test.ts` **8파일 79 PASS**. 초기 통합 타입 오류 1건은 app의 기존 unknown 경계를 명시해 해결했어요. |
| 패키지 선보강 → 구현 후 | `package-context` 새 회귀 포함 9개를 변경 전 PASS. 구현 후 package-context/execution-context/lore-placement/main-request/custom-prompts/package-runtime/package-behavior-integration/package-behavior-run/transport **9파일 90 PASS**. |
| 구간 파싱 선보강 → 구현 후 | source-segments 새 회귀 포함 19개를 변경 전 PASS. 구현 후 source-segments/source-segments-reader/source-segments-integration/source-translation/translation-context/translation-auto-retry **6파일 61 PASS**. |
| 환경 격리 회귀 | 수정 전 Codex 설정 상속 FAIL 재현 → 수정 후 `vitest run tests/harness.test.ts` **21 PASS**. 일반·등록 fixture의 실제 자식 env, 부모 env 불변, origin 보존 확인. |
| 누락 검사 기준 | `node --test --test-isolation=none scripts/memory-evaluation.test.mjs` **4 PASS / skip 0**. |
| 통합 `npm run quality:full` | quality·tooling **30/30**·새 build PASS, Vitest **1,364 PASS / 기존 opt-in 1 skip**. [전체 로그](../output/slop-audit-2026-09-08/final-quality-full.log) |
| `npm run verify:redesign` | **163/163 PASS**, 실패·skip 0. [브라우저 summary](../output/playwright/redesign-2026-09-08T09-32-54-750Z-166271ce/summary.json) |
| `npm run verify:smoke` | **F02/F03/F06 PASS**. HTTP·SQLite·재시작·브라우저·의도적 실패 탐지 경로를 선택 실행했어요. [smoke summary](../output/playwright/2026-09-08T09-37-13-194Z-2abffe86/summary.json) |
| 최종 diff | `git diff --check` PASS. 별도 리뷰에서 입력 검증의 API·오류 identity·정수 범위 동등성을 확인했고, import 변경 소비자 **35개 파일의 나머지 실행 본문이 기준 커밋과 동일**함을 비교했어요. [본문 비교](../output/slop-audit-2026-09-08/import-migration-review.json) |

기준 로그는 [최초 환경 차단](../output/slop-audit-2026-09-08/baseline-quality-full.log)과 [변경 전 완료 결과](../output/slop-audit-2026-09-08/baseline-quality-full-authorized.log)로 구분해 보존해요. 관련 Vitest의 최초 `spawn EPERM`도 허용된 같은 로컬 명령으로 해소했어요. 차단되거나 실행되지 않은 단계를 PASS로 세지 않았어요.

## 보류·유지한 후보

| 후보 | 이유·다음 변경에 필요한 근거 |
| --- | --- |
| 남은 저장소 순환 의존 | package-start/product-store/provider-registration-store/source-editing/story-archive는 실제 snapshot·archive 검증 함수를 사용해요. 제거하려면 별도 책임 재설계가 필요하므로 이번 기본 검증 분리와 묶지 않았어요. |
| 프롬프트의 남은 3회 컴파일 | 1회까지 줄이려면 계층 간 사전 계산값을 받는 API가 늘어요. 이번에는 공개 호출 계약과 snapshot 검증 경계를 보존하는 선에서 정리했어요. |
| 공급자 canonical JSON/hash | OpenAI·Anthropic·Vertex의 복사·오류 타입·opaque 처리 경계가 달라요. continuation hash의 고정 벡터와 깊이·prototype 경계 테스트 없이 공통화하지 않았어요. |
| HTTP/SSE 수명주기 공통화 | fixture의 terminal 즉시 종료, native의 후행 usage, Vertex Flex, Responses JSON fallback, partial의 tool/opaque 제거가 달라요. 반복처럼 보여도 서로 다른 지원 동작이에요. |
| Reader의 추가 파싱 | 렌더 입력·검증 반환 계약, hash와 손상 시 원문 fallback까지 연결돼요. 추가 API 없이 안전하게 없앨 수 있는 검증 내부의 반복만 제거했어요. |
| 업로드 공통 훅 | 다중 파일 부분 성공과 단일 대표 이미지 지정은 취소·dirty 정책이 달라요. 많은 정책 콜백을 도입하면 복잡성을 다른 계층으로 옮기게 돼요. |
| key 래퍼·useStory 가드 | source/chat/branch 교체 시 초안·작업 상태 격리, A→B→A 탐색과 늦은 응답 제거라는 고유 역할이 있어요. |
| 약 60곳의 테스트 temp 정리 | sync/async 종료·close 실패 시 증거 보존이 달라요. 일괄 추출로 고유 cleanup 경계를 훼손하지 않도록 보류했어요. |
| 짧은 verify 진입점·retired live entry | 검사 선택·필수 증거·명시적 실행 차단이라는 책임이 있어요. 정적 검색이나 줄 수만으로 삭제하지 않았어요. |

## 최종 결과와 한계

최종 source/build는 `5dc97f0dc4e8c5df636908f0cd5f2bba43503f9cd63bb19941c6df2f801ffeb5`, dist는 `cd3c3391379e9a8432a3f6a91ffdcf6956773e579c58a833ee44a718ca56d128`이에요. 브라우저와 smoke 모두 같은 소스·빌드를 검증했고 cleanup PASS·남은 자식 PID 0·runtime 제거·합성 DB 증거 보존을 확인했어요. smoke는 기존 실행 절차에 따라 동일 소스를 다시 빌드했으며 dist 지문도 같아요. [종합 증거](../output/slop-audit-2026-09-08/FINAL-VERIFICATION.json)

원문 구간 번역의 [390px 화면](../output/playwright/redesign-2026-09-08T09-32-54-750Z-166271ce/browser/source-segments-browser-SE-34cab-e-current-translated-source/source-segments-translation-mobile.png)과 [1440px 화면](../output/playwright/redesign-2026-09-08T09-32-54-750Z-166271ce/browser/source-segments-browser-SE-34cab-e-current-translated-source/source-segments-translation-desktop.png)을 직접 열어 구간 순서·제목·펼침/접힘 표시와 본문 배치를 확인했어요. 전체 시각·접근성 감사나 실기기 검증을 대신하지 않아요.

저장 형식·공개 HTTP API·지원 환경·권한·취소·idempotency 계약을 변경하는 작업은 포함하지 않았어요. 기존 opt-in skip은 `NR_CODEX_PREFLIGHT=1`이 필요한 설치된 Codex 검사예요. 실제 공급자·청구·사용자 DB·휴대폰/IME·Linux/Docker·배포 검증은 실행하지 않았으며 로컬 합성 PASS로 대신하지 않아요. 두 실제 worktree를 새로 만들어 전체 검증하는 작업과 로딩 성능 재측정도 수행하지 않았어요. 이 문서의 검증은 커밋 전 로컬 작업 트리에서 수행했어요.

결과·로그가 있는 `output/`은 Git 제외 경로예요. 이 문서는 당시 근거를 남기며, 이후 소스가 바뀐 checkout의 통과를 보증하지 않아요.
