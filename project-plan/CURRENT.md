# 현재 계약 · Uimori

지금 유효한 계약, 완료 조건, 남은 범위만 담아요. 2026-09-06부터 2026-09-10까지 쌓인 시간순 작업 기록은 [작업 기록 2026-09](history/CURRENT-2026-09.md)로 옮겼고, 각 기능의 상세 계약은 아래 링크의 문서가 소유해요. 방향 결정과 실행 순서는 [방향 결정 2026-09-10](../docs/DECISIONS-2026-09-10.md)에 있어요. 이 문서는 계약이나 남은 범위가 바뀔 때만 고쳐요.

## 현재 계약

- **DB schema / JSON archive는 v15**예요. 새 DB만 초기화하고 구형 DB·archive는 이관하지 않아요. 기능 추가로 표가 늘 때는 v15 DB에 없는 표만 추가하고 버전은 유지해요. 2026-09-10 사용자 확인으로 Oracle 운영 서버에도 v15가 배포되어 있어요. [운영 배포](../docs/ORACLE-RELEASE.md) · [도우미·문맥 결과](HELPER-CONTEXT-RESULTS.md)
- **작문·번역 프롬프트와 역할 모델은 전역이 기본**이며, 채팅은 작문 프리셋 ID와 본문 모델 ID를 고정할 수 있어요. 고정한 ID의 최신 저장본을 새 요청에 사용하고 삭제·비활성 대상을 임의로 대체하지 않아요. 번역과 보조 역할은 전역을 유지해요. `workspaceModelRef`가 역할 선택 규칙을 소유하며 이미 예약한 snapshot은 바꾸지 않아요. [전역 역할 모델](../docs/GLOBAL-MODELS.md) · [현재 프롬프트](../docs/RUNTIME-SIMPLIFICATION.md)
- 자료·프롬프트·공유 모듈은 **같은 ID의 최신 저장본**을 다음 실행에서 사용해요. 이미 예약한 실행과 과거 원문은 자체 snapshot을 유지하고 현재 작업본으로 다시 해석하지 않아요. [현재 설정 계약](CURRENT-SETTINGS-PLAN.md) · [번역 구간과 재시도](TRANSLATION-CHUNKS.md)
- 봇·페르소나·모듈은 **공통 패키지**이고 서재의 분류·폴더는 채팅 장착 역할과 독립이에요. 이미지·시작문·로어·상태와 행동·다음 요청 예약·원문 구간 정책을 패키지가 선언하고 런타임 플러그인은 없어요. Risu 자료는 외부 에이전트가 native JSON으로 이식해요. [서재](../docs/LIBRARY.md) · [패키지](../docs/PACKAGES.md) · [상태와 행동](../docs/PACKAGE-BEHAVIOR.md) · [Risu 이식](../docs/RISU-PORTING.md)
- 프롬프트는 저장된 **`PromptProgram` AST**로 실행하고 블록 편집기로 고쳐요. 템플릿 문법과 TypeScript 제작 API는 선택 가능한 입력 경로예요. 프롬프트별 옵션 조합은 role+values로 저장하고 현재 정의로 검증해요. 채팅 옵션의 소속(`OptionBinding.owner`)은 `core/chat-options.ts`의 한 규칙으로 예약 고정과 현재 상태가 같이 계산해요. [제작 방식](../docs/PROMPT-AUTHORING.md) · [프롬프트 실행](../docs/PROMPT-RUNTIME.md)
- 모델·프로바이더는 최신 `provider_settings` 한 벌을 쓰고 `ModelRef`는 `{id}`예요. 모델 ID 코드표로 실행을 막지 않고 공급자의 거절을 그대로 표시해요. 요금 설정과 호출 후 추정 비용을 제공해요. [공급자](../docs/PROVIDERS.md) · [모델 등록](../docs/MODEL-REGISTRATION.md) · [모델 파라미터](../docs/MODEL-PARAMETERS.md) · [요금](../docs/MODEL-PRICING.md)
- **도우미와 통합 문맥**: 별도 도우미 대화, 공통 서버 초안과 명시 요청의 수정·저장, 사용자 메모·정정, 공통 요약의 자동·수동 압축, 채팅별 로어 변경과 옵션 위임, 선택형 `context.*` 도구를 제공해요. 매 턴 기억 추출은 제거했어요. [확정 계획](HELPER-CONTEXT-PLAN.md) · [구현 결과](HELPER-CONTEXT-RESULTS.md) · [입력 한도](../docs/CONTEXT-LIMITS.md) · [로어 문맥](../docs/LORE-CONTEXT.md)
- 계층형 구성과 지정 단위 집필, 장면 삽화 생성(Codex 이미지 턴·원격 ComfyUI), 원문·번역 이미지 배치, 메인 프롬프트의 에이전트 협업(기본 OFF), 모델 프리셋별 선택형 평가 도구를 제공해요. [구성](../docs/OUTLINE.md) · [삽화](../docs/ILLUSTRATIONS.md) · [협업](../docs/AGENT-COLLABORATION.md) · [평가 도구](EVALUATION-TOOLS.md)
- 채팅 하나의 **전체 백업**은 DB 스키마와 독립인 `uimori-chat-backup` v1이에요. 모든 분기와 작업 이력·참조 자료를 보관하며 같은 파일을 반복해서 새 채팅으로 복원해요. 현재 전역 설정을 덮어쓰지 않고 원래 환경을 함께 보존하며, 미완료 외부 작업을 자동 재전송하지 않아요. 한 응답의 복사는 클립보드 평문이고, 외부 본문 교환용 `uimori-chat-transcript` v1은 별도예요. [채팅 백업](../docs/CHAT-BACKUP.md) · [본문 교환](../docs/CHAT-TRANSCRIPT.md) · [안정화 결정](../docs/STABILIZATION-2026-09-11.md)
- 메인과 도우미는 **공통 입력창**을 쓰고 실패 요청은 자리에서 편집·재요청하며 공개 답변 스트림은 durable cursor로 재접속해요. 봇별 채팅·폴더·공유 폴더 트리, 포크, 읽기 위치, 삭제 보호, archive·backup 왕복을 유지해요. [대화 통일](CHAT-UNIFICATION.md) · [사용 안내](../docs/USAGE.md) · [삭제 보호](../docs/DELETION.md)
- UI는 원고가 화면인 리더, 한 줄 입력창, 목록→상세 설정과 공통 아이콘 어휘를 따라요. [UI 원칙](../docs/UI-PRINCIPLES.md) · [UI 설계 v2](../docs/UI-DESIGN-V2.md) · [화면 설계](../docs/UI-SCREEN-DESIGN.md) · [화면 일관성 정리](UIUX-CONSISTENCY-2026-09-10.md) · [AI 제품 원칙 적용](../docs/UI-PRINCIPLES-AI-PRODUCTS.md) · [화면 갤러리](../docs/UI-GALLERY.md)
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

