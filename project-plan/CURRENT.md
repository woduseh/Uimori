# 현재 계약 · Uimori

지금 유효한 계약, 완료 조건, 남은 범위만 담아요. 2026-09-06부터 2026-09-10까지 쌓인 시간순 작업 기록은 [작업 기록 2026-09](history/CURRENT-2026-09.md)로 옮겼고, 각 기능의 상세 계약은 아래 링크의 문서가 소유해요. 방향 결정과 실행 순서는 [방향 결정 2026-09-10](../docs/DECISIONS-2026-09-10.md)에 있어요. 이 문서는 계약이나 남은 범위가 바뀔 때만 고쳐요.

## 현재 계약

- **DB schema / JSON archive는 v15**예요. 새 DB만 초기화하고 구형 DB·archive는 이관하지 않아요. 기능 추가로 표가 늘 때는 v15 DB에 없는 표만 추가하고 버전은 유지해요. Oracle 운영 서버는 v14 배포 상태이며 v15 전환은 별도 작업이에요. [운영 배포](../docs/ORACLE-RELEASE.md) · [도우미·문맥 결과](HELPER-CONTEXT-RESULTS.md)
- **작문·번역 프롬프트와 역할 모델은 전역**이에요. `prompt_workspace` 한 벌에 프로그램·선택값·번역 정책·역할 모델을 두고 새 요청이 그때의 작업본을 자기 snapshot에 고정해요. 채팅 프로필은 봇·페르소나·모듈·옵션만 소유해요. 채팅별 고정 층(작문 프리셋·본문 모델)은 결정 1로 예정이고 미구현이에요. [전역 역할 모델](../docs/GLOBAL-MODELS.md) · [현재 프롬프트](../docs/RUNTIME-SIMPLIFICATION.md)
- 자료·프롬프트·공유 모듈은 **같은 ID의 최신 저장본**을 다음 실행에서 사용해요. 이미 예약한 실행과 과거 원문은 자체 snapshot을 유지하고 현재 작업본으로 다시 해석하지 않아요. [현재 설정 계약](CURRENT-SETTINGS-PLAN.md) · [번역 구간과 재시도](TRANSLATION-CHUNKS.md)
- 봇·페르소나·모듈은 **공통 패키지**이고 서재의 분류·폴더는 채팅 장착 역할과 독립이에요. 이미지·시작문·로어·상태와 행동·다음 요청 예약·원문 구간 정책을 패키지가 선언하고 런타임 플러그인은 없어요. Risu 자료는 외부 에이전트가 native JSON으로 이식해요. [서재](../docs/LIBRARY.md) · [패키지](../docs/PACKAGES.md) · [상태와 행동](../docs/PACKAGE-BEHAVIOR.md) · [Risu 이식](../docs/RISU-PORTING.md)
- 프롬프트는 저장된 **`PromptProgram` AST**로 실행하고 블록 편집기로 고쳐요. 템플릿 문법과 TypeScript 제작 API는 선택 가능한 입력 경로예요. 프롬프트별 옵션 조합은 role+values로 저장하고 현재 정의로 검증해요. 채팅 옵션의 소속(`OptionBinding.owner`)은 `core/chat-options.ts`의 한 규칙으로 예약 고정과 현재 상태가 같이 계산해요. [제작 방식](../docs/PROMPT-AUTHORING.md) · [프롬프트 실행](../docs/PROMPT-RUNTIME.md)
- 모델·프로바이더는 최신 `provider_settings` 한 벌을 쓰고 `ModelRef`는 `{id}`예요. 모델 ID 코드표로 실행을 막지 않고 공급자의 거절을 그대로 표시해요. 요금 설정과 호출 후 추정 비용을 제공해요. [공급자](../docs/PROVIDERS.md) · [모델 등록](../docs/MODEL-REGISTRATION.md) · [모델 파라미터](../docs/MODEL-PARAMETERS.md) · [요금](../docs/MODEL-PRICING.md)
- **도우미와 통합 문맥**: 별도 도우미 대화, 공통 서버 초안과 명시 요청의 수정·저장, 사용자 메모·정정, 공통 요약의 자동·수동 압축, 채팅별 로어 변경과 옵션 위임, 선택형 `context.*` 도구를 제공해요. 매 턴 기억 추출은 제거했어요. [확정 계획](HELPER-CONTEXT-PLAN.md) · [구현 결과](HELPER-CONTEXT-RESULTS.md) · [입력 한도](../docs/CONTEXT-LIMITS.md) · [로어 문맥](../docs/LORE-CONTEXT.md)
- 계층형 구성과 지정 단위 집필, 장면 삽화 생성(Codex 이미지 턴·원격 ComfyUI), 원문·번역 이미지 배치, 메인 프롬프트의 에이전트 협업(기본 OFF), 모델 프리셋별 선택형 평가 도구를 제공해요. [구성](../docs/OUTLINE.md) · [삽화](../docs/ILLUSTRATIONS.md) · [협업](../docs/AGENT-COLLABORATION.md) · [평가 도구](EVALUATION-TOOLS.md)
- 채팅 하나의 **본문 기록**(원문·요청·최신 번역·메모·장착 참조)은 `uimori-chat-transcript` v1 파일로 내보내고 새 채팅으로 가져와요. 스키마와 독립이라 개발 단계 DB 리셋에서 작품을 살리는 경로예요. [채팅 본문 추출](../docs/CHAT-TRANSCRIPT.md)
- 메인과 도우미는 **공통 입력창**을 쓰고 실패 요청은 자리에서 편집·재요청하며 공개 답변 스트림은 durable cursor로 재접속해요. 봇별 채팅·폴더·공유 폴더 트리, 포크, 읽기 위치, 삭제 보호, archive·backup 왕복을 유지해요. [대화 통일](CHAT-UNIFICATION.md) · [사용 안내](../docs/USAGE.md) · [삭제 보호](../docs/DELETION.md)
- UI는 원고가 화면인 리더, 한 줄 입력창, 목록→상세 설정과 공통 아이콘 어휘를 따라요. [UI 원칙](../docs/UI-PRINCIPLES.md) · [UI 설계 v2](../docs/UI-DESIGN-V2.md) · [화면 설계](../docs/UI-SCREEN-DESIGN.md) · [화면 일관성 정리](UIUX-CONSISTENCY-2026-09-10.md)
- 개인 self-host용 HTTPS·토큰·영구 SQLite 구성과 Oracle 배포 절차가 있어요. [Self-host](../docs/SELF-HOST.md) · [Oracle 배포](../docs/ORACLE-RELEASE.md) · [Tailscale](../docs/TAILSCALE-DEPLOY.md)

