# 원문·번역 이미지 배치 — 2026-09-09

원문·번역문을 각각 읽고 이미지와 문단 위치를 고르는 독립 배치를 구현했어요. 버튼은 **이미지 자동 배치 / 이미지 다시 배치**이며, 채팅의 **봇·페르소나·모듈** 설정에서 원문 자동 배치(기본 OFF)·번역 자동 배치(기본 ON)를 따로 저장해요. 대표 이미지와 프로필 전용 이미지는 후보에서 제외해요.

번역 자동 배치는 번역 요청 때 고정한 후보·모델·설정으로 번역 성공 후 예약해요. 후보가 없으면 호출을 예약하지 않아요. 이미지 모델이 사용 불가여도 번역 성공은 보존하고 이미지 실패를 별도로 표시해요. 직접 번역 저장은 모델을 호출하지 않아요. 두 보기의 결과는 서로 덮어쓰지 않으며, 원문 hash와 번역 job ID·개정·텍스트 hash로 귀속을 검사해요. 새 번역 진행·실패 중에는 이전 성공 번역의 배치를 유지하고, 새 번역 완료·직접 수정 시 이전 배치를 무효화해요. 원문 수정은 양쪽 배치를 무효화해요. 포크는 번역 job ID와 양쪽 문단 anchor를 다시 연결하고 보관 복원은 변조를 거부해요.

구현은 `server/package-images.ts`, `server/source-editing.ts`, `server/product-auxiliary.ts`, `server/store.ts`, `server/chat-fork.ts`, `server/product-store.ts`, `web/SourceReader.tsx`, `web/ProfileEditor.tsx`, `web/TurnActivity.tsx`에 있어요. 계약은 [PACKAGES](../docs/PACKAGES.md)를 봐요. 기존 사용자 DB의 초기화·이관·외부 배포는 수행하지 않았어요.

## 검증

- `npm run quality:full` PASS: 서식·lint·타입, 도구 검사, 새 빌드, 134개 테스트 파일 / **1,383 PASS · 1 opt-in skip**.
- 마지막 브라우저 테스트 수정 후 `npm run quality` PASS. 제품 소스 변경이 없어 같은 빌드를 사용했어요.
- 합성 브라우저 **20/20 PASS**, 실행 전후 지문과 cleanup PASS. `shared-package`, `product`, `chat-settings`, `global-models`, `response-actions`, `turn-activity` 6개 검사 파일을 공통 `runBrowserVerification`으로 실행했어요. 재현 시 `registrationFixture: true`, `NR_VISUAL_REVIEW=1`을 사용해요.
- [브라우저 summary](../output/playwright/image-placement-2026-09-08T17-40-13-256Z-9fbd3db1/summary.json) · [번역문 문단 사이 배치 화면](../output/playwright/image-placement-2026-09-08T17-40-13-256Z-9fbd3db1/browser/shared-package-browser-sha-ecb8d-and-no-automatic-model-jobs/translation-image-placement.png).
- 새 `tests/image-targets.test.ts`는 기본값·설정, 대상별 텍스트, CAS·늦은 worker, 재번역·직접 수정, 모델 불가, 포크·보관 변조, 대표 이미지 제외를 확인해요. 기존 합성 결과와 UI 선택자도 새 계약에 맞췄어요. 초기 실패 증거는 이전 실행 폴더에 보존돼요.

실제 유료 공급자 호출·번역 품질·이미지 선택의 창작 적합성·휴대폰 실기기 검사는 하지 않았어요. 이미지와 번역은 합성 자료이며, 화면의 빈 사각형은 1px 합성 이미지예요. 표시 변환으로 문단 위치를 보장할 수 없는 뷰에서는 기존 안전 동작대로 이미지를 생략하고 안내해요.
