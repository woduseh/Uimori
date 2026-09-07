# 현재 작업 상태 · Uimori

2026-09-08 봇 폴더·채팅 탐색을 한 줄 목록, 접기, 드래그 이동/정렬, hover 삭제, 터치 메뉴와 비선택 채팅/접힌 폴더 작업 표시로 개선했어요. 현재 schema/archive는 **v11**이며 사용자 DB 초기화·구형 이관은 하지 않았어요. `quality:full` **1,233 PASS·1 opt-in skip / 빌드 PASS**, 최종 탐색 브라우저 **18/18 PASS** 및 소스/빌드 일치·cleanup을 확인했어요. [변경·검증·초기 실패 기록](NAVIGATION-RESULTS.md)을 봐요. 아래 버전과 수치는 각 시점의 기록이에요.

2026-09-08 자료별 native/hidden 실행기·고정 창작 제어·기본 합성 자료 주입·M0 resources 경로를 정리하고 공통 패키지·프롬프트·원문 구간 정책·요청 예약으로 통합했어요. 공통 Run 보관·포크 검증도 분리하고 후보의 원래 컴파일 조건을 보존해요. 현재 schema/archive는 **v10**이며 구형 v9·전용 자료를 자동 변환하지 않아요. 사용자 DB는 열거나 초기화하지 않았어요. 병행 품질 도구·공급자 변경을 포함한 `quality`·빌드, 단위·통합 **1,226 PASS·1 opt-in skip**, 최종 UI 회귀 **96/96 PASS**, 소스/빌드 일치·cleanup을 확인했어요. 단위 검사 후 브라우저 기대값만 변경했으며 제품 dist hash는 같아요. [변경 대응·검증·첫 실패 기록](CODEBASE-CLEANUP-RESULTS.md)과 [원문 구간 계약](../docs/SOURCE-SEGMENTS.md)을 봐요. 아래 수치·구형 schema·native/hidden 구현 및 미완료 표현은 각 시점의 기록이에요.

2026-09-08 삭제 기능을 서재 자료·프롬프트·조합·연결/모델·채팅/분기·이미지·native/hidden 자료·미사용 선언/예약에 추가했어요. 참조·실행·revision 보호와 확인창, 삭제 후 다른 탭의 선택 정리를 포함해요. 고정 소스 복사본에서 단위·통합 **1,219 PASS·1 opt-in skip**, 관련 브라우저 **9/9 PASS** 및 cleanup을 확인했고 공유 폴더 타입·빌드도 통과했어요. 병행 UI 변경과 검증 범위는 [삭제 결과](DELETION-RESULTS.md), 사용법과 개별 삭제 경계는 [삭제 안내](../docs/DELETION.md)를 봐요.

2026-09-08 공급자 설정·캐시·응답 테스트, 최신 모델·연결 설정, 입력 한도 272,000과 대화 자동 요약을 공통 자료·이미지·작성된 시작문·로어 유지 작업과 main에 통합했어요. 현재 schema/archive는 **v9**예요. 전체 단위·통합 **1,175 PASS·1 opt-in skip**, 최종 전체 브라우저 **79/79 PASS**, 타입·빌드·source/build 일치·cleanup을 확인했어요. 모바일에서 요약 안내·캐시·로어·시작문도 직접 확인했어요. source/build `1e5cce2af3ed71c8448378df20392fd779614d759b09f7550d7f2cab0e4b13de`이며 실제 모델·과금·요약 품질·휴대폰/IME·배포는 검증하지 않았어요. [통합 범위·실패 보존·최종 증거](PROVIDER-PARAMETERS-RESULTS.md) · [입력 한도 계약](../docs/CONTEXT-LIMITS.md). 아래 미커밋·병합 전·PENDING 표현은 해당 시점 기록이에요.

아래 공통 자료·로어 기록은 병합 전 브랜치에서 확인한 결과예요.

