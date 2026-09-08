# 현재 작업 상태 · Uimori

2026-09-08 기준이에요. 이 파일은 현행 계약과 마지막 검증을 요약해요. 과거 작업의 수치·실패·소스 지문은 아래 결과 문서에 보존하며, 해당 시점의 PASS를 현재 코드나 실제 공급자 검증으로 확대하지 않아요.

2026-09-08 사용자 요청으로 검증된 협업·v13·UI 통합본을 원본 `main`에 반영했어요. 반영 전 전체 Git tree와 source 지문이 전용 브랜치 완료본과 같은지 확인하고 원본에서 품질 검사를 통과했어요. 아래의 전용 브랜치 검증·원본 미변경 설명은 이 반영 이전 검증 단계의 기록이에요. 실제 운영 재배포 결과는 별도 `output/oracle-update-2026-09-08/`에 보관해요.

공통 UI·상세 화면 적용 후 사용자가 요청한 커밋·푸시·Oracle 재배포의 실제 결과는 [후속 배포 기록](../output/oracle-ui-deploy-2026-09-08/RESULTS.md)에서 확인해요. 아래의 미커밋·배포 미포함 설명은 각 구현 검증 당시의 기록이에요.

## 현재 구현

- 채팅 설정 7개 분야와 고급 패키지 9개 분야에 모바일 목록→상세·데스크톱 병치를 적용했어요. 프롬프트 저장과 채팅 적용을 구별하고 관리·구성 도구와 장면 하단 작업은 메뉴로 모았어요. 분야 왕복·닫기·뒤로가기에서 초안·파일·커서·초점과 기존 저장 계약을 유지해요. [상세 화면 구현·검증](UI-DETAIL-IMPLEMENTATION.md)
- 공통 UI·아이콘을 설정·서재·프롬프트·연결과 모델·데이터 관리에 적용했어요. 모바일 설정은 목록→상세로 이동하고 데스크톱은 나란히 보여줘요. 제목 중복·관리 도구의 기본 노출을 줄이고, 빈 상태·검색 복구·미저장 초안·뒤로가기·메뉴 안의 삭제 보호를 유지해요. 자료 조회/화면 로딩 실패에도 탐색을 제공해요. [구현·검증 결과](UI-COMPACT-IMPLEMENTATION.md) · [공통 원칙](../docs/UI-PRINCIPLES.md)
- 메인 프롬프트의 **에이전트 협업**에서 지침·공유 옵션·모델·참여 시점과 조회 권한을 직접 설정해요. 기본은 OFF이며 생성 전 자문 또는 메인의 필요 시 호출을 지원해요. 예약된 Run에 설정·모델을 고정하고 전체 호출 한도·취소·원문 귀속을 유지해요. [협업 계약](../docs/AGENT-COLLABORATION.md)
- 자료·프롬프트·공유 모듈은 같은 ID의 최신 저장 내용을 다음 실행에서 사용해요. 전역 옵션 조합은 현재 정의로 검증하고, 이미 예약한 실행과 과거 원문은 자체 snapshot을 유지해요. [현재 설정 계약](CURRENT-SETTINGS-PLAN.md) · [번역 구간과 재시도](TRANSLATION-CHUNKS.md)
- **DB schema / 전체 JSON archive v13**예요. 봇·페르소나·모듈은 공통 패키지이며 서재의 분류별 폴더·대표 이미지와 별도의 프롬프트 관리를 제공해요. 분류·폴더 정리는 내용 개정 및 채팅에서 사용하는 역할과 독립적이에요. [서재 계약](../docs/LIBRARY.md)
- 봇별 채팅·폴더, 드래그 이동·정렬, 대화별 접고 펼치는 작업 현황, 원문 수정·응답 후보·번역·포크를 제공해요. 페르소나 선택에는 페르소나 분류와 ‘페르소나 없음’을 표시해요. [사용 안내](../docs/USAGE.md)
- 새 채팅은 봇·본문 모델을 먼저 고르고 선택 설정은 접어 보여줘요. 사용 가능한 최근 모델 또는 유일한 모델을 제안하고, 새 채팅의 자동 장면 상태는 기본 OFF예요. 모바일 서재는 전체 폭 목록과 간단한 자료 제작을 우선하며, 채팅 입력창의 추가 설정은 더보기에서 열어요. 원문·번역 직접 수정은 초점과 읽던 위치를 복원해요. [UIUX 테스트 후속 개선](UIUX-IMPROVEMENTS-2026-09-08.md)
- 프롬프트는 `PromptProgram` AST로 실행하고 블록 구성 편집을 사용해요. 새 프롬프트는 역할별 앱 기본 내용으로 시작하며 전송 미리보기는 접고 펼칠 수 있어요. 템플릿 문법과 TypeScript 제작 API는 선택 가능한 제작 방식이에요. [제작 방식](../docs/PROMPT-AUTHORING.md)
- 모델·연결은 최신 `provider_settings` 한 벌을 사용하며 `ModelRef`는 `{id}`예요. 과거 Run과 보조 작업은 자체 snapshot을 보존해요. 일반 실행은 역할별 모델 선택이 필수이며 모델 없는 합성 실행은 명시적 테스트 모드에서만 허용해요. [공급자](../docs/PROVIDERS.md) · [모델 파라미터](../docs/MODEL-PARAMETERS.md)
- 공통 패키지의 이미지·시작문·로어·상태와 행동, 다음 요청 예약, 원문 구간 정책을 사용해요. 자료별 native/hidden 실행기, 독립 `lore/canon/skill/glossary` 자료 종류와 앱 내부 Risu 변환기는 제거했어요. 외부 에이전트가 native JSON을 작성하고 기존 편집기에서 검토 후 저장해요. [패키지](../docs/PACKAGES.md) · [상태와 행동](../docs/PACKAGE-BEHAVIOR.md) · [Risu 이식](../docs/RISU-PORTING.md)
- full history와 전송 projection, source/hash·히든 viewHash·정사 의존성을 구분해요. 로어 유지와 자동 요약, 원문 수정에 따른 파생물 무효화, CAS·취소·불확실 실행의 자동 재생 금지를 유지해요. [입력 한도](../docs/CONTEXT-LIMITS.md) · [로어 문맥](../docs/LORE-CONTEXT.md) · [삭제 보호](../docs/DELETION.md)
- 개인 self-host용 HTTPS·토큰·영구 SQLite 구성과 선택형 Tailscale 배포 구성이 있어요. 실제 서버 배포는 별도 작업이며 이 정리의 검증 범위에 포함하지 않아요. [Self-host](../docs/SELF-HOST.md) · [Tailscale](../docs/TAILSCALE-DEPLOY.md)

