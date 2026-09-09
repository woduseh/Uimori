# 프롬프트 설정·제작 UX 정리 (2026-09-10)

## 결과

설정은 프롬프트 선택·현재 창작 옵션·협업 사용 여부만 제공해요. 이름·본문·제어 정의·기본 옵션·협업 상세는 프롬프트 탭에서 편집하고 전체 저장으로 확정해요. 설정의 이름 입력·구성 편집·수동 옵션 저장·상하단 중복 저장 메뉴를 제거했어요. 프롬프트 목록의 내장 설정 편집기도 설정 이동 버튼으로 바꿨어요.

- 옵션 변경과 조합 불러오기는 자동 저장해요. 조합은 현재 선택값을 한 번 바꾸며 이후 직접 수정한 값이 우선해요. 저장된 조합은 변경하지 않고, 필요한 경우에만 현재 선택을 새 조합으로 저장해요. 조합 관리는 설정의 옵션 조합 메뉴에서 제공해요.
- 프롬프트 전환은 해당 프리셋의 기본 옵션을 복사해요. 적용 당시 기본값을 `CurrentPrompt.defaultValues`로 보관하므로 이후 프리셋 수정은 현재 사용본이나 현재 기본값을 바꾸지 않아요. 최신 버전 적용을 눌러야 새 내용을 복사해요.
- 자동 저장은 직렬화하고 응답 대기 중 들어온 최신 입력을 유지해요. 실패 시 입력을 보존하고 기존 초안 복구·비교 및 다시 저장을 제공해요. 프롬프트 교체 중에는 이전 옵션을 편집하지 못하게 해요. 이미 예약된 Run은 바꾸지 않아요.
- 설정의 협업은 오른쪽 스위치만 제공해요. 제작 화면은 왼쪽 화살표와 오른쪽 스위치를 분리하고 기본 접힘이며, 사용 여부와 저장이 펼침 상태를 바꾸지 않아요. 첫 저장의 편집기 재생성 중에도 펼침 상태를 유지해요.
- JSON은 이름·작문/번역 역할·구성·기본 옵션을 왕복하며 협업은 program 안에 포함해요. 메타데이터가 없는 단독 프로그램도 읽어요. 같은 역할의 JSON 가져오기를 실행 취소하면 구성과 옵션 값을 함께 복원해요.
- 서재·프롬프트의 만들기 버튼을 제목 옆에 배치하고 색상을 통일했어요. 편집·폴더 이동·복제 아이콘을 넣고 삭제 확인의 취소 → 영구 삭제를 오른쪽에 정렬했어요.