2026-09-08 통합 승인에 따라 `codex/shared-package-authoring`의 공통 자료·로어 완료 변경을 커밋해 메인 통합 담당 작업에 넘겨요. 검증 후 실행 소스·빌드 지문이 그대로 일치하는지 다시 확인했어요. 메인 병합·충돌 해소·합본 검증은 별도 ‘프로바이더 파라미터 지원 개편’ 작업에서 진행하며 이 작업트리에서는 푸시하지 않아요. 아래 미커밋 표현은 해당 검증 시점 기록이에요.

로어의 배경/장면 배치·그룹 순서, 실제 조회 구간의 턴 사이 유지, 문자·구간 상한과 새 장면 정리, 무상태 미리보기·Run 진단을 구현했어요. 자료·원문·retcon 무효화와 독립 포크/보관 전이를 검증하며 제외한 과거 읽기가 되살아나지 않게 해요. 최종 source/build `fd9c0e7cd90aa0d336e988a1095594b21cfed3b22b5f82bb222317cbad37a29a`에서 타입·빌드, 전체 단위 **1067 PASS·1 opt-in skip**, 전체 브라우저 **73/73 PASS**, source/build·cleanup을 확인했어요. [계획](LORE-CONTEXT-PLAN.md)·[구현과 검증 결과](LORE-CONTEXT-RESULTS.md)·[사용법](../docs/LORE-CONTEXT.md)을 확인해요. 별도 ‘프로바이더 파라미터 지원 개편’ 작업과 전체 문맥 압축의 연결 계약을 조율했으며, 전체 압축 본체와 병합 후 검증은 그 작업과의 통합 범위로 남아 있어요. 실제 모델 품질·cache hit·비용은 측정하지 않았고 커밋·병합·푸시는 하지 않았어요. 아래는 이전 시점 기록이에요.

공통 자료 제작·이미지·시작 연결을 `5761bb2` 기반의 별도 `codex/shared-package-authoring` 작업트리에서 구현했어요. 봇·페르소나·모듈의 같은 ID 역할 사용, 옵션·지침 편집, 공유 모듈과 Hidden 기능 연결, 개정에 고정된 이미지와 Reader 재선택, 작성된 도입문·생성 시작을 포함해요. 최종 source/build `38e2fa272727f5d7d2c23b1ef5dad61980b43d0121825db73bca0aed64b0515a`에서 타입·빌드, 전체 단위 **1032 PASS·1 opt-in skip**, 전체 브라우저 **70/70 PASS**, source/build·cleanup을 확인했어요. [구현·실패 기록·한계](SHARED-PACKAGE-RESULTS.md)와 [사용법](../docs/PACKAGES.md)을 확인해요. 이 결과는 병행 공급자 작업과 병합하기 전이며 커밋·병합·푸시는 하지 않았어요. 아래는 이전 시점 기록이에요.

세 병행 세션의 변경을 공유 `main`의 통합 커밋으로 정리해요. PromptProgram 통일·접기, 로어 폴더·검색, Codex 연결, 공급자별 평가 도구와 Risu 변환 경로 정리를 포함해요. 타입·빌드, 전체 단위 **992 PASS·1 opt-in skip**, 최종 전체 브라우저 **65/65 PASS**와 source/build·cleanup을 확인했어요. 과거 워크트리 네 작업은 이미 `82a1352`에 반영되어 추가 merge 대상이 없어요. [통합 범위·검증·첫 실패 기록](SESSION-INTEGRATION-RESULTS.md)을 확인해요. 아래는 각 작업 당시의 기록이며 미커밋·미푸시 표현도 해당 시점 기준이에요.

**Codex 구독 에이전트 연결**을 추가했어요. 본문·번역·장면 상태·이미지 작업·상태·기억과 모델 등록 요청에서 Codex를 선택하며, **설정 → 에이전트**에서 전용 로그인을 관리해요. 관련 단위·통합 **74/74**, 실제 설치 CLI의 모델 호출 없는 사전 검사 **1/1**, 타입·빌드와 관리 브라우저 **10/10 PASS**예요. 실제 구독 로그인·모델 실행과 Linux Docker는 미검증이에요. 소스 지문·화면·수정 중 발견한 실패와 한계는 [Codex 결과](CODEX-RESULTS.md), 활성화 절차는 [연결 안내](../docs/CODEX.md)에 있어요. 병행 작업의 전체 회귀와는 범위를 구분해요.

