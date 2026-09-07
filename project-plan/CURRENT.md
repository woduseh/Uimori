# 현재 작업 상태 · Uimori

## Sol Responses 추가 provider 완료 · 2026-09-07

- M1·M2 담당과 인계·소스 소유권을 조율하고 `sol-responses-v1`을 공용 root에 통합했어요. 설정의 **Sol · Responses**에서 세 게이트웨이와 모델 옵션을 등록하며 본문·번역·state/memory에 사용할 수 있어요. [연결과 사용법](SOL-RESPONSES.md), [구현·검증 결과](SOL-RESULTS.md).
- 최종 전체 Vitest **598/598**, M0 **13+3**와 selftest **11**, M1-local **55+6**, M2-local **78+4**, 기존 UI **9+19**, Sol UI **2** PASS예요. 브라우저 총 **34개**, 실패·required skip 0, 검증 서버 5개 cleanup PASS이며 동일 source/dist를 확인했어요. [최종 근거](../output/sol-provider/2026-09-07/summary.json).
- source/build `881ae5a7ea83909a77556f7d2cbb5c6341f345388d8294c775db5161d5ded63c`, dist `527639a18db32e4d8c27014623d30a3aa7b537fb8d40ade8d11257f755f5ec20`. [고정 소스](../output/sol-provider/2026-09-07/source/README.md).
- 추가 유료 호출 0회, 사용자 DB와 기존 변경·증거 및 preview 50695/54490을 보존했어요. 두 미리보기는 이전 고정 빌드이므로 Sol은 root의 `npm run dev`로 사용해요. 실제 Sol 계정·모델·청구·품질과 원본 프롬프트의 행동 동등성은 확인하지 않았어요. 기존 M2 외부 전제와 M3 전체 인수는 별도이며 commit/push/deploy는 하지 않았어요.

## 이전 M2 로컬 완료 기록 · 보존