2026-09-11 안정화의 최종 Windows `quality:full`은 **1,859 PASS / opt-in 1 SKIP**, `verify:smoke` **3 PASS**, 채팅 백업 화면 **7 PASS**, 공통 대화 화면 **16 PASS**예요. Reader 코드가 동일한 직전 빌드의 로딩 화면 **10 PASS**도 보존해요. 초기 전체 검사 1,850 PASS / 1 FAIL은 초안의 국문 CAS 메시지 분류 누락을 고친 뒤 재검증한 기록과 구분해요. 신규 승인 예산의 Gemini 평가는 총 100회 전송으로 종료했어요. 실행 중 문맥 정리의 두 전송 경계를 고쳤고 32k 후속에서는 원문 재조회·정정, 옵션 저장·소비, 두 모델의 독립 3+3 사례까지 완료했어요. 장기 요약 손실과 16k 호출 소진, Lite의 조건 분류 모순·Flash의 인용 표현 문제는 남겨 전체 의미 품질 PASS로 해석하지 않아요. [안정화 결과](STABILIZATION-RESULTS-2026-09-11.md)

2026-09-10 `main` 병합과 후속 구현의 최종 Windows `quality:full`은 **1,785 PASS / opt-in 1 SKIP**, `verify:smoke`는 **3 PASS**, 관련 UI는 **13 PASS**예요. 2026-09-11 KST 릴리즈 전 전체 `verify:redesign`은 **228 PASS / 0 FAIL / 0 SKIP**, 547,806ms(9.1분)에 종료하고 cleanup을 완료했어요. 앞선 전체 **223 PASS / 5 FAIL**, 10.3분 기록은 별도로 유지해요. 과거 macOS 결과와 같은 조건의 A/B가 아니므로 운영체제별 원인이나 성능 우위로 해석하지 않아요. [통합 후속 결과](DECISION-FOLLOWUP-RESULTS-2026-09-10.md) · [전체 회귀 지연 브리프](BRIEF-FULL-RUN-REGRESSION-2026-09-10.md)