앱은 프로젝트 루트에서 `npm run dev`로 실행하고 사용자 DB를 검증에 쓰지 않아요. 전체 구조와 경계는 [아키텍처](ARCHITECTURE.md), 목적과 비목표는 [PROJECT](PROJECT.md)를 봐요.

## 완료 조건

2026-09-10 결정 3에 따라 검증 게이트를 두 층으로 나눠요. 명령 설명과 영역 대응은 [검사 안내](../docs/QUALITY.md)와 [검사 운영 정리](../docs/TESTING-AUDIT.md)를 따라요.

| 층 | 시점 | 명령 |
| --- | --- | --- |
| 매 변경 | 작업 완료 | `npm run quality:full` + `npm run verify:smoke` + 변경 영역의 `verify:*` 하나 |
| 릴리스 전 | 배포 직전 1회 | 전체 `npm run verify:redesign` |

전체 회귀의 실패는 "다음 릴리스 전에 볼 것"으로 분류하고 매 변경을 막지 않아요. BLOCKED와 미실행 검사를 PASS로 해석하지 않으며, 실제 모델 품질·청구 비용·휴대폰·Linux 동작은 합성 검증으로 보증하지 않아요.

## 마지막 검증 상태

2026-09-10 화면 일관성 정리 시점이에요. `quality:full`은 Node 24에서 **1,716 PASS / opt-in 1 SKIP**이고, 전체 `verify:redesign`은 이 트리 **214 PASS / 6 FAIL**, 직전 `HEAD`(`e417572`) **210 PASS / 10 FAIL**로 새로 깨진 검사는 없어요. 이 측정은 macOS·Edge 152이고 저장소 CI는 Windows·Node 24.14라 남은 실패의 절대 개수는 Windows에서 1회 다시 재야 해요. 완주 시간이 길어진 원인은 [전체 회귀 지연 브리프](BRIEF-FULL-RUN-REGRESSION-2026-09-10.md)에서 조사 중이에요.

실사용은 Oracle 운영 서버(v14)에서 3일간 짧은 세션 몇 개예요. 본문 생성·번역의 기본 경로는 실제 공급자로 확인했고, 압축·문맥 도구·도우미의 실제 변경·장기 세션은 미확인이에요.

## 남은 범위

