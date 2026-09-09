# Uimori 계획과 인수 기준

이 디렉터리는 제품 범위·설계·검증 계약을 관리해요. v0.6.1 착수 명세(2026-09-06)를 바탕으로 후속 사용자 결정과 구현 결과를 반영했어요. **현재 진행은 [CURRENT.md](CURRENT.md)**, 앱 실행은 [루트 README](../README.md)를 먼저 확인해요.

## 문서 지도

| 파일 | 내용 |
| --- | --- |
| [CURRENT.md](CURRENT.md) | 현재 구현, 검증 근거, 남은 작업 |
| [도우미·통합 문맥 관리 확정 계획 v3](HELPER-CONTEXT-PLAN.md) · [구현 결과](HELPER-CONTEXT-RESULTS.md) | fresh v15, 기억 추출 대체, 공통 초안·작품 맥락·허가, 텍스트·공개 응답 스트리밍과 이미지 이해 후속 인계 |
| [공통 UI·아이콘 원칙](../docs/UI-PRINCIPLES.md) | 데스크톱·모바일의 공통 의미·아이콘, 화면 폭에 따른 배치, 후속 적용·확인 기준 |
| [설정·서재 화면 설계](../docs/UI-SCREEN-DESIGN.md) | 데스크톱·모바일 시안, 연결·모델·데이터 관리, 메뉴·빈 화면·편집 상태와 아이콘 명세 |
| [UI 설계 v2 · 원고가 화면이다](../docs/UI-DESIGN-V2.md) | 2026-09-08 실행 화면 검토 뒤의 제안 설계. 채팅 리더·입력창·탐색·서재의 세 층 모델, 수치 목표, 뒤집는 결정과 적용 순서. 구현·검증 전 |
| [공통 UI·아이콘 구현 결과](UI-COMPACT-IMPLEMENTATION.md) | 설정 목록·상세, 서재·모델·연결·데이터, 초안·뒤로가기 보호와 반응형 검증 |
| [상세 화면의 공통 UI 적용](UI-DETAIL-IMPLEMENTATION.md) | 채팅 설정·고급 패키지 분야, 프롬프트 저장·관리와 장면 작업 메뉴, 초안·초점·반응형 검증 |
| [커스텀 협업 결과](AGENT-COLLABORATION-RESULTS.md) · [사용·실행 계약](../docs/AGENT-COLLABORATION.md) | 프롬프트별 보조 지침·모델·공유 옵션, 제한된 자문 실행과 v13·UI 통합 |
| [화면 지연 로딩·CI 결과](BUNDLE-CI-RESULTS.md) | 초기 JS 다운로드 감소, 빌드 경고와 CI 검사 순서·대량 fixture 수정 |
| [코드·문서·하네스 유지보수](MAINTENANCE-RESULTS.md) | 현행 안내 정합성, 미사용 코드·중복 실행기 정리와 검증 |
| [서재 정리 결과](LIBRARY-RESULTS.md) · [서재 계약](../docs/LIBRARY.md) | 서재·프롬프트 분리, 분류·폴더·대표 이미지와 v12 자료 계약 |
| [코드베이스 정리 결과](CODEBASE-CLEANUP-RESULTS.md) · [원문 구간](../docs/SOURCE-SEGMENTS.md) | native/hidden 전용 경로를 공통 패키지·프롬프트로 통합한 당시 증거와 현재 구간 계약 |
| [코드 품질 결과](QUALITY-RESULTS.md) · [검사 안내](../docs/QUALITY.md) | 서식·lint·타입·모듈 경계와 완료 검사 |
| [Codex 결과](CODEX-RESULTS.md) · [Codex 연결](../docs/CODEX.md) | 공식 서버 에이전트의 역할별 연결·개인 구독 로그인·합성 검사·실제 실행 미확인 범위 |
| [선택형 평가 도구](EVALUATION-TOOLS.md) | 모델 프리셋 opt-in, 네 도구 계약, 원본 비교와 provider 분리 |
| [Self-host 결과](SELF-HOST-RESULTS.md) · [배포 안내](../docs/SELF-HOST.md) | 개인 HTTPS 서버 구성·인증과 로컬 검증, 실제 Linux/기기 미확인 범위 |
| [Risu 이식 결과](RISU-PORTING-RESULTS.md) · [이식 가이드](../docs/RISU-PORTING.md) | 전용 변환기 제거, 공통 native 계약 유지와 에이전트 이식 절차 |
| [공통 행동 결과](ACTION-EXECUTION-RESULTS.md) · [패키지 동작 결과](PACKAGE-BEHAVIOR-RESULTS.md) | 상태·계산·추첨·자동/사용자/모델 행동의 구현 및 당시 검증 |
| [봇 중심 개편](REDESIGN.md) · [개편 결과](REDESIGN-RESULTS.md) | 봇 소속·폴더·공통 패키지·프롬프트 제작과 검증 |
| [패키지 동작 확장 계획](PACKAGE-BEHAVIOR-PLAN.md) | 복잡한 봇의 정적 분석에 따른 초기 설계와 이후 구현 범위의 구분 |
| [PROJECT.md](PROJECT.md) | 목적, 우선순위, 실제 사용 조건, 비목표 |
| [MILESTONES.md](MILESTONES.md) | M0–M3 범위와 종료 조건 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 데이터·자율 조회·역할별 처리·번역·상태·이미지 계약 |
| [VERIFICATION.md](VERIFICATION.md) | 검사·실패·승인·증거 계약 |
| [ACCEPTANCE.json](ACCEPTANCE.json) | 인수 ID, 기대 결과, 증거와 주장 한계 |
| [SOURCES.md](SOURCES.md) | 참고 자료와 채택·비채택 근거 |
| [M0 결과](M0-RESULTS.md) · [M1 결과](M1-RESULTS.md) · [M2 결과](M2-RESULTS.md) | 단계별 구현과 당시 검증 기록 |
| [UI 결과](UI-RESULTS.md) · [이전 Sol 결과](SOL-RESULTS.md) | 후속 UI와 제거 전 Sol provider의 역사적 통합 기록 |