Oracle 운영 서버의 짧은 실사용과 별도로, 독립 DB에서 공개 원문 162,975 토큰·61장을 이용한 Gemini 장기 문맥 평가를 수행했어요. 활성 요약 조회·길이 문제를 보완하고 도우미의 로어·프롬프트 저장과 옵션의 예약 소비를 확인했어요. 의미 오류와 문맥 한도·공급자 EOF 실패가 남아 전체 live 시나리오 PASS는 아니에요. 상세 경계는 [기억 평가](LIVE-MEMORY-RESULTS-2026-09-10.md), 다른 도우미 도구와 경량 역할 비교는 [하네스 효율](HARNESS-EFFICIENCY-2026-09-10.md)에 기록해요.

## 남은 범위

| 구분 | 남은 것 | 어디서 다루나 |
| --- | --- | --- |
| 방향 결정 구현 | 채택한 구현·정적 검토·대체 실모델 평가를 수행했어요. 예약 체인은 7가지 purpose로 통합했으며 남은 값 순환은 `package-images` ↔ `source-editing` 하나예요 | [방향 결정](../docs/DECISIONS-2026-09-10.md) · [예약 고정 계약](../docs/RESERVATION-SNAPSHOTS.md) · [후속 결과](DECISION-FOLLOWUP-RESULTS-2026-09-10.md) |
| 실모델 품질 | 앞선 88회 평가 이후 신규 100회 안정화 평가도 종료했어요. 32k 재조회는 원문·정정·출처를 복구했지만 장기 요약의 귀속·조건 손실, 16k 반복 읽기와 호출 소진, 일부 조건 분류·인용 표현 문제는 남아요. 실제 창작 품질 인수는 별도예요 | [안정화 결과](STABILIZATION-RESULTS-2026-09-11.md). 과거 기록은 [실제 기억 평가](LIVE-MEMORY-RESULTS-2026-09-10.md)에 보존해요 |
| 인수 항목 | M1 Q01/Q02/Q03/Q05 품질, M3 E01–E03 전체 인수와 실제 공급자별 도구 호환, 개인 자료의 공통 형식 재이식 | [MILESTONES](MILESTONES.md) · [ACCEPTANCE](ACCEPTANCE.json). M3의 "검토 후 적용하는 등록 보조"는 2026-09-09 실행 게이트 제거로 삭제됐어요 |
| 하네스·CI | Windows 전체 회귀 재측정·지연 원인 구분·브라우저 CI job 분리·도우미 예약 모델 표시는 완료했어요. 실제 GitHub Actions 실행은 별도예요 | [후속 항목 2026-09-10](FOLLOW-UPS-2026-09-10.md) · [지연 브리프](BRIEF-FULL-RUN-REGRESSION-2026-09-10.md) |
| 운영 | 이미지 이해, 실제 휴대폰·IME·Linux/Docker 동작. Oracle v15 배포는 사용자 확인으로 완료 | [운영 배포](../docs/ORACLE-RELEASE.md) · [도우미·문맥 결과](HELPER-CONTEXT-RESULTS.md) |

### 방향 결정 후속 진행 · 2026-09-10

현재 워크트리에 `main`을 병합한 뒤 채팅별 고정 층과 공통 모델 역할을 구현했어요. 삭제·비활성 고정 대상의 실행 차단, 전역 복귀, 최신 저장본 추종, 옵션 소속 충돌과 과거 snapshot 불변을 검사해요. 지정한 Lua 봇 검토 결과는 [정적 검토 보고](LUA-PORTING-REVIEW-2026-09-10.md)에 있어요. 미지원 동작의 자동 이식이나 런타임 확장은 구현하지 않았어요.

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
