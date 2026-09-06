# 현재 작업 상태

- 기준: v0.6.1 계획과 2026-09-06 사용자 M0 요청. 계획 문서는 ui-ai/project-plan에서 확인했고 claude-code 소스는 변경하지 않았어요. 과거 대화/첨부 원문을 사용하지 않았어요.
- 구현: TypeScript/React/Vite/Fastify, Node 내장 파일 SQLite WAL schema v1, HTTP/SSE, 서버 Run, scoped scripted mock, 독립 모의 번역/표시 상태 job.
- 확인 환경: Windows 11 10.0.26200, PowerShell, Node 24.14.0, npm 11.14.1, SQLite 3.51.2, Chrome 152.0.7977.82. SQLite CLI/WSL/Docker를 사용하지 않았어요.
- 코드/build: bb367129c575cd92c505b72d277ac29660460a301a63e3d5ac3ba247a2eb0640. dist SHA-256은 통합 summary에 기록돼요.
- 최신 통합: npm run verify -- --milestone M0 PASS. Vitest 13 / Playwright 3 / 실패 감지 selftest 11, 제품 skip 0, cleanup PASS.
- 증거: output/playwright/2026-09-06T11-40-31-609Z-0c7f1c0e/summary.json, 같은 디렉터리의 reporter JSON, evidence/commit-boundary-restart.json과 SQLite 백업, 브라우저 화면.
- 원문 커밋 직후 exit86에서 원문1/완료Run1/queued job2/result0를 확인했고 재시작 뒤 source/hash와 메인 호출1을 유지하며 job2만 완료했어요. 별도 중간 Run은 interrupted이고 자동 재생성하지 않았어요.
- 독립 검토 반영: DB 중복 소유, 오래된 UI 응답, 실패 호출 수, loopback Host, assertion false oracle, timeout/cleanup/junction 보존.
- 최초 sandbox의 npm 연결 거절 및 spawn EPERM은 승인된 로컬 실행에서 해결했어요. 원래 실패 증거는 남겼어요.
- 다음 남은 M0 작업: 로컬 commit으로 두 깨끗한 작업트리를 준비해 독립 port/DB/profile/temp를 동시에 검증하고 F01 증거와 최종 인수인계를 갱신해요.
- 범위 밖/미실행: 유료 provider/protocol/live 품질, 실제 폰, 공개 배포/로그인, 장기기억 전체, 실이미지 선택, 원본 봇 실행 호환. 모의 번역은 한국어 고정 합성 문장이며 번역·상태 의미 정확성 증거가 아니에요.