구현은 `web/PromptWorkspaceEditor.tsx`, `web/PromptEditor.tsx`, `web/PromptComposer.tsx`, `web/AgentCollaborationEditor.tsx`, `web/PromptLibrary.tsx`, `core/prompt-file.ts`, `server/prompt-workspace.ts`에 있어요. 동작 계약은 [런타임 문서](../docs/RUNTIME-SIMPLIFICATION.md#설정과-제작-화면)에 반영했어요. schema/archive는 v15 그대로이며 운영 데이터 변경·배포는 하지 않았어요.

## 검증

- 최종 `npm run quality:full` PASS: 서식·lint·타입, tooling **27 PASS**, 새 빌드, Vitest **1,716 PASS / 기존 opt-in 1 SKIP** (163개 파일 통과, 1개 파일 미실행).
- 새 DB·포트의 집중 합성 브라우저 **21 PASS / 0 FAIL / 0 SKIP**. 소스·빌드·검사 지문을 실행 종료 시 확인했고 cleanup PASS, 잔여 PID 없음이에요.
- 390/1440px 설정·협업·라이브러리·삭제 흐름을 검사하고 설정의 어두운 테마 개요 및 모바일 화면을 직접 확인했어요. JSON 메타데이터 왕복, 기본 옵션 고정, 첫 저장의 펼침 유지, 같은 프롬프트 편집 재진입, 조합 불변, 지연 저장 응답 중 입력, 실패 재시도·CAS 충돌을 포함해요.
- 첫 `quality:full`의 샌드박스 빌드는 `spawn EPERM`으로 BLOCKED였고, 권한 확장으로 실행한 최종 검사와 구분해요.
- 전체 `verify:redesign`은 **600초 timeout / 최종 reporter 없음**으로 완주하지 못했어요. 부분 실행을 통과 수로 계산하지 않아요. 여기서 확인한 회귀를 수정한 후 집중 검증을 실행했어요. 첫 집중 실행은 20 PASS / 1 FAIL(새 프롬프트 첫 저장의 협업 접힘)이었고, 수정 후 최종 21 PASS예요.
- 물리 기기·실제 모델·운영 배포는 검증 범위가 아니에요. fixture 호출은 실제 공급자 호출의 증거가 아니에요.

직접 증거:

- [최종 브라우저 요약](../output/playwright/prompt-settings-2026-09-09T17-26-07-573Z-ac7d51b4/summary.json)
- [데스크톱 설정 개요](../output/playwright/prompt-settings-2026-09-09T17-26-07-573Z-ac7d51b4/browser/prompt-actions-browser-PAU-8eacc-tions-on-desktop-and-mobile/prompt-settings-overview.png)
- [모바일 현재 옵션](../output/playwright/prompt-settings-2026-09-09T17-26-07-573Z-ac7d51b4/browser/prompt-actions-browser-PAU-8eacc-tions-on-desktop-and-mobile/prompt-actions-mobile.png)
- [최종 빌드](../output/build/build-2026-09-09T17-25-41-615Z-562c3bd8/summary.json)
- [최종 tooling](../output/tooling/2026-09-09T17-25-40-603Z-93d1ba55/summary.json)
- [전체 회귀 timeout](../output/playwright/redesign-2026-09-09T17-09-17-477Z-8ee9b80a/summary.json)

집중 검사는 기존 `runBrowserVerification`을 그대로 사용했고 새 검증 실행기를 추가하지 않았어요. 재현 시 `NR_VISUAL_REVIEW=1`로 아래 선택을 전달해요.

```js
import { runBrowserVerification } from './scripts/browser-verification.mjs';
await runBrowserVerification({
  name: 'prompt-settings',
  scope: 'Prompt settings autosave and authoring synthetic regression',
  providerFixture: true,
  files: [
    'tests/prompt-workspace-browser.spec.ts', 'tests/prompt-actions-browser.spec.ts',
    'tests/prompt-editor-browser.spec.ts', 'tests/prompt-redesign-browser.spec.ts',
    'tests/agent-collaboration-browser.spec.ts', 'tests/deletion-browser.spec.ts',
    'tests/library-browser.spec.ts', 'tests/settings-action-icons-browser.spec.ts',
    'tests/product-browser.spec.ts', 'tests/ui-browser.spec.ts',
    'tests/chat-prompt-options-browser.spec.ts',
  ],
  grep: String.raw`\b(?:PWS01|PWS02|PWS03|PAUI01|PAUI02|PAUI03|NUI01|PRUI01|AGENTUI01|AGENTUI02|AGENTUI03|DEL01|DEL02|LIBUI01|SICON01|P01|P09|UI17)\b|chat creative options preserve drafts`,
  expectedCount: 21,
  requiredScreenshots: ['prompt-settings-overview.png', 'prompt-actions-mobile.png'],
});
```

## 메인 통합 검증

- 최신 로컬 main `2e2318d`를 작업 브랜치에 먼저 병합했어요. 브라우저 탐색 검사는 메인의 ID 기반 선택을 유지하고 프롬프트 설정 링크 CSS와 새 서재 폴더 스타일을 함께 보존했어요.
- 통합 후 `npm run quality:full` PASS: tooling 27개, 단위·통합 1,716개 PASS / 기존 opt-in 1 SKIP, 빌드 PASS.
- 통합 후 관련 합성 브라우저 21개 PASS: [요약](../output/playwright/prompt-settings-merge-2026-09-09T17-42-08-342Z-4d675ace/summary.json).
