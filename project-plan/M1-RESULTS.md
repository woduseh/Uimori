# 번역 단순화와 직접 편집 · 2026-09-07

번역은 **번역 보기**를 눌렀을 때 시작하고 최신 내용 하나만 표시해요. 원문·번역을 직접 고쳐 저장할 수 있으며 저장 자체는 모델을 호출하지 않아요. 정상 종료된 번역 거절·빈 응답·구조 손상은 완료 구간을 보존하며 구간별 최대 3회 및 전체 호출 한도 안에서 재시도해요. 불확실한 실행·HTTP 오류·취소·한도 초과는 자동 재생하지 않아요.

원문 수정은 source_edits와 contentHash로 과거 Run 입력을 보존하며 앞으로 생성할 입력에 반영해요. CAS와 worker ownership/generation으로 다중 탭 충돌·늦은 결과를 방어하고, 손상된 캐시는 다음 명시 번역 요청에서 재생성해요. v2 migration 백업·자동 예약 중단·v2/v3 archive·포크의 수정본 독립성까지 검사했어요. 이 기능은 M2 기억·상태의 의미적 재계산을 대신하지 않아요.

타입 검사·빌드, 전체 Vitest **487/487**, M0 **13+3**와 selftest **11**, M1-local **55+6**, UI **9+19** PASS예요. 실패·required skip 0, source/dist 동일, 서버 cleanup PASS예요. [최종 근거](../output/translation-final/2026-09-07/summary.json), [M0](../output/playwright/2026-09-07T01-09-06-627Z-eea61d15/summary.json), [M1-local](../output/playwright/2026-09-07T01-10-22-890Z-db8208e6/summary.json), [UI](../output/playwright/ui-2026-09-07T01-11-15-192Z-ef48f575/summary.json). 추가 유료 호출은 **0회**이고 기존 49회 기록을 보존해요.

아래는 번역 단순화 이전의 역사적 결과예요. 과거 자동 번역·버전 UX 설명을 현재 동작으로 해석하지 않아요.

# 포크 간략화 후속 · 2026-09-07

사용자의 최종 지시에 따라 기본 사용 흐름을 **선택 원고까지 복사 → 독립된 새 이야기에서 이어 쓰기**로 변경했어요. 원문과 완료된 번역·상태·이미지를 새 ID/anchor로 복사하고 설정과 프롬프트 선택은 새 Chat에 독립 저장해요. 불변 콘텐츠 revision 참조는 공유하며 과거 본문이나 비용을 다시 생성하지 않아요. 대기·실패·부분 작업과 기존 provider attempt는 복사하지 않아요. 원본 행·분기·후손은 그대로 남아요.

전체 Vitest 457/457, M1-local 55+6, UI 7+16, 타입 검사·빌드 PASS예요. 두 검증의 source/dist가 같고 실패·required skip 0, cleanup PASS예요. [최종 근거](../output/fork-final/2026-09-07/summary.json), [M1-local](../output/playwright/2026-09-07T00-34-39-681Z-85e08186/summary.json), [UI](../output/playwright/ui-2026-09-07T00-35-24-644Z-0465468d/summary.json). 포크 동작의 새 서버 테스트 6개와 응답 유실/지연·원본 및 초안 보존·모바일 브라우저 검증을 포함해요. 추가 유료 호출은 0회예요.

기존 후보/분기 기록은 **보관된 전개** 목록에서 한 번 눌러 읽고, 새 포크는 좌측 이야기 목록에 나타나요. 옛 후보 UI에 의존하는 `verify-live-journey.mjs` 및 브라우저 여정 두 진입점은 `LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED`로 인증·DB 복사·모델 호출 전에 중단하도록 했어요. 기존 실행 증거와 다른 직접 연결·명시적 재시도 검증기는 보존해요. 품질 튜닝이나 실제 여정을 재개하지 않았어요.

아래는 포크 변경 이전의 공급자·프롬프트·실제 여정 기록이에요. 이전 source ID와 후보 UI 설명을 현재 사용 흐름으로 해석하지 않아요.

# M1 Flex·추가 공급자·사용 여정 후속 · 2026-09-07

