# Risu 전용 변환기 정리 · 2026-09-07

## 후속: 원본 변환을 앱 밖으로 분리

통합 ‘자료 가져오기’ 버튼/Dialog, `/api/imports/risu/inspect`, JSON/CHARX 부분 변환기와 전용 시험을 제거했어요. 기존 `LibraryPanel`의 native 패키지 JSON과 `PromptComposer`의 PromptProgram JSON 검증·초안·명시 저장은 유지해요. Risu 원본은 [이식 가이드](../docs/RISU-PORTING.md)를 따르는 외부 에이전트가 RisuToki 구조화 도구로 조사·변환해요. 별도 프로그램이나 새 skill은 추가하지 않았어요.

관련 단위·통합은 **25/25 PASS**예요(`content-package`, `package-runtime`, `redesign-integration`, `custom-prompts`). [결과](../output/risu-porting/native-import-unit.json)

병행 중인 공급자 UI/서비스 계정 기능의 빌드를 방해하지 않도록 `output/risu-native-only-check`에 소스 복사본을 만들고 의존성만 공유했어요. 해당 복사본에서 타입·빌드와 native/package-editor 브라우저 **6/6 PASS**, source/build 일치 및 cleanup PASS를 확인했어요. [최종 화면 검사](../output/risu-native-only-check/output/playwright/native-ui-2026-09-07T10-48-49-541Z-e3b92d1b/summary.json)

새 `PKUI03`은 잘못된 JSON의 초안 보존, 파일 선택 후 미저장, 명시적 초안 교체·저장, 페르소나 역할과 긴 본문 보존, 제거된 API의 404를 확인해요. 기존 프롬프트 JSON 가져오기·native 설정·히든 표시 검사도 포함했어요. 첫 실행은 테스트가 모바일 기본 화면에서 데스크톱 탐색 버튼을 찾아 타임아웃했고, 명시적 화면 크기로 수정한 뒤 통과했어요. 초기 FAIL 기록도 유지해요.

격리 빌드 source는 `0304a4635d1f7214bc3431616b8bbf2c1a0de2de4ba1cf8f4cf3eb31a03b21af`예요. 복사 당시 main source는 `a903895771acea8e7fa04bf66028e74a160d369a778708f9b5c053481a4af10c`이며, 복사본의 검사 선택 확대와 PKUI03 화면 크기 수정 때문에 지문이 달라요. 이후 진행 중인 다른 작업까지 최신 전체 검증한 결과는 아니에요. 공유 `dist`·사용자 DB·실제 Risu 원본·외부 모델은 이 검증에 사용하지 않았고 커밋·push하지 않았어요.

## 앞선 자료 전용 변환기 정리

> 후속 변경: 아래는 특정 자료 전용 변환기를 먼저 제거한 당시 결과예요. 이후 앱의 통합 Risu 변환 화면/API도 제거했어요. 현재 가져오기는 [native JSON 편집 경로](../docs/RISU-IMPORT.md)만 제공하며, 아래 104/3 검사 수치는 첫 정리 시점의 기록이에요.

자료 이름에 종속된 변환 코드 대신 [공통 이식 가이드](../docs/RISU-PORTING.md)를 사용해요. RisuToki 구조화 읽기와 필요한 스킬로 원본 의미를 조사하고, 에이전트가 native JSON·대응/손실 보고·검증 결과를 작성해요.

- Phēmē 전용 변환기·실행 스크립트·전용 시험을 제거했어요. 히든 스토리의 Risu 해석 부분도 제거했어요.
- 히든 native 타입과 실행 조립은 당시 `core/hidden-story-runtime.ts`로 분리했어요. 기존 타입 선언과 `wireHiddenStoryInstructions` 및 seed 선택 구현은 이전 코드와 동일함을 비교했어요. 저장 형식·기존 자료·런타임은 변경하지 않았어요.
- 히든 회귀는 당시 `tests/fixtures/hidden-native.ts` 합성 fixture를 직접 사용해요. 조건부 지침·옵션 문자열 비실행·고정 추첨·불변 버전·source 귀속·표시 검사는 유지하고 원본 파싱 시험은 제거했어요.
- 공통 JSON/CHARX importer와 검증·등록은 유지해요. Agent handoff와 AGENTS 및 제작 문서에서 새 가이드를 연결했어요.

2026-09-08 후속 정리에서는 위 두 파일을 포함한 전용 native/hidden 경로도 제거했어요. 현재 원문 표시·전송 제외는 [공통 원문 구간](../docs/SOURCE-SEGMENTS.md), 자료 이식은 [Risu 이식 가이드](../docs/RISU-PORTING.md)를 사용해요. 당시 결과와 현재 통합 증거는 [코드베이스 정리 결과](CODEBASE-CLEANUP-RESULTS.md)에서 구분해요.

## 검증

- `npm run check`: PASS.
- 관련 단위/통합 11개 파일 **104/104 PASS**. [JSON 결과](../output/risu-porting/unit.json). 대상은 hidden-story, native-hidden-integration, native-integration, native-main-request, native-wire, risu-import, prompt-runtime, prompt-settings, custom-prompts, content-package, package-runtime 시험이에요.
- `npm run build`: PASS. 최종 source/build `384a0239df0f4062ea393894f1754451e6f7edbdaa2c5fcd62319d3e14c2f270`.
- `npm run verify:native`: 새 DB·자동 포트·별도 profile의 **3/3 PASS**, source/build 일치와 cleanup PASS. [최종 결과](../output/playwright/native-ui-2026-09-07T10-13-56-549Z-5f7d1d04/summary.json). 모바일 히든 리더 화면도 확인했어요.
- 가이드의 native 예제는 schema·기본 지침·조건 OFF·본문 보존 4개 검사 PASS, 로컬 문서 링크 검사 PASS.

첫 Vitest 실행은 Windows sandbox의 `spawn EPERM`으로 설정 로딩 전에 중단됐어요. 승인된 실행에서 위 검사를 통과했어요. 빌드는 기존 프런트엔드 chunk 크기 경고를 남겨요. 실제 개인 파일 변환·유료 모델·전체 Risu 호환성 검증은 하지 않았어요.

동시 self-host 작업과 소유 파일 및 빌드 시간을 조율하고 상대 검증 종료 후 소스를 변경했어요. 상대 작업의 전체 검사 수치를 이 변경의 검증 결과로 합산하지 않아요. 공유 작업트리에 두 변경이 있으며 이 작업에서는 커밋·push하지 않았어요.