| 구분 | 남은 것 | 어디서 다루나 |
| --- | --- | --- |
| 방향 결정 구현 | 게이트 문구·문서 분리와 순환 제거·옵션 소속 규칙 통합은 완료(남은 순환은 `package-images` ↔ `source-editing` 하나), 채팅 본문 추출 형식(완료), Lua 봇 2개 정적 이식 검토(봇 파일 대기), 채팅별 고정 층과 `ModelRole` 통일, 장기 세션 실사용, 예약 고정 체인 통합 | [방향 결정 2026-09-10](../docs/DECISIONS-2026-09-10.md) 실행 순서 |
| 실모델 검증 | 압축·`context.*` 도구·메모·원문 재조회의 장기 세션 품질(구 Q04를 대체), 도우미의 로어 수정 저장·옵션 위임 실제 실행 | 결정 2. 공급자·모델·허용 비용은 실행 직전 사용자가 정해요 |
| 인수 항목 | M1 Q01/Q02/Q03/Q05 품질, M3 E01–E03 전체 인수와 실제 공급자별 도구 호환, 개인 자료의 공통 형식 재이식 | [MILESTONES](MILESTONES.md) · [ACCEPTANCE](ACCEPTANCE.json). M3의 "검토 후 적용하는 등록 보조"는 2026-09-09 실행 게이트 제거로 삭제됐어요 |
| 하네스·CI | Windows 전체 회귀 1회 재측정, 전체 회귀 지연 원인, 브라우저 회귀의 별도 CI job 분리, 도우미 작업의 모델 귀속 표시 | [후속 항목 2026-09-10](FOLLOW-UPS-2026-09-10.md) · [지연 브리프](BRIEF-FULL-RUN-REGRESSION-2026-09-10.md) |
| 운영 | 운영 서버 v14 → v15 전환, 이미지 이해, 실제 휴대폰·IME·Linux/Docker 동작 | [운영 배포](../docs/ORACLE-RELEASE.md) · [도우미·문맥 결과](HELPER-CONTEXT-RESULTS.md) |

### 다음 작업 인계 (2026-09-10 할당량 소진 시점)

실행 순서 1·2·4단계는 완료해 커밋했어요. 3단계는 사용자의 Lua 봇 파일 2개가 `.local/reference/`에 없어 대기 중이에요. 5단계(결정 1 + `ModelRole` 통일)는 코드 변경 없이 설계만 확정했고 다음 세션이 이어가요.

- 역할: `core/product.ts`에 `MODEL_ROLES`/`ModelRole`(9개)과 `WorkspaceModelRole`(`TaskRole`+helper·context·title·refusal), 단일 해석 함수 `workspaceModelRef(workspace, role)`을 두고 `ProviderRole`·`Attempt.role`을 별칭으로 바꿔요. `helper-runtime`·`chat-title`·`product-store.snapshot`의 필드 직접 읽기를 이 함수로 바꿔요. state·illustration 모델은 각자 설정에 있어 대상이 아니에요.
- 고정 층: `ChatProfile.pinned?: { mainPromptPresetId?, mainModel? }`. `updateProfile`이 `pinned`를 받아 프리셋(작문 역할)·모델의 현재 존재를 확인해요. `currentProfile`의 `routes.main`은 고정 모델을 반영하고, 새 함수 `chatPromptWorkspace(store, pinned)`가 고정 프리셋의 최신 저장본을 `main`으로 바꾼 작업본을 돌려줘요. `ProductStore.snapshot`과 `ChatOptionsStore.get`이 이 함수를 써서 옵션 소속이 `preset:<id>`로 따라가요. 삭제·비활성은 `modelSnapshot`/`assertAvailable`이 새 실행을 막아요. archive 프로필 필드 목록에 `pinned`를 추가해요.
- 화면: 채팅 설정 프롬프트·모델 탭에 "이 채팅의 작문 프롬프트/본문 모델" 선택(전역 따르기 기본), 헤더 모델 칩에 "이 채팅 고정" 표시. `profileBody`는 `pinned: next.pinned ?? {}`로 항상 보내 해제를 표현해요.
- 검사: Store 단위(고정 모델·프리셋이 snapshot에 반영, 최신 저장본 추종, 삭제 시 차단, 잘못된 참조 거절, 옵션 소속)와 `tests/global-models-browser.spec.ts`의 채팅 설정 고정 케이스. 영역 검사는 `verify:global-models`. 문서는 [GLOBAL-MODELS](../docs/GLOBAL-MODELS.md)·[RUNTIME-SIMPLIFICATION](../docs/RUNTIME-SIMPLIFICATION.md) 머리말의 "채팅별 선택 없음"을 고정 층 예외로 고쳐요.

