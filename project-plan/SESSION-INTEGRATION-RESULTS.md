# 병행 작업 통합 · 2026-09-07

사용자 요청으로 세 작업의 인계를 확인하고 공유 `main`의 변경을 함께 검증했어요. 파일별 변경이 겹치므로 하나의 통합 커밋으로 보관해요.

## 범위

- `01a07bc3-2df1-70d2-8ace-790effa01a3d`: PromptProgram 단일 저장·실행, 간단/구성 편집과 접기, 번역 미리보기. [결과](PROMPT-EDITOR-RESULTS.md)
- `01a07b4d-3f76-7421-8de5-4105c2522201`: Risu 변환 경로 분리, 일반 인증 환경변수 이름, Sol provider 제거와 모델별 평가 도구. [이식 결과](RISU-PORTING-RESULTS.md), [평가 도구](EVALUATION-TOOLS.md)
- `01a079e9-7150-7f60-822b-c7b9f3ab863b`: Codex 에이전트 연결, 설정·서재 Dialog, 로어 폴더·검색·일괄 이동·240개 자료 검사. [Codex 결과](CODEX-RESULTS.md)
- 세 담당 모두 공유 main에서 작업했고 별도 미반영 커밋은 없다고 확인했어요. 개인 원본·Phēmē 포팅 산출물·DB·인증·검증 산출물은 기존 ignore 규칙에 따라 제외해요.

## 과거 워크트리

`6d747e9`(공급자 관리), `5f104bf`(기억 평가), `e2017e6`(번역 조회), `15de6f0`(로딩)은 담당 세션 확인상 이미 `82a1352`에 수동 통합됐어요. 원래 커밋의 변경 파일을 당시 main과 비교하면 각각 28/41, 4/4, 5/9, 20/30개가 blob까지 같아요. 나머지는 공통 파일 통합과 native·숨김 구간·비동기 선택 보강 등이 포함돼요. 과거 통합 근거는 [native 결과](NATIVE-RESULTS.md)와 ignored `output/native-porting/FINAL-VERIFICATION.json`이에요.

등록된 별도 워크트리 다섯 개 모두 미커밋 변경이 없어요. 위 네 작업은 이미 반영돼 있어 다시 merge/cherry-pick하지 않아요. 브랜치·워크트리는 보존해요.

## 통합 검증

- 타입 검사·빌드 PASS.
- 전체 Vitest: 992 PASS, 0 FAIL, 1 skip. `output/integration-2026-09-07-vitest.json`. skip은 `NR_CODEX_PREFLIGHT=1`을 명시해야 실행하는 설치 CLI 사전 검사예요.
- 단위 검사 시 source/build: `e2370e0bd1b2791f54620b2f5a211a3511b57615ddfedbbdf868c2f7e550a42f`.
- 첫 전체 브라우저: 63 PASS, 2 FAIL. `output/playwright/redesign-2026-09-07T13-07-30-665Z-d1fa1a8f/summary.json`을 보존해요. LOADUI03은 다른 검사가 남긴 자료까지 합산했고, P04는 변경 전 인증 환경변수 기본값을 기대했어요.
- LOADUI03의 개수 검사를 자체 생성 자료 100개로 한정하고 전체 자료의 본문 생략 검사는 유지했어요. P04의 네 기본값을 승인된 현재 계약에 맞췄어요. 제품 코드는 변경하지 않았어요.
- 수정 후 타입·빌드 PASS. 최종 source/build: `e999019423ca30dbbb42cea8fb7445f6786b5086617ace1d779fac798403dc22`. 제품 dist는 단위 검사 당시와 동일한 `8f6df894ea4680a3a74f89905f8f5ed27181e8d0031ffbe73b89b07e02be9c88`이에요.
- 최종 전체 브라우저 **65/65 PASS**, 실패·skip 0, source/build 일치·artifact scan·cleanup PASS. [로컬 summary](../output/playwright/redesign-2026-09-07T13-09-59-099Z-c5019e66/summary.json).
- staging 검사에서 신규 파일 네 개의 끝 빈 줄을 제거했어요(`verify-prompts.mjs`, `codex-integration.test.ts`, `prompt-defaults.test.ts`, `LoreEditor.tsx`). 이 공백 정리 뒤 빌드 PASS, 커밋 소스 지문은 `af93bd05a891a12f3a9a6badcda8017b17c6eed230c7893d8c48e5d18b15ead1`이며 dist 지문은 위와 같아요. 의미 변경이 없어 테스트를 반복하지 않았어요.

실제 유료 공급자·구독 모델 실행·Linux/Docker·물리 휴대폰 검증은 수행하지 않았어요. 최초 샌드박스 빌드의 `spawn EPERM`은 권한을 조정한 재실행으로 해결했어요. 원격 push는 이번 요청에 포함하지 않았어요.
