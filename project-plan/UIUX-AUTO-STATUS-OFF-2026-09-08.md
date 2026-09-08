# 자동 장면 상태 OFF 추가 승인 검증

2026-09-08 · **PASS**

사용자의 “자동 승인이 검토 거절한 부분까지 테스트해줘” 요청에 따라, 이전 감사에서 거절됐던 **장면 상태 자동 실행 끄기 → 설정 저장**을 실제 UI로 수행했어요. 이전과 같은 격리 빌드·감사용 DB·Gemini 3.8 Flash를 사용했어요. 사용자 작품과 채팅 DB, 제품 코드는 수정하지 않았어요.

| 확인 항목 | 결과 |
|---|---|
| 자동 상태 OFF 저장 | 성공. 설정 revision 1 → 2, `status=true` → `false` |
| 브라우저 새로고침 후 유지 | 체크 해제 상태와 저장된 설정 v2 유지 |
| 실제 본문 생성 | 신규 원문 1건 완료, 새 Run에도 revision 2 / `status=false` 고정 |
| 자동 후속 작업 | 추가 상태·번역·story job 모두 0개 |
| 기존 기록 | 기존 Run의 설정 메타데이터와 job ID·상태 유지 |
| 추가 공급자 호출 | 본문 1회, 입력 1,414 / 출력 2,031 tokens, 실제 비용 `null` |
| 종료 | 활성 작업 0개 확인 후 감사 서버·탭 종료 |

최초 감사의 14회 집계는 그대로 보존했어요. 이번 1회를 포함한 누적 공급자 호출 시도는 **15회**예요. 비용은 추정하지 않았어요.

수동으로 OFF를 저장하는 기능은 정상이에요. 새 채팅에서 상태 모델 없이 자동 상태가 기본 활성화되는 문제(C01)와 과거 실패가 하단 대표 상태로 계속 표시되는 문제(C03)는 별개로 남아 있어요.

## 화면 근거

1. OFF 저장 및 저장 완료 안내

![자동 상태 OFF 저장](../output/uiux-audit-2026-09-08/65b-auto-status-off-saved-visible.jpg)

2. 새로고침 후 OFF 유지

![새로고침 후 OFF 유지](../output/uiux-audit-2026-09-08/66-auto-status-off-after-reload.jpg)

3. 상태 작업 없이 새 본문 완료

![새 원문 완료](../output/uiux-audit-2026-09-08/67-auto-status-off-generated-scene.jpg)

## 검증 범위와 증거

- 실제 브라우저의 390×844 화면에서 조작했어요. 실제 휴대폰 기기 검사는 아니에요.
- 별도 읽기 전용 DB 비교로 저장 설정, 신규 Run, 기존 Run 설정 메타데이터와 job, 호출 증가분을 확인했어요. 최초 기준선에 없는 전체 snapshot·source hash의 전후 동일성은 미측정이에요.
- 이번에는 자동 승인 검토가 해당 UI 조작을 거절하지 않았어요.
- [전후 비교 결과](../output/uiux-audit-2026-09-08/auto-status-off-result.json) · [UI 관찰](../output/uiux-audit-2026-09-08/auto-status-off-ui.json) · [실행 환경](../output/uiux-audit-2026-09-08/auto-status-off-environment.json)
- [최초 감사 보고서](UIUX-AUDIT-2026-09-08.md)
