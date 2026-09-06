# 작업 지도

- 목적과 M0 계약: `project-plan/README.md`. 실제 코드/증거: `project-plan/CURRENT.md`.
- 코드: `web/` React, `server/` Fastify+파일 SQLite, `core/` 역할 입력/합성 provider. DB schema v1은 `server/store.ts`에 있어요.
- 확인한 명령: `npm run check`, `npm run build`, `npm run doctor`, `npm run verify -- --milestone M0`, `npm run verify:selftest`. Windows Node 24.x/PowerShell에서 실행해요.
- 검증은 새 포트/DB를 사용하고 `output/playwright/<run-id>/summary.json`과 reporter/DB/화면 증거를 남겨요. 실패나 BLOCKED를 PASS로 바꾸지 않아요.
- 원문/Run/후속 예약의 원자성, 원래 source에 붙는 결과, expected revision/idempotency, immutable snapshot을 유지해요. 메인에 보조 표현·번역 절차를 섞지 않아요.
- 앱 skill/자료 읽기는 도구 권한을 늘리지 않아요. 기본 자료는 합성이며 실제 키·작품·유료 모델·외부 공개는 이번 범위에 없어요.
