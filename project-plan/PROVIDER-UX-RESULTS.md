# 연결·모델 관리, Vertex JSON, 공통 팝업 결과

2026-09-07 · 로컬 구현 및 합성 검증 완료. 커밋·푸시는 하지 않았어요.

## 변경

- 모델 프리셋 목록과 연결 관리를 분리하고, 제공자 카드 → 연결 정보 → 모델 선택의 빠른 시작을 추가했어요. 모델 카탈로그 검색·선택과 직접 ID 입력을 함께 지원해요.
- 모델 편집을 기본 정보·생성 설정·고급 옵션으로 나눴어요. 목록/설정 항목 전환 시 초안 유지, 다른 초안으로 교체할 때 확인, 숨겨진 오류 입력으로 이동을 검증했어요. CAS·복제·비활성 영향·기존 이야기 모델 버전 귀속을 유지해요.
- Vertex 서비스 계정 JSON을 업로드하면 프로젝트와 global endpoint·인증 참조가 채워져요. 서버는 별도 파일에 키를 저장하며 library/원문 DB/export/SQLite 백업에는 원문을 넣지 않아요. 앱별·Vertex 프로젝트별 범위를 검사하고 모든 역할의 토큰 resolver에 연결했어요.
- 작업 현황·채팅 설정·읽기 설정·새 채팅 등 공통 Dialog를 데스크톱 중앙 팝업, 모바일 전체 화면으로 통일했어요. 모바일 탐색도 같은 규칙이며 닫기·Esc·배경 클릭·포커스 복원을 유지해요.

## 검증

최종 source/build `69477f9e7570713d5848c985a676ae2c12b74ea3934bc70178306826e3f03851`, dist `d2a6c3e3aae1db85290b0b691ba3f3ec7fc5e1ca5d31c732eddd484f86c43654`.

| 검사 | 실제 결과 | 증거 |
| --- | --- | --- |
| `npm run check`, `npm run build` | PASS | 최종 source/build 위 참조 |
| 전체 단위 테스트 | 948/948, 실패·skip 0 | [JSON](../output/provider-redesign-unit.json) |
| `npm run verify:providers` | 9/9, cleanup PASS | [summary](../output/playwright/provider-management-2026-09-07T10-54-06-722Z-05bccadb/summary.json) |
| 최종 `npm run verify:redesign` | 61/61, 실패·skip 0, cleanup PASS | [summary](../output/playwright/redesign-2026-09-07T10-59-01-192Z-8c0265f7/summary.json) |
| 실제 화면 확인 | 1440/390px 목록·제공자 선택·Vertex 화면 8장, 가로 넘침 없음 | [summary](../output/playwright/provider-design-2026-09-07T10-55-23-171Z-cc79143d/summary.json) |

단위·provider 전용·별도 시각 검사는 직전 source `6ea778f678a69e1fa5c2cc65f05fdff6c9e82e7f937efdf13cad91cd7dcb7283`에서 실행했어요. 이후 바뀐 제품 코드는 **목록 갱신만 한 빈 모델 초안의 baseline 갱신**이며, 최종 61개 브라우저 회귀로 다시 검증했어요. 인증/백엔드/레이아웃은 이 사이에 바꾸지 않았어요.

첫 전체 브라우저 실행은 [60/61 통과, 1 실패](../output/playwright/redesign-2026-09-07T10-55-21-724Z-69208ad5/summary.json)였어요. 원인은 Vertex 카탈로그 새로고침만으로 초안을 변경한 것으로 판단해 불필요한 확인창이 뜬 것이며, baseline 갱신 후 최종 전체 실행이 통과했어요. 이전 FAIL은 그대로 보존했어요. 초기 sandbox 자식 프로세스 `spawn EPERM`은 승인된 실행에서 해결됐으며, 제품 PASS 근거는 실제 후속 결과예요.

PMUI07은 검색·선택·초안 유지, PMUI08은 매 실행 생성한 합성 RSA 키의 실제 업로드·연결 저장·화면/library 비노출, PMUI09는 숨긴 오류 입력과 이전 비활성 확인 무효화를 검증해요. `tests/vertex-credentials.test.ts`는 별도 임시 DB/키 디렉터리에서 재시작·프로젝트/프로토콜/앱 격리·세션/Origin·악성 인증 URL 거절·실패 메시지 비밀 제거를 검증해요. OAuth는 mock이며 업로드/준비 상태 확인에서는 호출하지 않아요.

## 범위와 사용

실제 Google 인증·Vertex 생성·비용·모델 품질, 실제 휴대폰, Linux/Docker 파일 권한은 검증하지 않았어요. Vite의 기존 500 KB 청크 크기 경고는 비차단으로 남아요. UI 새로고침만으로 서버 API가 바뀌지는 않으므로 실행 중인 서버는 재시작한 뒤 사용해요.

업로드 키 파일은 `<NR_DB 파일 경로>.vertex-credentials/`에 남으며 연결 인증 방식을 바꾸거나 창을 닫아도 자동 삭제하지 않아요. 일반 백업에 키는 없으므로 다른 서버 복원 시 다시 등록해야 해요. [공급자 사용 안내](../docs/PROVIDERS.md)와 [원본 참고·채택 근거](SOURCES.md)를 봐요. 유저 DB·개인 키·실제 작품은 검사에 사용하지 않았어요.