Sol 전용 provider를 제거하고 네 평가 도구를 모델 프리셋별 opt-in으로 분리했어요. 인증 환경변수 이름은 특정 접두사 없이 일반 환경변수 문법을 허용하며, Responses 호환 연결은 허용한 HTTPS 또는 loopback API root를 사용할 수 있어요. `GOOGLE_APPLICATION_CREDENTIALS`를 명시한 Vertex 연결은 변수 값을 Bearer token으로 보내지 않고 ADC 파일 경로로 사용해요. model-selected/preloaded, run session, case receipt, terminal content/notice 분리, 제한 교정, validation·거절 재제출, 명시적 잘림 복구를 main과 모든 보조 역할에 연결했어요. 후속 요청에 따라 외부 검토자·verified IAM·accepted authorization과 suppression/delivery를 포함한 모델-facing 문구·schema·결과 표현을 원본과 동일하게 복원했어요. 병행 구조 개편과 분리한 고정 소스 복사본 `58aab3dcf356babcf931b622e78c28271a70b4edda98809a259f089c4151946f`에서 타입·빌드, 전체 Vitest **1,219 PASS·1 opt-in skip**, [평가 도구 브라우저 2/2](../output/playwright/evaluation-ui-2026-09-07T17-26-15-469Z-baf591db/summary.json)이 PASS예요. 현재 공유 작업트리의 최종 빌드는 진행 중인 별도 구조 개편이 끝난 뒤 합본 검증해야 해요. 현재 계약과 원본 비교는 [선택형 평가 도구](EVALUATION-TOOLS.md)를 확인해요.

최근 사용자 요청의 **연결·모델 관리 개편 / Vertex 키 JSON 등록 / 공통 중앙 팝업** 구현을 마쳤어요. 모델·연결 목록과 기본/생성/고급 편집을 분리했고, 업로드 키는 서버 별도 파일로 보관해요. 작업 현황·읽기·채팅 설정과 모바일 탐색도 공통 Dialog 규칙을 사용해요. 최종 source/build `69477f9e7570713d5848c985a676ae2c12b74ea3934bc70178306826e3f03851`에서 타입·빌드 및 [전체 브라우저 61/61](../output/playwright/redesign-2026-09-07T10-59-01-192Z-8c0265f7/summary.json)이 PASS예요. 직전 동일 백엔드의 전체 단위 948/948, provider 전용 9/9와 화면 검증도 PASS이며, 세부 지문·첫 FAIL·실제 Google 미검증 범위는 [통합 결과](PROVIDER-UX-RESULTS.md)에 기록했어요. 커밋·푸시는 하지 않았어요.


Risu 원본 변환은 앱 밖으로 분리했어요. 통합 ‘자료 가져오기’ 화면/API와 부분 변환기를 제거하고 기존 자료·프롬프트 편집기의 native JSON 검증·초안·저장 경로를 유지해요. [이식 가이드](../docs/RISU-PORTING.md)와 [정리 결과](RISU-PORTING-RESULTS.md)를 확인해요. 관련 단위·통합 **25/25**, 병행 작업과 분리한 소스 복사본의 타입·빌드 및 native/package-editor 브라우저 **6/6 PASS**예요. 이는 계속 변경 중인 main 작업트리 전체의 최신 회귀 결과를 뜻하지 않아요.

