# 프로바이더·모델 설정 UI 정리

2026-09-10. 합의한 7개 UI 정리 항목을 별도 작업트리에서 구현해요.

## 격리와 병합

- 시작 commit: `caadd45` (`main`).
- 작업 브랜치: `codex/provider-ui-cleanup`.
- 작업트리: `C:/Users/wodus/ai-workspace/uimori-provider-ui`.
- 메인 작업트리·운영 데이터·배포는 변경하지 않아요. 다른 UI 작업 완료 후 함께 병합할 대상으로 유지해요.
- 병합 시 겹칠 수 있는 중심 파일: `web/ProviderManagement.tsx`, `web/ProviderManagement.css`, `web/ProviderModelFields.tsx`, `web/WorkspacePanels.tsx`, `tests/ui-navigation.ts`. 나머지 변경은 모델 선택 안내의 명칭과 연결된 기존 브라우저 검사예요.

## 최종 동작

- 설정 메뉴는 **프로바이더와 모델**, 내부 탭은 **모델 / 프로바이더**예요. 프로바이더 등록·편집·삭제·관련 안내도 같은 용어를 사용해요. 서버 통신 동작이나 자료 연결을 뜻하는 일반적인 연결 표현은 유지해요.
- 모델 목록에는 프리셋 이름·프로바이더·메뉴·직접 누르는 응답 테스트를 보여줘요. 진단과 상세 접기, 실제 호출명·토큰/시간 제한·옵션 출처·요금 요약은 제거해요.
- 응답 테스트 성공은 한 줄로 표시하고 원문·토큰·시간·비용은 노출하지 않아요. 실패·중단·부분 응답·실행 결과 미확인은 구별하며 긴 오류는 오류 상세에서 확인해요. 서버 진단 기록과 불확실 요청의 동일 키 재조회는 유지해요.
- 모델 기본 탭은 모델 선택 / 생성 설정으로, 고급은 문맥과 시간 제한 / 생성 옵션 / 캐시 / 도구 / 요금으로 나누고 소제목·수평선·여백으로 구분해요.
- 서비스 등급은 기본 탭의 사고 강도 아래에 있어요. 저장값·지원 조건·서버 제한 검증을 유지해요.
- 생성 중단 문자열은 고급의 접기 항목이며 값이 없으면 닫혀요. 저장값·초안이 있으면 열리고 유효성 오류가 있는 항목은 저장 시 펼쳐서 초점을 이동해요. 작은 추가 버튼과 항목별 제거 버튼을 사용해요.
- 옵션 출처·전송 필드·내부 도구 이름·반복 설명은 제거하고 기본값·설정 영향·오류만 짧게 남겨요. 모델 ID는 편집 입력란에 유지해요.
- 모델과 프로바이더 삭제 메뉴는 공통 삭제 버튼의 붉은 휴지통 하나만 사용해요.

## 검증

- `npm run quality:full`: PASS. 하네스 27건, Vitest **1,710 PASS / 기존 1 SKIP**. 로그: `output/provider-ui-quality-full.log`.
- 전체 검사에서 발견한 기존 리더 검사의 시간 순서 경합은 `tests/reader.test.ts`의 합성 데이터에 서로 다른 생성 시각을 지정해 해결했어요. 정렬 기대값을 약화하거나 제품 서버 코드를 변경하지 않았어요.
- 삭제 메뉴의 마지막 감싸기 제거 후 `npm run quality`, `npm run build`를 다시 통과했어요. 빌드 로그: `output/provider-ui-final-build.log`.
- `NR_VISUAL_REVIEW=1 npm run verify:providers`: **15 PASS**, cleanup PASS. `output/playwright/provider-management-2026-09-09T17-05-27-802Z-41e9ea17/summary.json`.
- 관련 화면 묶음: **16 PASS**, cleanup PASS. `output/playwright/provider-ui-companion-2026-09-09T17-13-29-032Z-6ae521e7/summary.json`.
- 두 최종 브라우저 검사는 같은 최종 앱 빌드 `c2a4a98d8fecbf2e76dd45784f336f2dfec054444b3259cdbe5911016b704103`를 검증했어요. 목록·설정은 360/390/430/768/1024/1440px 표본, 중단 문자열 버튼은 390/1440px에서 확인했어요. 빈 항목 접힘, 필수값 오류 시 자동 펼침·초점, 초안 유지, 작은 추가 버튼과 단일 삭제 아이콘을 검사했어요.
- 저장된 화면을 직접 확인했어요. 대표 증거는 companion의 `browser/provider-compact-browser-P-39f12-e-menus-and-search-recovery/` 아래 `provider-compact-mobile.png`, `provider-compact-desktop.png`, `provider-stop-controls-390.png`, `provider-stop-controls-1440.png`예요.
- 초기 `verify:redesign` 전체 실행은 **FAIL**이에요. 변경한 문구의 테스트 선택자 불일치와 별도 채팅 탐색·턴 활동 검사의 실패가 있었고, 600초 제한에 도달해 최종 reporter가 생성되지 않았어요. `output/playwright/redesign-2026-09-09T16-51-07-096Z-72c696a6/summary.json`과 실패 화면을 보존했으며 cleanup은 PASS예요. 설정 관련 실패는 보정 후 위 31건에서 통과했지만 **전체 앱 브라우저 회귀 통과를 주장하지 않아요**. 다른 UI 작업을 통합할 때 전체 회귀를 다시 확인해야 해요.
- 합성 검사는 실제 공급자·실기기·운영 배포의 증거가 아니에요. 모델 호출 기록·설정 저장 계약은 유지했고 실제 외부 요청은 실행하지 않았어요.

### 관련 화면 검사의 재실행

PowerShell에서 작업트리의 현재 빌드로 실행해요. 새 포트·DB·브라우저 프로필과 종료 정리는 기존 공통 실행기가 관리해요.

```powershell
$env:NR_VISUAL_REVIEW='1'
node --input-type=module -e "import { runBrowserVerification } from './scripts/browser-verification.mjs'; await runBrowserVerification({ name: 'provider-ui-companion', scope: 'Provider UI cleanup related settings', providerFixture: true, files: ['tests/provider-compact-browser.spec.ts','tests/evaluation-browser.spec.ts','tests/model-pricing-browser.spec.ts','tests/settings-compact-browser.spec.ts','tests/settings-action-icons-browser.spec.ts','tests/ui-browser.spec.ts','tests/product-browser.spec.ts','tests/deletion-browser.spec.ts'], grep: 'PCUI|EVALUI|PRICEUI|SCUI|SICON|DEL05|P04 |UI settings categories', expectedCount: 16, requiredScreenshots: ['provider-compact-mobile.png','provider-compact-desktop.png','provider-stop-controls-390.png','provider-stop-controls-1440.png'], timeout: 300000 });"
Remove-Item Env:NR_VISUAL_REVIEW
```