L01(공급자별 경로)·L02(실기기 접속)는 위 3일 실사용으로 기본 경로만 확인한 상태로 정리하고 별도 인수 항목으로 두지 않아요. 중단된 품질 실험이나 유료 실행은 새 승인 없이 재개하지 않아요. 런타임 플러그인·Lua·MCP 클라이언트는 결정 5로 미지원이에요.

## 상세 결과와 이전 기록

각 문서는 작성 당시의 범위·실패·미완료를 보존해요. 같은 기능의 후속 결과가 있으면 최근 구현을 우선 확인해요. `output/` 링크는 Git에 포함되지 않는 로컬 증거이며 새 checkout에서 열리지 않을 수 있어요.

| 영역 | 기록 |
| --- | --- |
| 시간순 작업 기록 | [2026-09-06 ~ 2026-09-10](history/CURRENT-2026-09.md) |
| 공통 UI·아이콘 | [상세 화면 구현과 검증](UI-DETAIL-IMPLEMENTATION.md) · [설정·서재·프로바이더·데이터 구현과 검증](UI-COMPACT-IMPLEMENTATION.md) · [프롬프트 설정 UX](PROMPT-SETTINGS-UX-2026-09-10.md) · [화면 일관성](UIUX-CONSISTENCY-2026-09-10.md) |
| 서재·이미지·탐색 | [서재 결과](LIBRARY-RESULTS.md) · [탐색 결과](NAVIGATION-RESULTS.md) · [장면 탐색](SCENE-NAVIGATION.md) |
| 공통 실행 구조·품질·삭제 | [구조 정리 결과](CODEBASE-CLEANUP-RESULTS.md) · [품질 도구](QUALITY-RESULTS.md) · [삭제 결과](DELETION-RESULTS.md) · [slop audit](SLOP-AUDIT-2026-09-08.md) |
| 모델·입력 한도·로어 통합 | [전역 모델 결과](GLOBAL-MODELS-RESULTS.md) · [최종 통합](PROVIDER-PARAMETERS-RESULTS.md) · [공통 자료](SHARED-PACKAGE-RESULTS.md) · [로어 유지](LORE-CONTEXT-RESULTS.md) |
| 공급자·Codex·평가 도구 | [관리](PROVIDER-MANAGEMENT-RESULTS.md) · [관리 UI](PROVIDER-UX-RESULTS.md) · [Codex](CODEX-RESULTS.md) · [선택형 평가 도구](EVALUATION-TOOLS.md) · [세션 통합](SESSION-INTEGRATION-RESULTS.md) |
| 도우미·문맥·집필 | [도우미·문맥 계획](HELPER-CONTEXT-PLAN.md) · [도우미·문맥 결과](HELPER-CONTEXT-RESULTS.md) · [통합 감사](INTEGRATED-AUDIT-2026-09-09.md) · [대화 통일](CHAT-UNIFICATION.md) |
| 패키지·프롬프트·화면 | [봇 중심 개편](REDESIGN-RESULTS.md) · [상태와 행동](PACKAGE-BEHAVIOR-RESULTS.md) · [자동 행동](ACTION-EXECUTION-RESULTS.md) · [프롬프트 편집](PROMPT-EDITOR-RESULTS.md) · [초기 UI](UI-RESULTS.md) |
| 로딩·보조 문맥 | [로딩](LOADING-RESULTS.md) · [서재 로딩](LIBRARY-LOADING-RESULTS.md) · [번역 문맥](TRANSLATION-CONTEXT-RESULTS.md) · [기억 평가(제거된 추출 체계)](MEMORY-EVALUATION-RESULTS.md) |
| 배포·외부 이식 | [릴리스 2026-09-09](RELEASE-2026-09-09.md) · [Self-host 구현](SELF-HOST-RESULTS.md) · [Risu 변환 경로 정리](RISU-PORTING-RESULTS.md) · [과거 native 통합](NATIVE-RESULTS.md) · [당시 자료 대응표](NATIVE-PORTING.md) |
| Milestone·기초 설계 | [M0](M0-RESULTS.md) · [M1](M1-RESULTS.md) · [M2](M2-RESULTS.md) · [제거 전 Sol](SOL-RESULTS.md) · [계획 지도](README.md) · [채택 근거](SOURCES.md) |
