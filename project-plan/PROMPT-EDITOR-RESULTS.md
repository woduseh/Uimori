# 프롬프트 편집·실행 통합

2026-09-07. 동시에 수정 중인 평가 도구·자료 편집 세션과 소유 파일 및 빌드 시점을 조율했어요. 사용자 DB와 과거 Run은 수정하지 않았어요.

## 구현

- 저장된 `PromptPreset`의 유일한 본문은 `program`이에요. 기본 작문·번역과 API 평문 작성 입력도 `createDefaultPromptProgram`으로 같은 AST를 만들어요.
- 간단 편집은 선택한 평문 메시지만, 구성 편집은 같은 AST의 역할·순서·조건·슬롯을 수정해요. 보기 전환은 변경으로 표시하지 않고 조건·참조 템플릿을 평문으로 덮어쓰지 않아요. TXT/MD 가져오기는 선택한 메시지만 수정해요.
- `프롬프트 구성` 전체를 접고 펼쳐요. 초안과 옵션을 유지하며 저장 버튼은 밖에 남겨요. 미적용 문법의 저장 제한도 유지해요.
- main 자료의 source/revision/hash와 과거 프롬프트 개정을 보존해요. Vertex는 연속된 같은 역할을 parts로 묶되 논리 메시지 순서와 진단을 유지해요.
- 번역 미리보기는 실제 source의 생성 당시 snapshot 또는 원문이 없을 때의 명시적 합성 source로 실제 번역의 context → plan → input → compiler 경로를 사용해요. `previewSource`는 원문 종류·귀속·첫 chunk를 표시해요. DB 쓰기와 공급자 호출은 없어요.

## 단위 검증

- `npm run check`: PASS.
- 런타임 관련 12개 파일 91개 검사 PASS 후, 번역 미리보기 보강에 대해 4개 파일 36개 검사 PASS. 이 수치는 중복 범위가 있어 합산하지 않아요.
- 전체 검사에서 드러난 옛 wire fixture를 수정했어요. 기존 `Request data` 위치 가정 대신 명시적인 source-bound Host context를 읽고, 지침은 compilation에서 검증해요. archive compilation 무결성과 초기 state 출처 검사를 모두 유지해요.
- `npx vitest run tests/story-state-dependencies.test.ts tests/translation-continuity.test.ts tests/vertex-app.test.ts`: 14 PASS.
- `npx vitest run tests/translation-auto-retry.test.ts`: 19 PASS. 최초 격리 실행의 socket 실패는 fixture의 옛 JSON 위치 가정이 원인이었어요.

## 빌드·브라우저 검증

- `npm run build`: PASS. build ID `cffc06b5c78d56bd3572387a54c5d24bfc26beb9378e2644efd8316862555258`.
- `node scripts/verify-prompts.mjs`: **6/6 PASS**, skipped 0. PUNI01/02, PRUI01, NUI01, UI17 두 케이스를 실행했어요.
- 45블록·45제어 합성 자료에서 보기 전환 무변경, 선택 본문 편집·파일 가져오기, 조건부 템플릿 보존, 접기 후 초안 유지, 키보드 펼치기, 저장 CAS 충돌·과거 개정 불변을 확인했어요.
- 1440px/390px 접힌 화면과 390px 본문 편집 화면을 직접 확인했어요. 가로 넘침 없이 저장 버튼과 구성 요약을 사용할 수 있어요.
- 시작/종료 source·dist identity, 알려진 합성 canary 검사, 소유 프로세스 종료·임시 runtime 정리 모두 PASS예요. 증거 DB·reporter·화면은 유지해요.
- 증거: [summary.json](../output/playwright/prompt-editor-2026-09-07T12-46-44-408Z-cd6fce95/summary.json).

## 범위

합성 자료·loopback·새 DB 검증이에요. 실제 공급자 의미 품질·과금·배포·실물 휴대폰·IME 동작을 입증하지 않아요. 구형 저장 자료의 이관·호환 계층은 추가하지 않았어요.