구형 DB·archive는 자동 이관하지 않아요. 최신 앱은 프로젝트 루트에서 `npm run dev`로 실행하고, 사용자 DB를 검증용으로 사용하지 않아요. 과거 미리보기 DB·고정 빌드는 현재 형식과 호환된다는 뜻이 아니에요.

## 마지막 검증

상세 화면의 공통 UI 적용을 완료했어요. 채팅 설정·고급 패키지·프롬프트 저장/적용·장면 메뉴를 정리하고 작업 현황의 로딩 완료 화면을 검토했어요. `quality:full` **1,334 PASS · 1 opt-in skip**, 최종 품질·빌드 및 전체 브라우저 **163/163 PASS**예요. 단위 검사 후에는 공통 탐색의 줄바꿈 CSS와 브라우저 검사 진입·선택자만 보정했으며, 최종 UI 빌드를 전체 브라우저 검사와 대표 PNG 16장으로 확인했어요. 최종 source/build `47bbaa7ec72ff7702ca8fe30e2f7272e27d8ec899a1803b6457a0cacfda11dc1`, cleanup PASS예요. 미커밋 변경이며 실제 공급자·사용자 DB·휴대폰 실기기·배포는 검증 범위에 포함하지 않아요. [구현·초기 실패·최종 결과와 화면](UI-DETAIL-IMPLEMENTATION.md). 아래는 이 변경 이전 기록이에요.