- 2026-09-07 요청의 **M2 상태·기억·표현 로컬 구현과 통합 회귀를 완료했어요.** M1 담당과 인계·독립 검토를 진행하고, 상태/기억/표현 구현은 GPT-6 Astra Medium 서브 에이전트에 나눴으며 공용 저장·실행·통합 설계는 메인에서 담당했어요.
- 상태 proposal/reducer, authoritative 다음 턴 대기, continuity 부모 상태 의존성, 원문·retcon의 파생물 무효화/복구, 장기 checkpoint와 원문 회수, 작가 선언/믿음 분리, 장면 예약, 과거 상태창·제한 regex·에셋 manifest를 연결했어요. 기존 최신 번역·직접 수정·포크를 보존했어요.
- 최종 검증: 전체 Vitest **567/567**, M0 **13+3**, M1-local **55+6**, UI **9+19**, M2 **78+4**, 검증기 selftest **11** PASS예요. 네 검증 서버 cleanup PASS, 실패·required skip 0이고 source/build `f1bd1f6aa5914f1519d5a0c4ce8ca692f496ffde71c74c01b1666225f8fdfaec`, dist `4e60cc3d37a17a9040b0f8cdecfb457775dae69b57d09ebc4d2d32f7220ebc89`가 같아요. [최종 근거](../output/m2-final/2026-09-07/summary.json), [M2 구현·범위](M2-RESULTS.md).
- 전체 M2는 **BLOCKED**예요. Q04의 실제 장기 의미 품질·비용 평가와 대상 사용자 봇의 native 포팅이 남아요. 대상 봇 이름·로컬 경로를 요청했으며, M2 유료 평가에는 별도 모델·자료·요청 수·USD 범위가 필요해요. 합성 통과로 실제 모델·기존 봇 대체를 주장하지 않아요.
- 확인용 앱: [M2 합성 상태·기억 화면](http://127.0.0.1:54490/?chat=45ba128d-054a-466c-ac08-502b5a6236d2&branch=main%3A45ba128d-054a-466c-ac08-502b5a6236d2). 별도 synthetic DB와 고정 dist이며 provider 연결 0개·허용 origin 빈 목록·test controls 404를 확인했어요. [소유권](../output/m2-final/2026-09-07/preview/manifest.json). 기존 50695 M1 미리보기와 사용자 .local DB는 보존했어요. 추가 유료 호출 0회, commit/push/deploy는 하지 않았어요.
- 공용 코드는 M1 snapshot과 파일별 비교 후 통합했고 원래 변경은 [백업](../output/m2-pre-integration/2026-09-07T01-51-45.837Z)에 보존했어요. 병행 Sol Relay 작업은 별도 격리본에서 진행하며 이 고정 M2 snapshot을 인계 기준으로 사용해요.

## 이전 M1 번역·편집 완료 기록 · 보존

- 기준: 2026-09-07 사용자 요청의 **최신 번역 하나·번역 보기에서 시작·실패 시 제한 자동 재시도·원문과 번역 직접 수정**을 구현하고 검증했어요. 기존 포크·전체 프롬프트 편집·공급자 연결을 보존했어요. M2는 별도 작업에서 진행하며 이번 결과에 포함하지 않아요.
- 사용 흐름: 번역이 없으면 원문부터 보여 줘요. **번역 보기**를 눌러 시작하며 새로고침·이야기 이동·언어 설정 변경만으로 호출하지 않아요. 정상 저장 번역은 0호출로 재사용하고 번역 버전 선택을 제거했어요.
- 수정: **원문 수정 / 번역 수정**에서 직접 저장해요. 모델 호출 없이 최신 내용을 반영하며 편집 초안·실제 409 충돌·늦은 결과 덮어쓰기 방지를 확인했어요. 원문 수정은 기존 번역을 무효화하고 다음 명시 번역과 새 작문 이력에 반영해요. 과거 실행 입력과 생성 당시 원문은 내부 hash 이력으로 보존해요.
- 자동 복구: 정상 종료가 확인된 번역 거절·빈 응답·구조 손상에 한해 해당 구간을 최대 3회 시도해요. 전체 호출 한도와 완료 구간·attempt 기록을 유지하고 시간 초과·연결 단절·HTTP 오류·취소·한도 초과는 자동 재생하지 않아요.
- 저장: schema v3 source_edits, 과거 snapshot 불변, CAS/owner/generation, v2→v3 일관 백업·이전 자동 대기 번역 중단, v2/v3 archive·포크 수정본 독립성을 확인했어요. 사용자 .local DB는 열거나 수정하지 않았어요.
- 최종 검증: 타입 검사·production build, 전체 Vitest **487/487**, M0 **13+3**와 검증기 selftest **11**, M1-local **55+6**, UI **9+19** PASS예요. 브라우저 총 **28개**, 실패·required skip 0, 세 검증 서버 cleanup PASS, source/dist 동일이에요. [최종 근거](../output/translation-final/2026-09-07/summary.json).
- 확인용 앱: [최신 번역·편집 화면 열기](http://127.0.0.1:50695/?chat=048ece7b-3e4a-4a1c-9de8-40985e79c1d8&branch=main%3A048ece7b-3e4a-4a1c-9de8-40985e79c1d8). 기존 합성 여정 DB를 별도로 복사하고 빌드를 고정했으며 실제 API 호출은 차단돼요. [소유권·health·원본 보존](../output/review-preview/review-2026-09-07T01-12-14-806Z-a46043c2/manifest.json). 기존 앱·미리보기·원본 기록을 보존했어요.
- 실제 호출: 이번 추가 유료 호출 **0회**, 기존 **49회** 기록 유지. 품질 실험과 옛 live 여정은 재개하지 않았어요.
- 최종 source/build: `98d80987e721d640570abf837ff0e094b2a7dcfd0caf310da89469a71d3cae2e`; dist SHA-256 `08d328dcec9277e05b86c339003d8585eb1a766ea664ac8c77c4d1493b29cc48`. [고정 소스 복사본](../output/translation-final/2026-09-07/source/README.md)은 별도 M2 작업의 통합 기준이에요.
- 한계: 로컬 합성 검사와 390px 모바일 viewport 확인이에요. 실제 휴대폰·새 외부 인증·문학/번역 품질·외부 배포·M1 전체 인수 완료로 확대하지 않아요. commit/push/deploy는 하지 않았어요.

## 이전 포크 완료 기록 · 보존

아래 source/build와 미리보기는 번역·직접 편집 변경 전의 역사적 기록이에요.

- 기준: 2026-09-07 사용자 요청에 따라 분기를 Codex 포크처럼 단순화하는 구현과 관련 검증을 완료했어요. 전체 프롬프트 편집·공급자 연결은 보존했고 M2는 시작하지 않았어요.
- 사용 흐름: 원고의 **여기서 새 이야기로 이어가기** 또는 상단 **이야기 포크**를 누르면 선택 원고까지 새 이야기로 복사해 좌측 목록에 추가해요. 설정·프롬프트 선택·초안·이후 전개는 원본과 독립적이에요. 원문과 완료 번역·상태·이미지를 새 ID/anchor로 복사하며 모델 호출과 기존 비용을 중복 기록하지 않아요. 불변 서재 revision은 참조로 공유해요.
- 기존 분기: 복잡한 후보 생성·분기/장면 선택 UI를 제거했어요. 이전 기록은 **보관된 전개**에서 한 번 눌러 읽을 수 있고 호환 API/데이터는 보존해요. 포크는 대기·실패·부분 작업을 자동 실행하지 않아요.
- 최종 검증: 타입 검사·production build, 전체 Vitest **457/457**, M1-local **55+6**, UI **7+16** PASS예요. 실패·required skip 0, 두 검증 서버 cleanup PASS이며 모든 근거의 source/dist가 같아요. 원본 행 불변·독립 설정·번역/이미지 매핑·재시작·idempotency·SQLite rollback·백업 복원과 브라우저 초안/응답 경합을 확인했어요. [최종 근거](../output/fork-final/2026-09-07/summary.json).
- 확인용 앱: [최신 포크 화면 열기](http://127.0.0.1:52890/?chat=048ece7b-3e4a-4a1c-9de8-40985e79c1d8&branch=main%3A048ece7b-3e4a-4a1c-9de8-40985e79c1d8). 기존 합성 여정 DB를 별도로 복사한 앱이며 실제 API 호출은 차단돼요. [소유권·health·원본 보존 기록](../output/review-preview/review-2026-09-07T00-36-13-571Z-0a2d17bc/manifest.json). 기존 앱/미리보기의 데이터와 프로세스는 보존했어요.
- 실제 호출: 이번 포크 구현·검증의 추가 유료 호출 **0회**, 기존 기록 **49회**를 보존했어요. 사용자 지시로 종료한 품질 실험과 옛 후보 UI 기반 live 여정은 다시 실행하지 않아요. 옛 여정 실행기는 인증·DB 복사·API 호출 전에 명시적으로 중단해요.
- 최종 source/build: `7fb2aeae84e3e2d13514ab476b11cd6e8306c89cc6d0bcfeeb1739c2aea251a1`; dist SHA-256 `6a3b011dffa2010068b9048148a7e856fd607cea04a17b4483cf385f450f6c5b`.
- 한계: 로컬 합성 검증과 390px 모바일 viewport 확인이에요. 실제 휴대폰·추가 공급자의 외부 인증·문학/번역 품질·외부 배포·M1 전체 인수 완료로 확대하지 않아요. commit/push/deploy는 하지 않았어요.

## 이전 전체 프롬프트 완료 기록 · 보존

아래 확인용 앱과 source/build는 포크 변경 전의 역사적 기록이에요. 현재 버전은 위 최종 근거를 사용해요.

- 기준: 2026-09-07 M1 공급자 후속과 사용자 전체 프롬프트 편집을 구현하고 관련 검증을 완료했어요. 사용자 지시에 따라 문학·번역 품질 튜닝은 종료하고 요청·응답·저장 계약을 확인했어요. M2는 시작하지 않았어요.
- 프롬프트: 이야기 설정/서재의 프롬프트 탭에서 작문·번역 전체 본문을 편집·저장·선택해요. UTF-8 txt/md, 기본 전체 불러오기, 빈 지침, 수정 버전을 지원하며 기본 본문을 완전히 교체해요. 새 작문은 현재 선택, 기존 실행/후보/실패 재시도는 당시 버전, 명시적 재번역은 현재 번역 지침을 새 작업에 고정해요. CBS/`.risup` 실행기 포팅은 포함하지 않아요.
- 연결: Vertex·fixture를 보존하고 OpenAI Responses, Anthropic Messages, Vercel AI Gateway, 별도 OpenAI Chat Completions 호환 연결·모델 목록·설정·native 도구/stream 처리를 추가했어요. 실제 추가 네 공급자 호출은 사용자가 진행해요. 가격은 추정하지 않으며 Vertex 시험 예산과 구분해요.
- 최종 검증: 타입 검사·빌드, 전체 Vitest **449/449**, M1-local **55+6**, UI **7+16** PASS, 실패·required skip 0, 검사 서버 cleanup PASS예요. [최종 근거](../output/prompt-final/2026-09-07/summary.json). 저장·선택 0호출, 커스텀/빈 본문·100,001자 지침의 5 native adapter 실제 localhost 왕복, snapshot/후보/재번역/재시도/백업을 확인했어요. 마지막 변경은 UI 충돌 테스트의 영문 기대값을 기존 한국어 안내에 맞춘 것뿐이며 M1·전체 unit과 최종 UI의 compiled dist는 같아요.
- 실제 호출: 기존 승인 한도 총 **1000회·USD 100**에서 누적 **49회**예요. 추가 호출은 Vertex Flex만 사용했어요. 첫 장문 한국어 표시·초안·독서 위치 복원, 이어 쓰기 번역 실패 두 구간의 명시적 복구까지 확인했어요. 사용자 방향 변경 후 후보 번역은 취소했고 품질 재번역은 실행하지 않았어요. 전체 live 여정은 FAIL/INCOMPLETE를 보존해요. 예산 계산 **$13.20591375**는 usage 추정과 불확실 요청의 예약이며 실제 청구액이 아니에요. 이번 프롬프트 기능 검증의 추가 유료 호출은 0회예요. [실행 기록](M1-RESULTS.md).
- 확인용 앱: [최신 프롬프트 편집 화면 열기](http://127.0.0.1:59325/?chat=048ece7b-3e4a-4a1c-9de8-40985e79c1d8&branch=main%3A048ece7b-3e4a-4a1c-9de8-40985e79c1d8) → 이야기 설정 → 프롬프트. 검토용 합성 DB 복사본이며 실제 API 호출은 차단돼요. [실행/소유권 기록](../output/review-preview/review-2026-09-07T00-03-54-935Z-ab2de7ff/manifest.json). 사용자 DB로 실행하려면 기존 서버 터미널에서 종료 후 프로젝트 루트의 `npm run dev`를 사용해요. [사용법](../README.md#작문번역-프롬프트-직접-편집).
- 보존과 한계: 원문/hash·snapshot·revision·분기/source 귀속·idempotency·완료 번역 구간·호출 전 attempt 기록·불확실 실행 자동 재시도 금지와 사용자 `.local` DB를 보존했어요. 실제 휴대폰, 외부 배포, 전체 문학/번역 품질 및 M1 전체 인수 완료로 확대하지 않아요. commit/push/deploy는 하지 않았어요.
- 최종 source/build: `d0c27eb9eeb1391827cce51afd26d39730568cfc69e949ffdd71425f2d7ffeaf`; dist SHA-256 `03ba836065fd3321c261bf1915542132082177d6fd9195b2fbcdf6f79a6c2fde`.

## 이전 UI 후속 완료 기록 · 보존

- 기준: 2026-09-07 주요 참고 프로젝트의 실제 소스·호출 흐름·테스트를 Uimori에 적용하는 후속 요청. 실제 디렉터리는 `C:/Users/wodus/ai-workspace/uimori`, 시작 HEAD는 `87548d15c41fa0adb74284a1873c9d28e1dfe8ee`예요. 참고 저장소의 소스는 변경하지 않았어요.
- 상태: **UI-1–UI-3 구현 이후, 선택 보존·비동기 응답·시작 설정 복구 개선과 로컬 검증까지 완료.** RisuAI의 선택 구성 복사, Codex의 현재 화면과 결과 귀속 분리, Claude Code의 결과 게시 무효화 경계를 읽고 독립 구현했어요. snapshot·파일/심볼·채택/비채택·검증 근거는 [SOURCES](SOURCES.md)에 있어요. Gemini CLI/Grok Build는 이번 소스 조사 대상에서 보류했어요.
- 이번 적용: 첫 제출의 봇·페르소나 revision/프리셋 제어를 고정하고 중복 생성·진행 중 선택 변경을 막아요. chat 수락 직후 시작 의도를 기록해 설정 조회 실패·닫기·재진입 후에도 복구하고, 재시도는 최신 routes/image/revision을 보존해요. 늦은 후보 응답이나 이전 이야기의 오류가 현재 branch/source/초안을 바꾸지 않으며 서버 실행은 계속돼요.
- 보존: 원문/hash 불변, revision/idempotency, 후보·분기 ancestry, source/job 귀속과 재시도, 서버 소유 실행, 연결·인증·백업 경계. `core/`, `server/`, schema/migration은 수정하지 않았어요. 사용자 `.local/narrative.sqlite`를 열거나 migration하지 않았어요.
- 최종 source/build ID: `171d909ce4974dfdf811180fa45d1137bcc6d66c8f5e2a367bc52050a1db193c`. dist SHA-256 `28d2869c87345cf7b69a48433cfc66621d73ac69e6cf36aa293c39f9e2bc1eb5`.
- 최종 `npm run check`, `npm run build` PASS. `M0`: Vitest 13/Playwright 3 PASS, 검증기 실패 탐지 selftest 11 PASS. `M1-local`: Vitest 38/Playwright 4 PASS. `verify:ui`: Vitest 7/Playwright 10 PASS. 세 검증의 required skip/실패 0, cleanup PASS, source/dist identity 일치.
- 최종 증거: [M0](../output/playwright/2026-09-06T15-19-27-756Z-66019ec2/summary.json), [M1-local](../output/playwright/2026-09-06T15-20-40-677Z-2eb8a1f9/summary.json), [UI](../output/playwright/ui-2026-09-06T15-24-29-910Z-50989c11/summary.json). 이전 빌드에서 세 경합 실패를 재현하고, 수정 빌드에서 그 세 경우와 설정 GET 실패/재진입/legacy pending 복구까지 새 브라우저 회귀 4개가 통과했어요. 390×844의 대기·오류·복구 화면 4장을 검토했으며 [캡처 기록](../output/playwright/race-fixed-confirmed-2026-09-06T15-20-15-086Z-9c0f5173/capture.json)에 조건을 남겼어요.
- 이전 UI 개편: 좌측 이야기 탐색/모바일 메뉴, 독립 reader 스크롤, 하단 입력, 한국어 우선 번역, 서재·새 이야기·설정·작업 현황을 구현했어요. [UI-RESULTS](UI-RESULTS.md), [design-qa](../design-qa.md)의 1440×1000/390×844 before/after·UI14 측정과 360/390/768/1024/1440 너비 검토는 이전 `537ec723…` 빌드의 역사적 근거로 보존해요. 이번 동작 수정 후 동일 측정을 다시 했다고 주장하지 않아요.
- 환경: Windows 11 10.0.26200, Node 24.14.0, npm 11.14.1, Chrome 152.0.7977.82. 필요한 자식 프로세스는 승인된 로컬 실행으로 검증했어요. UI 개편에서 추가한 의존성은 `lucide-react` 1.41.0 하나이며 이번 후속 수정의 새 의존성은 없어요.
- 실행: [검증용 실제 앱](http://127.0.0.1:60577/?chat=214902a5-3a23-438a-9f4f-bd658a359205)은 합성 DB와 최신 빌드로 실행 중이며, 프로세스·health는 [현재 미리보기 기록](../output/ui-redesign/2026-09-06T14-15-36.974Z/preview-current.json)에 있어요. 사용자 데이터로 실행하려면 이전 앱 서버 터미널에서 Ctrl+C 후 위 프로젝트에서 `npm run dev` → [로컬 앱](http://127.0.0.1:4310). 초기 설치·격리 DB·복원 방법은 [README](../README.md)에 있어요.
- 저장소: `codex/m1-local`의 로컬 변경으로 남겼어요. 이전 UI 변경과 사용자 제공 `ui-redesign/`을 보존했고 commit/push/deploy하지 않았어요. 자동 검사 서버와 runtime은 정리했으며 확인용 preview만 유지해요.
- 전체 제품 범위: **M1 전체의 live/device/quality 전제는 계속 미충족**이에요. 실제 공급자 adapter·model·credential·유료 시험 예산·실제 폰/외부 접속은 이번 UI 범위 밖이에요. `fixture-sse-v1`은 검증용 연결이며 실서비스 API 호환을 뜻하지 않아요. 실제 IME/키보드/백그라운드, live 모델·문학/번역 품질, M2는 완료로 표시하지 않아요. 기존 M1 근거·전제는 [M1-RESULTS](M1-RESULTS.md)에 보존돼요.