총 1000회·USD 100의 기존 요청 포함 시험 한도를 적용했어요. 새 실제 호출은 Vertex Gemini 3.8 Flash Flex이고, OpenAI·Anthropic·Vercel·별도 Chat 호환 연결은 구현과 로컬 검증을 마쳤어요. 실제 사용자 여정에서 발견한 입력·후보 UI와 번역 문맥·긴 HTTP 대기를 보완했어요. 이후 사용자 지시에 따라 품질 실험을 종료하고 작문·번역 프롬프트의 전체 편집 및 요청·응답 검증으로 범위를 정리했어요.

## 사용자 프롬프트와 검증 범위

작문·번역 지침을 전체 편집하고 역할별 프리셋으로 저장·선택해 기본 본문을 교체해요. 공백·빈 본문도 보존하고 기본 사용을 별도로 구분해요. 수정은 새 revision을 만들며 실행·후보는 당시 버전을 유지해요. 명시적 재번역은 현재 번역 지침을 새 작업에 고정하고 실패 구간 재시도는 원래 지침을 유지해요. RisuAI CBS/typed-item 실행기 전체를 가져오지 않았어요. 원문·도구 권한·결과 JSON/anchor 검증은 유지해요.

추가 유료 품질 튜닝은 하지 않아요. 실제 API의 수신·도구 왕복·응답 저장은 아래 기존 49회 기록에 보존하고, 새 사용자 지침 기능은 실제 로컬 HTTP 요청 본문·응답과 파일 SQLite·브라우저에서 확인해요.

## 연결과 사용 경험