앞선 설정 항목 분리에서는 **일반 / 연결과 모델 / 데이터 관리 / 접근 보안**으로 분리했어요. 데스크톱은 왼쪽 메뉴와 오른쪽 콘텐츠, 760px 이하는 상단 메뉴와 전체 화면을 사용해요. 방문한 항목은 숨겨서 연결·모델 초안을 유지하며, 키보드 방향키·Home/End로 이동할 수 있어요. 접힌 상세 입력을 모달 포커스 순환에서 제외했어요. 최종 source/build `9412de85cd371c190b8b4de57d5bc808cc84fa88ca1780f7d2c30df3885a1565`에서 타입·빌드, [UI 단위 9/9·브라우저 20/20](../output/playwright/ui-2026-09-07T10-30-35-471Z-73c23a24/summary.json), [4개 화면 크기 확인](../output/playwright/settings-categories-2026-09-07T10-30-21-877Z-06b56df7/summary.json)이 PASS예요. 포커스 수정 전 source `eee81db49cfbd9a048acffe61f8cb6187be56552346258f2ae811f7c15406f28`의 [전체 브라우저 회귀 56/56](../output/playwright/redesign-2026-09-07T10-27-41-288Z-97f4f574/summary.json)도 PASS이며 최종 전체 회귀 재실행으로 보지는 않아요. 추가 화면 검사 두 회차에서 포커스 순환 FAIL을 확인한 뒤 수정했으며, 실제 휴대폰 검증은 하지 않았어요.


앞선 화면 변경은 앱 **설정**을 데스크톱 중앙 팝업·760px 이하 전체 화면으로 바꾼 작업이에요. `web/main.tsx`와 `web/style.css`의 설정 전용 배치만 변경했고 저장/API 동작은 유지해요. [UI 검증](../output/playwright/ui-2026-09-07T10-19-02-087Z-d4098962/summary.json)은 단위 **9/9**·브라우저 **19/19 PASS**, [설정창 추가 검증](../output/playwright/settings-modal-2026-09-07T10-19-04-310Z-7b57c31c/summary.json)은 4개 화면 크기의 배치·포커스·Esc 동작 PASS예요. 타입·빌드를 통과했고 해당 source/build는 `de868ff5602a86307c6a866b76cd1ab4827314efc3149f234a32b76c52c84198`이에요. 실제 휴대폰 검증이나 전체 회귀 재실행을 뜻하지 않아요.

앞선 병행 작업은 [Risu 전용 변환기 정리와 이식 가이드](RISU-PORTING-RESULTS.md)예요. self-host 검증이 끝난 뒤 전용 변환기를 제거하고 공통 native 실행 계약은 유지했어요. 해당 변경은 관련 단위·통합 **104/104**, native 브라우저 **3/3**, 타입·빌드·cleanup을 통과했으며 아래 self-host 전체 검증 수치를 이 후속 변경에 합산하지 않아요. 해당 검증 빌드의 source는 `384a0239df0f4062ea393894f1754451e6f7edbdaa2c5fcd62319d3e14c2f270`이에요.

개인 서버 후속은 [Self-host 구현 결과](SELF-HOST-RESULTS.md)에 정리했어요. `e707c28`에 기존 작업을 커밋한 뒤 HTTPS origin·필수 토큰·세션 복구·인코딩 API 인증 검사, Docker Compose/Nginx·영구 SQLite 구성을 추가했어요. 이 변경의 타입·빌드, 전체 단위·통합 **964/964**, 기존 브라우저 **55/55**, 전용 HTTPS **2/2**, 소스 일치·cleanup·1440/390px 화면 검증을 완료했어요. 실제 Linux·외부 서버·휴대폰 검증은 아직 수행하지 않았어요. 후속 self-host 변경은 작업트리에 남아 있어요.

앞선 [공통 행동 실행 결과](ACTION-EXECUTION-RESULTS.md)에서는 행동별 자동·사용자·모델 호출, 생성 중 임시 상태와 판정 기회 재사용, 여러 패키지 상태의 원자적 반영, 제작 UI 및 구버전 호환 경로 정리를 구현했어요. 현재 schema/archive는 v8이며 기본 개발 DB와 구형 자동 백업도 초기화했어요. 당시 타입·빌드, 단위·통합 **932/932**, 브라우저 **55/55**, 소스 일치·cleanup·390px 화면 검증을 완료했어요.

