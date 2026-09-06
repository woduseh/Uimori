# 현재 작업 상태

- 기준: v0.6.1 계획과 2026-09-06 사용자 M1 진행 요청. 실제 프로젝트는 `C:/Users/wodus/ai-workspace/ui-ai`이며 `claude-code` 소스는 변경하지 않았어요.
- 상태: **M1a/b/c의 로컬 흐름 구현·검증 완료. M1 전체는 외부 전제 대기.** 메인·번역 provider/API/model 선택, credential, 유료 시험 예산, 실제 폰/비공개 접속 환경이 정해지지 않아 L01/L02/Q01/Q02/Q03/Q05는 BLOCKED예요. 지금 지원하는 연결은 자체 `fixture-sse-v1`이며 실제 공급자 API 호환을 뜻하지 않아요.
- 구현: 콘텐츠 revision과 장착, native 창작 제어/CreativePreset, 수동 canon, 연결/catalog/manual model/역할 route, source-time 번역·보호구문·durable chunk 재시도, 표시 상태·이미지 annotation, 후보/후손·탭별 보기/초안/독서 위치, 사용량 Inspector, JSON/SQLite 백업·복원, 선택적 HttpOnly 인증.
- 저장소: Node SQLite WAL schema v2. 기존 populated schema v1을 열 때 `.pre-m1-….sqlite` 일관 백업을 먼저 만들어요. 작은 PNG/JPEG는 SQLite BLOB으로 함께 보관해요. 이번 작업에서는 사용자 `.local/narrative.sqlite`를 열거나 migration하지 않았어요.
- 코드 기준: 로컬 branch `codex/m1-local`; source/build ID `48e7f8e9fa3c13129c1775427996ff64f4c6d6bc22a6de7bea40e4b85d15185f`. dist SHA-256 `46a6d46866c08c22280d62c7d86da6089fb11be426a0924a2f27f0d81eb8bda3`. 검증 후 변경은 인수인계 문서뿐이에요.
- 최종 M1: `npm run verify -- --milestone M1-local` PASS. P01–P13 로컬 계약, Vitest 38 / Playwright 4, 필수 skip 0, cleanup PASS. 증거 `output/playwright/2026-09-06T12-39-38-385Z-71d8eb1d/summary.json`.
- M0 회귀: 같은 코드에서 `npm run verify -- --milestone M0` PASS. Vitest 13 / Playwright 3 / 검증기 selftest 11, cleanup PASS. 증거 `output/playwright/2026-09-06T12-37-13-274Z-9922fc39/summary.json`. M0의 기존 두 clean 작업트리 결과는 [M0-RESULTS.md](M0-RESULTS.md)에 있고 M1 두 작업트리 재검증으로 확대하지 않아요.
- 확인 환경: Windows 11 10.0.26200, PowerShell, Node 24.14.0, npm 11.14.1, SQLite 3.51.2, 실제 Chrome. sandbox 자식 프로세스 제한은 승인된 로컬 실행으로 검증했어요.
- 독립 검토 반영: native glossary 읽기 scope, 빈 profile의 합성 사실 누출, export/import 입력 불변·cycle·cross-chat 참조·에셋 MIME·변조 plan, aux 재시도 깨우기·완료 시 source 의존성, opaque 진단 노출, 중복 usage 완료를 수정·검증했어요.
- 실행: 기존 M0 서버를 실행한 터미널에서 Ctrl+C → `npm run dev` → `http://127.0.0.1:4310`. 기본 DB는 유지되고 첫 실행 시 v2 migration해요. 격리 실행·JSON 복원·선택적 인증은 [README](../README.md)에 있어요.
- 정리: 검증 전용 서버·브라우저·runtime/temp는 종료·정리했고 reporter/화면/SQLite 증거는 각 output에 보존했어요. 사용자 서버를 종료하지 않았고 commit은 로컬에만 남겨요.
- 다음 단계: 사용자에게 메인·번역의 provider/API 방식/model ID 및 허용 시험 예산을 받아 실제 adapter와 L01을 진행해요. 승인 전 유료 호출·외부 배포는 하지 않아요. 세부 범위·근거·제한은 [M1-RESULTS.md](M1-RESULTS.md)에 있어요.