- OpenAI Responses, Anthropic Messages, Vercel AI Gateway, 별도 OpenAI Chat Completions 호환 연결을 추가했어요. 네이티브 tool ID·reasoning continuation·stream terminal·usage·translation schema를 각각 처리하고, 지원하지 않는 옵션·거절·끊긴 응답을 다른 공급자로 자동 재시도하지 않아요. 실제 외부 호출은 사용자 지시에 따라 Vertex에서만 수행했어요.
- Flex의 두 요청 헤더와 900초 서버 대기를 보냈고 완료된 응답에서 `ON_DEMAND_FLEX`를 확인해요. 과거 Standard ledger는 바꾸지 않아요. 전체 예약은 유지하고 확정된 Flex usage만 공개 gross 단가로 추정해요. 다른 공급자의 가격과 USD 예산 보장은 제공하지 않아요.
- 봇·페르소나·저장한 프리셋에서 이야기를 시작할 때 본문·한국어 번역 모델까지 함께 선택하고 다음에 불러와요. 별도 설정 이동·반복 선택을 줄였어요. 긴 OOC 제출 후 비워진 입력이 기본 높이로 돌아오고, 모바일 후보 목록은 구별되는 이름·한국어 미리보기를 제공해요. [실제 before/after·UI 회귀](UI-RESULTS.md#2026-09-07-m1-사용-여정-후속)에 근거를 남겼어요.
- 번역은 원문 시점 bot/persona/작가 사실/용어집을 이미 사용해요. 같은 원문에서 앞서 완료된 번역 최대 2구간·6000자도 다음 요청에 자동으로 전달하게 했어요. 별도 계획 호출을 추가하지 않고 기존 source/plan/snapshot과 완료 구간을 유지해요.
- 실제 Flex 번역 두 건은 900초 설정에도 약 304초 뒤 `TRANSPORT_ERROR`였어요. HTTP 클라이언트의 기본 300초 headers/body 제한을 로컬 가상 시간으로 재현해 보완했어요. 기존 두 오류는 cause가 없어 정확한 원인을 확정하지 않아요. 요청 전체 deadline·취소·stream 정리는 그대로 유지해요.

## 확인된 실행과 보존한 실패

| 확인 | 결과와 증거 |
| --- | --- |
| 전체 프롬프트 최종 검증 | [최종 summary](../output/prompt-final/2026-09-07/summary.json): 타입/빌드, 전체 Vitest 449/449, [M1-local](../output/playwright/2026-09-07T00-01-13-720Z-31c00d08/summary.json) 55+6, [UI](../output/playwright/ui-2026-09-07T00-03-29-151Z-739aba94/summary.json) 7+16 PASS. 5 native adapter의 실제 localhost 요청·응답 20회에서 커스텀/빈/100,001자 본문 전달을 검사했어요. 추가 유료 0회, 원문·프롬프트 버전·후보·재번역/재시도·archive·저장만으로 0호출도 확인했어요. 마지막 수정은 브라우저 테스트의 기존 한국어 409 안내 기대값뿐이라 M1/전체 unit과 최종 UI의 source ID는 다르지만 compiled dist `03ba8360…`은 같아요. |
| 공급자/UI 통합 로컬 | 전체 Vitest 382/382 PASS [reporter](../output/playwright/provider-integration-2026-09-07T07-56-29/vitest.json). [M1-local](../output/playwright/2026-09-06T23-00-04-553Z-19c75950/summary.json) 55+6, [UI](../output/playwright/ui-2026-09-06T23-00-39-159Z-8da8144c/summary.json) 7+14 PASS. 이 기록은 이후 번역 문맥/HTTP 수정 전 빌드예요. |
| 기존 장문 마지막 실패 구간 | [Flex 명시적 재시도](../output/live/live-retry-2026-09-06T23-01-49-317Z-51214620/summary.json) PASS. 추가 요청 2회로 총 22회, 기존 2,004단어 원문 번역 5/5구간 완료. 이전 20회·완료 4구간·원본 DB/WAL·source/snapshot 유지. |
| 실제 앱 첫 장면 | [실제 여정](../output/live/live-journey-2026-09-06T23-04-47-284Z-5d368e56/browser/journey-summary.json): 모바일 봇·페르소나·프리셋 저장과 이야기 생성, 1,168단어·3구간·17 anchor·한국어 3,596자 완료. 초안과 독서 위치 3148→3148 복원, 보기 이동 추가 호출 0. |
| 이어 쓰기 번역 실패 | 같은 여정은 원문 완료 뒤 번역 2구간 `TRANSPORT_ERROR`로 FAIL이에요. [원 summary](../output/live/live-journey-2026-09-06T23-04-47-284Z-5d368e56/summary.json)를 보존해요. 원래 검증기가 status mock 2개를 Flex HTTP로 오인한 별도 오류도 남겼어요. [독립 후검증](../output/live/live-journey-2026-09-06T23-04-47-284Z-5d368e56/postflight.json)은 검증 PASS/여정 INCOMPLETE, 신규 Vertex 13+로컬 mock 2, 누적 Vertex 35회, prior 22회·원문·DB/WAL 보존·실제 비Vertex 호출 0을 확인했어요. |
| 번역 품질 관찰 | [수정 전 수동 관찰](../output/live/live-journey-2026-09-06T23-04-47-284Z-5d368e56/quality-before.json): Arlen 표기와 Mira 높임말이 구간별로 변했고 oilskin coat의 국소 오역을 발견했어요. 큰 사건 누락과 여행자의 현재 응답·결정 침범은 이 표본에서 찾지 못했어요. 전체 품질 PASS로 사용하지 않아요. |
| 이어 쓰기 복구와 사용자 지시 중단 | [후속 여정](../output/live/live-journey-2026-09-06T23-39-46-321Z-f08c44ac/summary.json): 실패했던 두 구간만 명시적 재시도로 완료했어요. 기존 완료 구간을 보존했고 1,435단어 원문 번역 3/3구간·25 anchor를 확인했어요. 후보 원문 생성 후 사용자 방향 변경에 따라 진행 중 번역을 취소해 전체 결과는 FAIL/INCOMPLETE로 보존해요. 첫 원문 재번역 품질 실험은 실행하지 않았어요. cleanup PASS, 추가 실제 비Vertex 호출 0이에요. |

누적 실제 Vertex 요청은 **49회**이며 마지막 실행의 신규 14회에는 Flex 요청 헤더를 사용했어요. 예산 계산은 관측 usage 추정 **$0.81960975**와 불확실한 6회 전체 예약 **$12.386304**를 합한 **$13.20591375**예요. 실제 청구액은 미확인이며 모든 `costUsd=null`을 유지해요. 이 금액을 실제 소비액으로 표현하지 않아요. 이후 프롬프트 편집 검증에서 유료 호출을 추가하지 않아요.

## 현재 한계

실제 추가 공급자 네 종류의 인증·모델별 호환성은 사용자가 확인해요. 실제 휴대폰 IME·키보드·백그라운드·외부 접속은 검사하지 않았어요. Q01/Q02/Q03/Q05 전체 품질과 M1 전체 완료로 표시하지 않으며 M2는 시작하지 않았어요. 원문 거절·실패는 정상 작품으로 커밋하거나 후속 비용을 자동 발생시키지 않는 기존 경계를 유지하고, 임의 대체 작품의 의미 판별을 완전히 자동화했다고 주장하지 않아요.

## 이전 Standard 20회 결과 · 역사적 기록

아래의 '추가 승인 대기'와 20회·USD 50 한도는 그 당시 상태예요. 이후 사용자가 총 1000회·USD 100·새 호출 Flex를 승인했고 위 결과가 현재 상태예요. 원 실패를 PASS로 바꾸지 않아요.

# M1 실제 연결 후속 · 2026-09-07

**Vertex AI global · `gemini-3.8-flash`의 main/translation 연결을 구현하고 실제 합성 요청 20회를 검증했어요. 짧은 생성·읽기 도구·후보·취소·재시작 보존은 통과했고 장문 번역은 4/5구간 완료 후 요청 수 한도에서 차단됐어요. 마지막 한 구간의 추가 호출 승인 대기이며 M1 전체 완료는 아니에요.**

## 구현과 수정

- 네이티브 REST/SSE adapter와 공식 google-auth-library 11.0.2를 통한 서버 인증을 추가했어요. global endpoint·정확한 모델 ID·thinking/timeout을 검증하고 generation의 자동 retry/redirect 없이 fixture를 유지해요. 키 내용은 복사·출력하지 않았어요.
- main/translation의 역할 계약·창작 제어·source/history/catalog·function declarations/results를 연결했어요. 같은 실행의 전체 provider model parts와 signature를 유지하고, ID/name으로 tool 결과를 엄격히 대응해요. opaque/signature/thought 본문과 인증 값은 진단에서 숨겨요.
- 같은 DB의 모든 Vertex attempt를 합산해 요청·금액을 예약하고 attempt를 저장한 다음 fetch해요. 후보·번역·도구 왕복·재시도·재시작이 같은 한도를 사용해요. 원 API 비용은 null로 보존해요.
- 기존 경계의 두 결함을 실패 회귀로 재현해 수정했어요. 반복 tool ID는 전체 왕복에서 거부하고, 취소 직전 기록된 usage는 cancelled run에 한 번만 보존하되 원문 커밋은 막아요. 스트림 abort 전파 누락 시 명시적으로 reader를 취소해 대기를 해제해요.
- 첫 실제 번역에서 네 응답이 외부 JSON 코드 펜스로 실패했어요. 펜스만 제거해 재검사해도 새 숫자 표기 때문에 기존 보호구문 검증에 실패했어요. Vertex translation에 native JSON schema와 한국어 수사 지시를 추가했어요. 원래 source identity·snapshot·plan·보호구문 검증은 유지했어요. 수정 후 실제로 재실행한 세 구간은 모두 통과했어요.

## 로컬 검증

| 검증 | 결과 | 증거와 빌드 경계 |
| --- | --- | --- |
| 최종 전체 Vitest | 181/181 PASS, 실패·skip 0 | [summary](../output/vertex-local/2026-09-07-live-ready/summary.json), [reporter](../output/vertex-local/2026-09-07-live-ready/vitest.json), source `7499453fe47f13facc7816b6d1160159465e59645e44ba048d38bc8c6066df6d` |
| 수정 후 M1-local | P01–P13 PASS, Vitest 55·Playwright 5, cleanup PASS | [summary](../output/playwright/2026-09-06T22-03-52-076Z-09e9ae39/summary.json), source `a287e5c832b3236ba6e4d776d280448c063fd3334f5f67eaa7a54c4668953c53` |
| 수정 전 M0·UI 회귀 | M0 13·3와 selftest PASS, UI 7·10 PASS | [M0](../output/playwright/2026-09-06T21-46-29-670Z-79b1c274/summary.json), [UI](../output/playwright/ui-2026-09-06T21-48-05-871Z-3c8f0d3f/summary.json), source `fc267b1…`; 번역 스키마 수정 전 기록 |

타입 검사와 빌드를 통과했어요. 현재 빌드 `91fea8192875d32c471be2f3d261edf3950754a864a4869f179fb0903df43b98`는 재시도 검증기의 WAL·명시적 추가 한도 처리까지 포함해요. 현재·최종 전체 Vitest·수정 후 M1-local의 **compiled dist SHA-256은 모두 `bdb1bce1147557e84a8c6e7de18f0b572fb40cb473fc5d170c301f5b4355ba70`로 같아요.** 검증기 수정 때문에 source ID는 다르며 동일 source로 표현하지 않아요. 각 검증의 중복 테스트 수를 더하지 않아요.

390px 브라우저에서 Vertex 설정 저장과 main/translation thinking·timeout·revision, 설정만으로 실행 0을 확인했어요. 실제 공급자 429·refusal·EOF·잘림·timeout·반복 ID는 로컬 HTTP/fixture로 검증했으며 유료 환경에서 각각 재현했다고 주장하지 않아요. 중간 abort 대기 실패는 [실패 보고서](../output/playwright/2026-09-06T21-35-23-353Z-d3c20619/summary.json)에 보존해요. 하위 런타임 원인을 GC로 확정하지 않아요.

## 실제 API 결과

| 시나리오 | 관측 |
| --- | --- |
| 짧은 생성 | 도구 없이 184단어 원문 완료 |
| 로어·스킬 조회 | `knowledge.read`와 `skills.load`의 실제 function-call/result 왕복 후 원문 완료 |
| 장문·번역 | 원문 2,004단어·11,691자·14개 anchor·5구간. 첫 실행 1/5, 수정 후 명시적 재시도로 4/5 완료. 마지막 구간은 새 fetch 전 요청 수 한도에서 차단 |
| 후보·원문 귀속 | 현재 profile 변경 후에도 원래 snapshot을 사용하고 독립 candidate branch/source에 귀속 |
| 취소 | attempt 이후 취소 상태·unknown usage를 보존하며 새 원문을 커밋하지 않음. 원격 과금 중단을 보장한다는 뜻은 아님 |
| 재시작·재연결 | 실제 서버 프로세스/HTTP origin을 바꿔 원문·후보·실패·취소 기록과 12회 호출 수를 보존. 추가 자동 요청 0 |

[첫 실행](../output/live/live-2026-09-06T21-49-04-899Z-f6a5a7d1/summary.json)은 **FAIL** 기록으로 보존해요. [명시적 재시도](../output/live/live-retry-2026-09-06T22-07-29-850Z-3da9d0c9/summary.json)도 **FAIL/partial** 기록이며 실제 원인은 `AUXILIARY_PROVIDER_LIVE_REQUEST_BUDGET_EXHAUSTED`예요. schema를 수정한 세 구간은 모두 기존 검증을 통과했고 마지막 구간은 수정 후 실행 기회를 얻지 못했어요. 기존 실패 응답을 고쳐서 성공 artifact로 사용하지 않았어요.

재시도는 닫힌 SQLite **DB+WAL**을 복사해 기존 12회 ledger를 이어받았어요. 이전 원문/hash·snapshot·성공한 구간 row·12개 attempt가 그대로인지 비교했어요. 원본 DB와 WAL의 전후 SHA-256이 각각 같으며 첫 실패 증거를 checkpoint하거나 덮어쓰지 않았어요. 원본 DB 단독 4,096 bytes의 hash만으로 전체 상태를 보존했다고 판단하지 않아요. 시험 서버는 모두 종료했고 사용자 `.local/narrative.sqlite`는 열거나 변경하지 않았어요.

총 20회 중 usage를 관측한 19회의 input은 68,811 tokens, output+thoughts는 60,761 tokens예요. 모든 실제 `costUsd`는 null이에요. 공개 gross 단가 추정 **$0.558924**와 미확인 취소 1회의 전체 예약 **$2.064384**를 합한 예산 계산액은 **$2.623308**이에요. 이는 실제 청구액이 아니에요. 승인된 총 USD 50보다 작아도 별도 요청 수 상한 20회에 도달하면 추가 요청을 막아요.

장문은 요청한 1,500–1,800단어 범위를 초과했어요. 장문 전송·분할·원문 귀속 검증에 사용했지만 분량 준수나 문학·번역 의미 품질의 합격으로 취급하지 않아요. 합성 자료만 사용했어요.

| 전제 | 현재 상태 |
| --- | --- |
| L01 선택한 실제 API | PARTIAL — 선택한 main·도구·번역 구간 경로 확인. 번역 5/5 완료는 마지막 한 구간의 추가 승인 대기 |
| L02 실제 폰 접속 | BLOCKED — 이번 후속 범위 밖 |
| Q01/Q02/Q03/Q05 품질 | 미평가 — 구조/실행 성공이 품질 합격을 뜻하지 않음 |
| M2 | 시작하지 않음 |

연결·재시도 방법은 [README](../README.md#vertex-ai-연결과-합성-시험), 공식 API와 Provider Manager/Gemini CLI의 source·직접 테스트·채택/비채택은 [SOURCES](SOURCES.md)에 있어요.

## 이전 M1 로컬 완료 기록 · 보존

아래 수치·빌드·남은 전제는 2026-09-06 당시 기록이에요. 현재 상태는 위 후속 결과를 기준으로 읽어요.

# M1 로컬 구현 결과 · 2026-09-06

**M1a/b/c에서 외부 전제에 의존하지 않는 로컬 흐름을 구현했고 P01–P13 로컬 검증이 통과했어요. M1 전체 완료·실서비스 사용 준비 완료는 아니에요.** 사용자 provider/API/model 선택과 시험 예산이 없어 현재 adapter는 자체 loopback `fixture-sse-v1`이에요. 실제 provider, 문학·번역·이미지 선택 품질, 실제 휴대폰 접속은 BLOCKED로 남아요.

## 구현한 동작

- 콘텐츠: bot/persona/lore/author-canon/skill/glossary 편집과 immutable revision 장착. 보관된 revision도 화면에서 확인해요. Native 창작 제어와 CreativePreset 전체 그룹 교체, 비활성 15000 제외, OOC의 소설 작가 지시 범위를 분리했어요.
- 모델 경로: 연결·모델 프리셋·카탈로그·수동 ID와 역할별 main/translation/status/image 선택. HTTP/SSE의 UTF-8·JSON·tool 조각, call ID, opaque 왕복, refusal·usage·EOF·timeout·cancel을 처리해요. 호출 전 최신 연결 권한을 확인하고 진단에는 비밀키나 opaque 본문을 남기지 않아요.
- 읽기: 메인은 고정 계약·작가 사실·목록·도구 결과를 분리해요. 번역은 원문 시점의 bot/persona/canon/용어집을 사용하고 추가 scoped read를 할 수 있어요. 지침을 읽어도 권한이 늘지 않아요.
- 파생물: 번역 chunk의 anchor coverage·순서·중복·보호구문을 검사해요. 완료 구간을 보존하고 실패 구간 하나 또는 미완료 전체를 명시적으로 재시도해요. 재번역은 새 job revision이며 이전 결과를 보존해요. 표시 상태와 이미지 annotation은 원문/정사에 합류하지 않아요.
- 분기: 같은 요청의 후보는 원래 실행 snapshot과 parent를 재사용해요. 각 후보의 후손을 따로 이어가며 branch head는 expected revision을 검사해요. 보기·초안·독서 위치는 탭별로 유지해요.
- 에셋: 기존 소형 PNG/JPEG와 host의 합성 SVG를 profile/inline으로 표시해요. 이미지 역할의 결과는 source/hash/anchor/asset revision/용도/장면 metadata를 검사해요. 적합한 이미지가 없으면 빈 annotation도 정상이에요.
- 보존·접속: schema v1→v2 이전에 populated DB의 일관 백업을 만들어요. JSON export는 새 빈 DB에 복원하며 hash·참조·계보·파생물·보호구문을 검증해요. 원격 연결과 비밀키 참조는 복원 시 해제해요. SQLite 백업은 실제 bytes를 새 파일에 열어 검증했어요. 선택적 단일사용자 HttpOnly 세션은 API·SSE·이미지를 보호하고 로그아웃은 기존 이벤트 연결도 끝내요.
- 사용량: 원문·보조·후보·재시도를 호출별로 기록하고 unknown 비용을 0으로 계산하지 않아요. 중복 완료가 기록된 usage를 덮지 않아요. 불확실한 provider 요청은 자동 재호출하지 않아요.

## 최종 검증

같은 source/build identity에서 다음 두 명령이 통과했어요. Windows 11, Node 24.14.0, npm 11.14.1, Node SQLite 3.51.2, 실제 Chrome을 사용했어요. 검증 DB·포트·브라우저는 전용으로 분리했으며 사용자 `.local/narrative.sqlite`는 열거나 변경하지 않았어요.

| 명령 | 결과 | 증거 |
| --- | --- | --- |
| `npm run verify -- --milestone M0` | F01–F06 PASS; Vitest 13, Playwright 3, 검증기 selftest 11 | `output/playwright/2026-09-06T12-37-13-274Z-9922fc39/summary.json` |
| `npm run verify -- --milestone M1-local` | P01–P13 로컬 PASS; Vitest 38, Playwright 4 | `output/playwright/2026-09-06T12-39-38-385Z-71d8eb1d/summary.json` |

필수 skip/실패 0, source/build 종료 전후 일치, 소유 프로세스·임시 DB 정리 PASS예요. known synthetic secret canary 검사도 PASS이며 임의의 모든 비밀 탐지를 뜻하지 않아요. M0의 두 clean 작업트리 검증은 이전 M0 commit의 증거이고, 이번 M1 변경에서 두 작업트리를 다시 검증했다고 주장하지 않아요.

- source/build ID: `48e7f8e9fa3c13129c1775427996ff64f4c6d6bc22a6de7bea40e4b85d15185f`
- dist SHA-256: `46a6d46866c08c22280d62c7d86da6089fb11be426a0924a2f27f0d81eb8bda3`
- Inspector·wire·usage·source/chunk 기록: 각 실행의 `vitest.json`, `playwright.json`, `evidence-db/` 및 테스트 코드의 독립 assertions
- 모바일 너비 화면: M1 실행의 `browser/product-browser-P09-P10-P1-1766b--separate-image-annotations/m1-mobile-reader.png`

실제 앱 통합 시험은 원문 5700자→번역 세 구간→중간 구간 실패→partial 두 구간 보존→지정 구간만 재시도→세 구간 완료를 통과했어요. 기다리는 동안 용어집을 v2로 수정해도 원래 v1 맥락이 유지됐어요. 원문 1회와 번역 5회(도구 왕복·실패·재시도 포함)의 기록 및 unknown 비용을 확인했어요.

복원 시 입력 archive 변조, 원문 cycle, 다른 채팅의 parent/head/job, 바꿔치기한 snapshot/plan/보호구문, active image MIME을 실제 새 파일 DB에서 거절하고 전체 rollback했어요. 스키마 1의 기존 완료 번역 FK와 백업도 보존했어요. 초기 개발 단계에서 발견한 복원 입력 변조/cycle 실패는 수정 후 통과했으며 원래 실패를 합격 증거로 취급하지 않아요.

## 남은 전제와 한계

| 주장 | 상태와 필요한 정보 |
| --- | --- |
| L01 실제 provider/API | BLOCKED — 메인·번역 provider/API 방식/model ID, 서버 credential, 요청 수·총금액 예산 필요 |
| L02 실제 폰 접속 | BLOCKED — 승인된 비공개 접속 환경과 실제 휴대폰 필요; 현재 서버는 loopback만 바인딩 |
| Q01/Q02/Q03/Q05 | BLOCKED — 선택한 실제 모델과 승인된 표본으로 창작·거절·번역·표현 품질을 따로 평가해야 함 |

소형 이미지의 장면 적합성 검사는 metadata 어휘를 기반으로 해요. 의미 판정·vision을 증명하지 않아요. 원문/번역 anchor coverage도 번역 의미 정확성을 증명하지 않아요. 기본 scripted mock은 콘텐츠와 관계없이 합성 문장을 만들 수 있으므로 실제 창작 품질로 읽으면 안 돼요. 자동 장기기억·authoritative state·원문 retcon·CBS/Lua 호환·수천 에셋 성능은 이번 M1 로컬 범위가 아니에요.

다음 단계는 사용자가 선택한 메인·번역 연결의 실제 adapter를 추가하고 승인된 예산으로 L01을 수행하는 일이에요. 그 전에는 유료 호출이나 외부 배포를 시작하지 않아요.