앞선 CBS 후속 보강 구현은 [패키지 동작 결과](PACKAGE-BEHAVIOR-RESULTS.md)에 정리했어요. 읽기 문맥·계산/반복/목록/날짜·패키지 상태와 액션·원문 파서·기록된 난수 및 schema/archive v7을 추가했어요. 당시 타입·빌드, 단위·통합 **860/860**, 브라우저 **53/53**, 소스 일치·cleanup 검증을 통과했어요. 아래 개편 및 milestone 수치는 각 시점 기록으로 보존해요.

기준일: 2026-09-07. `main`의 `82a1352`까지 native 통합을 커밋·push한 뒤, 봇 중심 탐색·폴더·공통 패키지·프롬프트 옵션 조합·자료 가져오기와 행동 실행을 구현하고 `e707c28`에 커밋했어요. 이 커밋은 아직 push하지 않았어요. 각 구현과 검증 근거는 [봇 중심 개편 결과](REDESIGN-RESULTS.md), [공통 행동 실행 결과](ACTION-EXECUTION-RESULTS.md)에 있으며 이전 단계별 결과는 당시 기록으로 보존해요.

## 구현과 남은 범위

| 단계 | 구현·검증된 범위 | 남은 범위 |
| --- | --- | --- |
| M0 | 서버 소유 실행·SQLite·채팅 격리·재접속·실패 탐지, F01–F06 | M0 범위 완료 |
| M1 | 콘텐츠·연결·전체 프롬프트, 요청 시 최신 번역·제한 재시도·직접 편집, 포크·읽기 위치·백업, P01–P13 로컬 통과 | 실제 폰·접속 환경 L02, 공급자별 L01 미확인 경로, Q01/Q02/Q03/Q05 품질 |
| M2 | 상태 계산·대기·무효화/복구, 기억·checkpoint·원문 회수, 장면 예약·표현·에셋. 자료별 실행기는 공통 패키지 행동·다음 요청 예약·원문 구간 정책으로 통합 | Q04 실제 장기 의미·비용 평가와 개인 자료의 공통 형식 재이식. 과거 Hinano/Hidden 전용 구현 증거는 현재 형식 호환을 보증하지 않음 |
| M3 | 모델 프리셋별 선택형 평가 도구를 본문·번역·상태·이미지·기억에 연결하고 연결·모델 관리, 검토 후 적용하는 등록 보조 구현 | E01–E03 전체 인수 미실행. 실제 공급자별 도구 호환·일반 MCP/외부 action·공개 배포는 별도 범위 |

M1·M2 로컬 통과를 전체 인수 완료로 표시하지 않아요. 실제 봇의 Lua/CBS 호환이나 실제 모델 품질을 합성 검사로 보증하지 않아요.

## 이전 단계의 검증 근거

