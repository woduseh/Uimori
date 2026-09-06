# 작업 지도

- 목적과 milestone 계약: `project-plan/README.md`. 실제 코드/증거: `project-plan/CURRENT.md`, `project-plan/M1-RESULTS.md`.
- 코드: `web/` React, `server/` Fastify+파일 SQLite, `core/` 역할 입력/창작제어/fixture transport/보조 검증. DB schema v1 기본은 `server/store.ts`, schema v2 migration/콘텐츠/분기/백업은 `server/product-store.ts`에 있어요. 유저 DB는 테스트에 사용하지 않아요.
- 확인한 명령: `npm ci --offline --no-audit --no-fund`, `npm run dev`, `npm run check`, `npm run build`, `node scripts/doctor.mjs`, `npm run verify -- --milestone M0`, `node scripts/selftest.mjs`, `npm run cleanup -- --run <run-id>`. Windows Node 24.x/PowerShell에서 실행해요.
- 두 clean 작업트리의 동시 port/DB/profile/temp 격리는 `node scripts/verify-worktrees.mjs --a <A> --b <B>`로 확인했어요. 각 작업트리는 별도 의존성 설치와 빌드가 필요해요.
- 검증은 새 포트/DB를 사용하고 `output/playwright/<run-id>/summary.json`과 reporter/DB/화면 증거를 남겨요. 실패나 BLOCKED를 PASS로 바꾸지 않아요.
- 원문/Run/후속 예약의 원자성, 원래 source에 붙는 결과, expected revision/idempotency, immutable snapshot을 유지해요. 메인에 보조 표현·번역 절차를 섞지 않아요.
- `npm run verify -- --milestone M1-local`은 P01–P13 로컬 검사예요. `M1`은 미충족 외부 전제가 남으면 BLOCKED로 끝나요. 실패한 번역 구간만 재시도하고 완료 chunk/원문은 유지해요. 전송 전에 attempt를 기록하고 불확실한 provider 실행을 자동 재생하지 않아요.
- `fixture-sse-v1`은 자체 loopback 검사용 프로토콜이에요. 실제 provider 호환성을 주장하지 않아요. 연결 권한은 매 호출 최신 enabled/endpoint/credential ref 및 서버 origin 정책으로 재검사해요. opaque continuation은 후속 요청 안에서 유지하며 Inspector/보관 진단에는 내용을 노출하지 않아요.
- 앱 skill/자료 읽기는 도구 권한을 늘리지 않아요. 기본 자료는 합성이며 실제 키·작품·유료 모델·외부 공개는 이번 범위에 없어요.