공통 UI·아이콘 적용을 원본 `main` 작업공간에서 완료했어요. `quality:full` **1,334 PASS · 1 opt-in skip**, 마지막 품질·빌드 및 전체 브라우저 **152/152 PASS**예요. 전체 단위 검사 뒤에는 브라우저 검사 선택자·서식만 수정했고 실행 산출물 지문은 같아요. 최종 source/build `f064957943728cd7b3f07f3b7d3647cdf5c1e914894aac9dbd9f92c85d352361`, 6개 폭의 대표 배치·390px/1440px 화면 검토·cleanup PASS를 확인했어요. 이번 변경은 미커밋이며 사용자 DB·실제 공급자·배포·push는 포함하지 않았어요. [구현·초기 실패·최종 검증과 화면](UI-COMPACT-IMPLEMENTATION.md). 아래는 이 변경 이전 기록이에요.

전용 브랜치 `codex/main-agent-collaboration`에서 v13 설정 계약·UIUX 개선 완료본·커스텀 협업 에이전트의 통합을 완료했어요. `quality:full` **1,331 PASS · 1 opt-in skip**, 협업 화면 **2/2 PASS**, 최종 품질·빌드·전체 브라우저 **137/137 PASS**예요. 전체 단위 검사 뒤 브라우저 진입·문구와 협업 체크박스 CSS·캡처만 보정했어요. 최종 source/build `244b36200b7753993f68dd8da855c8bb3b40bbfb2b377a0275ad2c172564b9a6`과 실행 산출물 일치·390px/1440px 화면 검토·cleanup PASS를 확인했어요. 원본 main 작업공간·사용자 DB·실제 공급자·원격 push는 변경·사용하지 않았어요. [구현·통합 기준·최초 실패와 최종 검증](AGENT-COLLABORATION-RESULTS.md). 아래는 각 작업의 통합 전 기록이에요.

2026-09-08 자료·프롬프트·공유 모듈을 최신 저장 내용으로 사용하는 흐름으로 단순화했어요. 전역 옵션 조합은 같은 프롬프트 ID에서 재사용하며 현재 정의로 검증해요. 본문 개정은 패키지 상태·추첨을 유지하고, 동작 정의 변경은 기존 상태 확인 후 명시 reset을 요구해요. 현재 설정과 실행 snapshot을 분리하고 `story_configs`·등록 도우미의 중간 전체복사본 누적을 최신 1행으로 정리했어요. 현재 schema/archive는 **v13**이에요. 번역 구간 기준 설정과 현재설정 재시도 변경도 보존했어요. 최종 `quality:full` **1,260 PASS·1 opt-in skip / 타입·빌드 PASS**, 전체 브라우저 **122/122 PASS**, source/build 일치·390px 화면 검토·cleanup PASS예요. 사용자 DB·실제 공급자 호출·commit/push는 수행하지 않았어요. [계획·변경·초기 실패와 최종 검증](CURRENT-SETTINGS-PLAN.md) · [번역 구간과 재시도](TRANSLATION-CHUNKS.md).

UIUX 테스트 후속 개선에서 새 채팅·입력창·모바일 서재·직접 수정 초점·대표 작업 상태를 정리했어요. `quality:full` **1,280 PASS · 1 opt-in skip**, 최종 품질·빌드와 전체 브라우저 **133/133 PASS**를 확인했어요. 이후 브라우저 진입 절차만 보정했고 실행 산출물 지문은 단위 검사 때와 동일해요. 최종 source/build `d6e9e7807fcda7e6838994a8c9000788b9975f427c0e86f154252c7fc5997d56` 일치와 cleanup PASS예요. 새 유료 모델 호출·사용자 DB 사용은 없어요. [구현 범위·화면·최초 실패·남은 기능](UIUX-IMPROVEMENTS-2026-09-08.md)