앞선 봇 중심 개편 당시 타입·빌드 PASS, 전체 단위 **799/799 PASS**, 전체 브라우저 **51/51 PASS**였어요. [브라우저 summary](../output/playwright/redesign-2026-09-07T07-06-33-500Z-ec4cd36c/summary.json)의 cleanup도 PASS이며 실패·skip은 없어요. source/build는 `2c866495e394ae1d0f020343273d6f97b0d7dae022a6558bf5c93e6968f7e358`, dist는 `ca3581f2ca477fb559714f948ab192c5e93448abbbb218c12e36f04b9687dc0a`예요. 단위 실행 이후 UI 수정과 최종 검증의 정확한 범위는 [상세 결과](REDESIGN-RESULTS.md#검증)에 있어요.

당시 공통 패키지와 전역 창작 조합, schema/archive v6, 봇 소속·폴더·포크를 구현했어요. 현재 저장 형식은 v8이며 구형 DB/archive 자동 이관은 지원하지 않아요. 프롬프트 제작은 선택형 템플릿과 TypeScript→AST 후보를 비교할 수 있으며 기본 방식은 미확정이에요. 당시에는 JSON/CHARX 카드 초안과 미지원 보고를 제공했지만 이후 앱의 Risu 변환 경로는 제거했어요. 현재는 기존 편집기의 native JSON 가져오기만 제공해요. [개편 계약](REDESIGN.md), [사용 안내](../docs/USAGE.md)를 확인해요.

이전 [native 통합 결과](NATIVE-RESULTS.md)와 [통합 증거](../output/native-porting/FINAL-VERIFICATION.json)는 다음과 같아요.

| 검사 | 당시 결과 |
| --- | --- |
| 타입 검사·빌드 | PASS |
| 전체 Vitest | 718/718 PASS, 실패·skip 0 |
| M0 / M1-local / M2-local | 단위 13/55/78 + 브라우저 3/6/4 PASS |
| 기존 UI / native UI | 단위 9 + 브라우저 19 / 브라우저 3 PASS |
| 공급자 관리 / 로딩 / Sol UI | 브라우저 6 / 4 / 2 PASS |
| 검증기 selftest / 기억 offline | 실패 탐지 11 PASS / 합성 probe 10, 로컬 도구 24회, 모델·네트워크 0회 |
| 실제 자료의 별도 로컬 조립 | 일반·도구 프리셋 2개, 각 45개 제어, 원본 4개 SHA-256 불변, provider attempt 0 |
| 화면·정리 | desktop·390px 수동 확인, 검증 서버 cleanup PASS, 별도 실제 패키지 QA 서버·탭 종료 |

브라우저는 총 **47개**예요. 선택 단위 검사는 전체 718개와 중복돼요. 전체 실행의 source/build는 `a04c806ede5fc71609a2b849e631406193cb63889dbb65c374077c49903bf03b`이고, 마지막 native 테스트 기대값을 정정한 최종 source/build는 `42ef97d9bc4dc9cd8b0865fef2300bac0c3101fa73942b7e61f01f57e0bdda80`예요. 두 빌드의 dist SHA-256은 `d1fa5d3b269e4da8143afb3f646fbe5f593592404b900bed336112419fe32e35`로 같아요. 마지막 테스트 파일 하나를 이전 내용으로 바꾸어 계산하면 전체 실행의 source hash와 정확히 일치해요. 제품 코드는 동일하며, 마지막에는 타입·빌드·native UI·실제 자료 조립을 다시 확인했어요. 초기 FAIL 보고서를 고치거나 삭제하지 않았어요.

다음 표는 **후속 native 통합 전** [Sol 통합 결과](SOL-RESULTS.md)와 [로컬 summary](../output/sol-provider/2026-09-07/summary.json)의 역사적 기록이에요.

| 검사 | 결과 |
| --- | --- |
| 전체 Vitest | 598/598 PASS, 실패·skip 0 |
| M0 | 단위 13 + 브라우저 3 PASS |
| M1-local | 단위 55 + 브라우저 6 PASS |
| M2-local | 단위 78 + 브라우저 4 PASS |
| 기존 UI / Sol UI | 단위 9 + 브라우저 19 / 브라우저 2 PASS |
| 검증기 selftest | 실패 탐지 11 PASS |
| 정리 | 검증 서버 5개 cleanup PASS |

선택 단위 검사는 전체 598개와 중복되며 브라우저는 합계 34개예요. source/build는 `881ae5a7ea83909a77556f7d2cbb5c6341f345388d8294c775db5161d5ded63c`, dist는 `527639a18db32e4d8c27014623d30a3aa7b537fb8d40ade8d11257f755f5ec20`예요. 문서 정리는 제품 코드와 빌드를 바꾸지 않아요.

`output/`은 Git에 포함되지 않는 로컬 증거예요. 새 checkout에서는 [개발·검증 안내](../docs/DEVELOPMENT.md)에 따라 새 격리 DB·포트로 검증해요. 기존 사용자 DB는 테스트에 사용하지 않아요.

## 실제 API와 다음 작업

- [패키지 동작 확장 계획](PACKAGE-BEHAVIOR-PLAN.md)은 복잡한 봇의 정적 조사 당시 설계안이에요. 이후 상태·계산·목록·추첨·출력 파서와 자동/사용자/모델 행동을 구현했어요. 현재 API는 [패키지 동작](../docs/PACKAGE-BEHAVIOR.md)을 따르며, 임의 Lua/CBS 호환·원본 에셋/UI 전체 이식·대용량 바이너리 자동 변환은 제공하지 않아요.
- Vertex 누적 **49회**는 실패·부분 응답·취소를 포함한 과거 합성 시험 기록이에요. 일부 생성·도구·번역 경로를 확인했지만 전체 live 여정의 FAIL/INCOMPLETE를 유지해요. [실행 기록](M1-RESULTS.md)
- 예산 계산 **$13.20591375**는 usage 추정과 불확실 요청의 예약 합계이며 실제 청구액이 아니에요. 이후 번역·M2·Sol 구현 검증의 추가 유료 호출은 0회예요.
- 품질 실험은 사용자 지시로 중단됐어요. 새 평가를 진행하려면 자료·모델·요청 수·USD 범위와 재개 여부를 정해요. M2 평가는 별도 범위예요.
- Phēmē V4.0.6 일반/도구 프리셋·비성적 Hinano 각색·히든 스토리 3.43의 native 구현과 [대응표](NATIVE-PORTING.md)를 정리했어요. 모델·추론 설정과 별개로 role/순서/조건/이력/채팅별 45개 제어 조합을 저장해요. 실제 폰 검증에는 접속 환경이 필요해요.
- 실제 변환본을 담은 격리 DB와 [로컬 실행 안내](../output/native-porting/actual-preview-6ckp2o/OPEN-PREVIEW.md)를 남겼어요. 모델 연결이 없는 개인 검증 DB이고 `output/` 밖으로 복제·재배포하지 않아요. 일반 Phēmē의 화면 45개 블록·45개 제어·두 이력 구간·37개 메시지 미리보기와 비성적 봇 설정을 당시 고정 빌드에서 직접 확인했어요. 해당 DB가 현재 schema와 호환된다는 뜻은 아니에요.
- 최신 앱은 프로젝트 루트의 `npm run dev`로 실행해요. 이전 세션의 미리보기는 당시 고정 빌드이므로 현재 버전 확인에 사용하지 않아요.

## 상세 기록

[사용법](../README.md) · [M0 결과](M0-RESULTS.md) · [M1 결과](M1-RESULTS.md) · [M2 결과](M2-RESULTS.md) · [native 통합 결과](NATIVE-RESULTS.md) · [UI 결과](UI-RESULTS.md) · [선택형 평가 도구](EVALUATION-TOOLS.md) · [참고 근거](SOURCES.md)

단계별 결과의 수치·snapshot·실패 기록은 해당 시점의 증거로 보존해요. 과거 인계 문구와 미리보기 주소를 현재 상태로 해석하지 않아요.

## 문서 정합성 확인 · 2026-09-07

프로젝트 Markdown 51개를 대상으로 문서 지도·명령·로컬 링크와 주요 API/설정 설명을 점검했어요. v8 전용 DB/archive, self-host, 공통 Risu 이식, 실행·검증 명령과 설정창 변경을 반영하고 과거 설계·검증 기록을 현행 계약과 구분했어요. 문서·소스 링크, 문서 내부 anchor, npm script 이름 검사는 통과했어요. 과거 `output/` 증거 14개는 현재 폴더에 없어 해당 결과 문서에 재확인 불가를 표시했어요. [정적 검사 결과](../output/documentation-audit/summary.json)

이번 문서 정리는 앱 테스트를 새로 실행한 작업이 아니에요. 위 검증 수치는 각 결과 파일에서 확인한 실행 시점의 기록이며, 문서 수정은 앱 소스·빌드를 변경하지 않았어요. 외부 서비스 문서·가격·모델 목록의 최신성을 웹에서 다시 조사한 것은 아니에요.