새 작업은 CURRENT에서 남은 범위를 확인한 뒤 관련 계약만 읽어요. 인수 목록의 모든 향후 항목을 한 번에 구현할 필요는 없어요. 현재 사용자 요청을 우선하며 파일 간 실질적 충돌은 결정과 영향을 기록해요.

## 초기 명세와 작업 지시

[REVIEW.md](REVIEW.md)는 초기 v0.6.1 명세 검토 기록이에요. `KIT_VALIDATION.json`은 당시 계획 묶음의 구조 검사이며 앱·모델 품질 검증 결과가 아니에요.

[첫 M0 작업 지시](prompts/01-build-M0.ko.md)는 초기 착수 기록으로 보존해요. 후속 작업에는 [이어가기 지시](prompts/03-continue.ko.md), 별도 검토에는 [독립 검토 지시](prompts/02-review.ko.md)를 참고해요. 이미 구현한 M0를 다시 착수하거나 과거 지시를 동시에 실행하지 않아요. [AGENTS 템플릿](templates/AGENTS.md.template)도 초기 참고 자료이며 현재 지도는 [루트 AGENTS.md](../AGENTS.md)예요.

## 자료와 증거

개인 창작 자료는 Git 제외 경로인 `.local/reference/` 등에 보관하고 공개 테스트에는 합성 자료를 사용해요. 다른 공급자 평가로 재전송하거나 공개하려면 해당 범위의 허용이 필요해요.

결과 문서의 `output/` 링크는 해당 로컬 실행을 보관한 환경에서만 열려요. 과거 실패와 snapshot은 당시 근거로 보존하며 현재 인수 상태와 구분해요.
