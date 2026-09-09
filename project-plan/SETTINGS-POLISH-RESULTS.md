# 설정 문구·삽화 폼·초안 알림 정리 (2026-09-10)

에이전트는 짧은 연결 상태와 다음 행동을 우선 표시하고 실행·인증 설명은 접힌 도움말로 옮겼어요. 상태 새로고침은 제목 오른쪽 아이콘이며 조회 중 비활성·진행 표시를 제공해요. 연결 후 `연결과 모델`로 이동해도 기존 편집 초안을 유지해요.

삽화의 자동 생성 문구와 ComfyUI 설명을 줄이고, 긴 편집 필드에 걸린 설정 공통 최대 폭 제한을 해제했어요. 시간 제한과 확인 간격은 초로 입력하고 저장 시 기존 밀리초 계약으로 변환해요. 새로고침 아이콘은 초안이 있을 때 폐기를 확인하며 조회 실패 시 초안을 유지하고 오류를 표시해요.

자료·프롬프트·설정·연결 편집의 폐기 확인에 `DraftDiscardActions`를 공유해요. 데스크톱은 오른쪽에 폐기/계속 편집 순서, 모바일은 계속 편집/폐기 순서로 배치해요. 테마 강조색과 오류색을 재사용하며 초기 초점은 계속 편집에 있어요.

## 검증

- 최종 `npm run quality:full`: 서식·lint·타입, tooling 27, 빌드 PASS. Vitest 1,710 PASS / opt-in 1 SKIP.
- `$env:NR_VISUAL_REVIEW='1'; node scripts/verify-settings-polish.mjs`: 15 PASS, cleanup PASS. 새 DB/포트의 합성 검증이에요.
- 직접 증거: `output/playwright/settings-polish-2026-09-09T17-17-31-329Z-25069eec/summary.json`. 390/1440px 삽화 폼·ComfyUI 편집기·초안 확인 PNG와 모바일 Codex PNG를 검토했어요. 초 단위 저장, CAS 초안, 조회 실패, Esc·계속 편집, 연결 화면 복귀를 확인했어요.
- 최초 샌드박스 빌드는 spawn EPERM으로 BLOCKED였고 권한 확장 후 최종 검사를 통과했어요.
- 전체 `verify:redesign`은 600초 timeout으로 최종 reporter가 없어 FAIL이에요. 증거는 `output/playwright/redesign-2026-09-09T17-05-19-745Z-b1002f83/summary.json`에 보존했어요. 관측한 구형 채팅 탐색 선택자는 현재 봇/채팅 ID로 수정했고, 해당 창작 옵션·제품 테스트와 시간 초과했던 PMUI11을 위 15개 묶음에서 재검증했어요. 전체 브라우저 회귀 통과를 주장하지 않아요.

서버 저장 계약·DB/schema 변경, 실제 Codex/ComfyUI 호출, 물리 기기 검증, 커밋·배포는 하지 않았어요.