추가 유지보수에서 남은 검증기 6개를 공통 실행기로 통합하고 fixture 오류·필수 PNG 판정, 로딩 측정의 중첩 transaction과 문서 계약을 고쳤어요. 격리 사본에서 `quality:full` **1,274 PASS · 1 opt-in skip**, 하네스 회귀 **20/20 PASS**, 전체 브라우저 **124/124 PASS**, 프롬프트 검증 **6/6 PASS**, 로딩 측정·DB 무결성·cleanup PASS를 확인했어요. 최종 source/build `664d189428dc335f6636b53f8c0008f881df700e0383a1d268da68486b402ab7`은 원래 작업공간 코드와 일치해요. 검증에는 사본 시점의 병행 보조 복구 변경도 포함돼 있어요. [추가 점검·첫 실패·검증 범위](MAINTENANCE-RESULTS.md#추가-점검--2026-09-08)

직전 화면 지연 로딩 개선 시점에는 최대 JS chunk **705→375kB**, 초기 JS 합계는 서재 **522kB**·채팅 직접 진입 **413kB**가 되었고 500kB 빌드 경고가 사라졌어요. CI의 미빌드 서버 실행을 막도록 `quality:full`을 quality→build→test 순서로 바꾸고, 100-source reader fixture의 반복 컴파일 비용을 줄였어요. 당시 `quality:full` **1,263 PASS · 1 opt-in skip**, 최종 품질·빌드 및 전체 브라우저 **123/123 PASS**, source/build `44fe90ef5b5c823cb4d6750a3608d23ca7ea727edd729cfadea1a6c172069bed` 일치와 cleanup PASS를 확인했어요. 원격 Actions 재실행은 아직이에요. [원인·변경·첫 실패·최종 검증](BUNDLE-CI-RESULTS.md)

직전 코드·문서·하네스 정리에서는 미사용 CSS·초기 캡처 도구·중복 실행기를 정리하고 소유권·취소·환경변수 격리 회귀를 보강했어요. 당시 전체 브라우저 **120/120 PASS**, 기존 검증기 selftest **11/11 PASS**와 해당 빌드의 증거는 [유지보수 결과](MAINTENANCE-RESULTS.md)에 보존해요.

직전 서재 개편은 단위·통합 **1,248 PASS · 1 opt-in skip**, 마지막 UI 수정 후 타입·빌드·전체 브라우저 **120/120 PASS**, 별도 이미지 실패/복구와 cleanup을 확인했어요. 해당 시점의 [최종 결과와 초기 실패](LIBRARY-RESULTS.md)를 보존해요.

일상 수정은 `npm run quality`, 완료·통합 전에는 `npm run quality:full`, UI 변경은 빌드 후 관련 `verify:*` 또는 `npm run verify:redesign`으로 확인해요. [검사 기준](../docs/QUALITY.md) · [실행·증거 안내](../docs/DEVELOPMENT.md)

## 남은 인수 범위

| 단계 | 구현·로컬 검증 범위 | 남은 범위 |
| --- | --- | --- |
| M0 | 서버 소유 실행·SQLite·채팅 격리·재접속·실패 탐지, F01–F06 | M0 범위 완료 |
| M1 | 콘텐츠·연결·전체 프롬프트, 요청 시 최신 번역·제한 재시도·직접 편집, 포크·읽기 위치·백업, P01–P13 | 실제 폰·접속 환경 L02, 공급자별 L01 미확인 경로, Q01/Q02/Q03/Q05 품질 |
| M2 | 상태 계산·대기·무효화/복구, 기억·checkpoint·원문 회수, 장면 예약·표현·에셋, 공통 패키지 실행 | Q04 실제 장기 의미·비용 평가, 개인 자료의 공통 형식 재이식 |
| M3 | 모델 프리셋별 선택형 평가 도구, 연결·모델 관리와 검토 후 적용하는 등록 보조 | E01–E03 전체 인수, 실제 공급자별 도구 호환, 일반 MCP/외부 action·공개 배포 |

실제 모델 품질·청구 비용·휴대폰/IME·Linux/Docker 동작은 로컬 합성 검증으로 보증하지 않아요. 과거 Vertex 시험 49회와 사용량 추정은 [M1 기록](M1-RESULTS.md)에 남아 있으며 현재 청구액이 아니에요. 중단된 품질 실험이나 유료 실행은 새 승인 없이 재개하지 않아요. M2 의미 품질 평가는 별도 범위예요.

## 상세 결과와 이전 기록

각 문서는 작성 당시의 범위·실패·미완료를 보존해요. 같은 기능의 후속 결과가 있으면 최근 구현을 우선 확인해요. `output/` 링크는 Git에 포함되지 않는 로컬 증거이며 새 checkout에서 열리지 않을 수 있어요.

| 영역 | 기록 |
| --- | --- |
| 공통 UI·아이콘 | [상세 화면 구현과 검증](UI-DETAIL-IMPLEMENTATION.md) · [설정·서재·연결·데이터 구현과 검증](UI-COMPACT-IMPLEMENTATION.md) · [공통 원칙](../docs/UI-PRINCIPLES.md) · [화면 설계](../docs/UI-SCREEN-DESIGN.md) |
| 서재·이미지·탐색 | [서재 결과](LIBRARY-RESULTS.md) · [탐색 결과](NAVIGATION-RESULTS.md) · [장면 탐색](SCENE-NAVIGATION.md) |
| 공통 실행 구조·품질·삭제 | [구조 정리 결과](CODEBASE-CLEANUP-RESULTS.md) · [품질 도구](QUALITY-RESULTS.md) · [삭제 결과](DELETION-RESULTS.md) |
| 모델·입력 한도·로어 통합 | [최종 통합](PROVIDER-PARAMETERS-RESULTS.md) · [공통 자료](SHARED-PACKAGE-RESULTS.md) · [로어 유지](LORE-CONTEXT-RESULTS.md) |
| 공급자·Codex·평가 도구 | [관리](PROVIDER-MANAGEMENT-RESULTS.md) · [관리 UI](PROVIDER-UX-RESULTS.md) · [Codex](CODEX-RESULTS.md) · [선택형 평가 도구](EVALUATION-TOOLS.md) · [세션 통합](SESSION-INTEGRATION-RESULTS.md) |
| 패키지·프롬프트·화면 | [봇 중심 개편](REDESIGN-RESULTS.md) · [상태와 행동](PACKAGE-BEHAVIOR-RESULTS.md) · [자동 행동](ACTION-EXECUTION-RESULTS.md) · [프롬프트 편집](PROMPT-EDITOR-RESULTS.md) · [초기 UI](UI-RESULTS.md) |
| 로딩·보조 문맥 | [로딩](LOADING-RESULTS.md) · [서재 로딩](LIBRARY-LOADING-RESULTS.md) · [번역 문맥](TRANSLATION-CONTEXT-RESULTS.md) · [기억 평가](MEMORY-EVALUATION-RESULTS.md) |
| 배포·외부 이식 | [Self-host 구현](SELF-HOST-RESULTS.md) · [Risu 변환 경로 정리](RISU-PORTING-RESULTS.md) · [과거 native 통합](NATIVE-RESULTS.md) · [당시 자료 대응표](NATIVE-PORTING.md) |
| Milestone·기초 설계 | [M0](M0-RESULTS.md) · [M1](M1-RESULTS.md) · [M2](M2-RESULTS.md) · [제거 전 Sol](SOL-RESULTS.md) · [계획 지도](README.md) · [채택 근거](SOURCES.md) |
