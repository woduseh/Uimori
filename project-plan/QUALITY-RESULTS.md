# 코드 품질 도구 도입 결과

> 후속 합본 검증: 공통 실행 구조 개편 완료 후 `quality`·빌드, 단위·통합 1,226 PASS·1 opt-in skip, UI 회귀 96/96 PASS를 확인했어요. 최신 범위·빌드 지문은 [코드베이스 정리 결과](CODEBASE-CLEANUP-RESULTS.md)에 있어요. 아래 FAIL/미완료는 도구 도입 당시의 기록으로 보존해요.

2026-09-08. **도구 설정·독립 경계 검사 완료. 공유 작업 폴더의 전체 통합 검증은 미완료**예요. 사용자가 같은 폴더에서 별도 native/hidden 구조 개편이 진행 중임을 확인했어요. 그 개편의 타입·테스트·서식 오류를 이번 도입의 PASS로 숨기지 않아요.

## 적용 내용

- Biome 2.5.12를 정확한 버전의 개발 의존성으로 추가했어요. 서식·일반 lint·디렉토리별 import 규칙을 하나의 도구로 실행해요. 기존 TypeScript 7.0.2 / `strict`를 유지해요.
- `quality`는 `biome check` 한 번과 `tsc --noEmit`을 실행해요. `quality:full`은 여기에 전체 Vitest와 빌드를 추가해요. 기존 `verify:*` 브라우저 검사는 UI 변경 시 별도로 실행해요.
- `.editorconfig`, 선택적인 VS Code Biome 확장·저장 시 서식 설정, Windows GitHub Actions를 추가했어요. PR/main push에서 로컬과 같은 `quality:full`을 실행하고, 브라우저 회귀는 수동 옵션이에요. Git hook과 새 온라인 검사 서비스는 설치하지 않았어요.
- 공용 `ChatFolder`를 `core/product.ts`로 옮겨 브라우저의 서버 타입 참조를 제거했어요. import 규칙은 타입 참조까지 포함해 계층 위반과 브라우저의 Node/서버 SDK 사용을 막아요.
- 최초 서식 적용 시 소스 복사본을 포맷하고, 그동안 원본 내용이 바뀌지 않은 파일만 반영했어요. 해당 실행에서 399개 입력 중 385개 파일을 포맷했으며, 동시 변경으로 건너뛴 파일은 없었어요. 이후 병행 작업에서 다시 변경된 파일은 별도예요.
- 미사용 선언·반환하지 않아도 되는 forEach 콜백·명시 타입을 정리하고, Hooks 의존성을 검토했어요. 의도된 새로고침/초기화 조건과 검증기의 cleanup 오류 보존에는 구문 단위 이유 있는 예외를 남겼어요. 서식 이후 위치가 달라진 예외 주석도 정정했어요.
- 빌드 source fingerprint와 Docker build 입력에 `biome.json`을 포함했어요. 실제 Docker 실행은 이번 검증에 포함하지 않아요.

## 검증

| 항목 | 결과 | 범위 |
| --- | --- | --- |
| 실제 import 경계 검사 | PASS | 측정 시 제품 파일 199개, 진단 0건. |
| 경계 설정 회귀 | **9/9 PASS** | 실제 Biome 규칙·파일 필터를 임시 합성 프로젝트에 적용. type-only·재수출·동적 import·중첩 폴더·Node 내장 모듈·SDK·허용 방향을 검사. |
| 기존 Prose 회귀 | **9/9 PASS** | 원문 렌더링/링크/정규식 관련 기존 테스트. |
| CI YAML·명령 연결 | PASS | YAML 파싱과 로컬 명령·수동 브라우저 조건 확인. GitHub 실행을 뜻하지 않아요. |
| 시작 시 미커밋 변경 보존 | PASS | `provider-registration-agent.ts`와 해당 테스트를 시작 시 원본과 비교. 같은 formatter로 정규화했을 때 내용이 동일해요. |
| 현재 `quality:full` | **FAIL** | 진행 중인 변경의 lint/서식에서 실패하고 후속 테스트·빌드를 실행하지 않았어요. |
| 독립 타입 검사 | **FAIL** | 진행 중인 source-segments/store 변경 및 제거 중인 native/hidden API를 참조하는 테스트 등의 오류를 확인했어요. |
| 전체 단위·통합/브라우저·배포 | **NOT_RUN** | 병행 변경의 통합 완료 후 수행해야 해요. |

경계 테스트 첫 실행은 **8/9 PASS·1 FAIL**이었어요. `node:*` 패턴이 `/`가 있는 `node:fs/promises`, `node:test/reporters`를 놓치는 반례를 잡았고, `node:*/**`를 추가한 후 9/9가 통과했어요. 검사 0건·parser/config 오류·잘린 진단·허용 import의 오탐은 테스트가 실패하도록 했어요.

Windows 제한 환경에서 자식 프로세스 `spawn EPERM`이 발생한 포맷/테스트는 제한 밖의 승인된 로컬 실행으로 다시 확인했어요. 환경 시작 실패를 제품 검사 결과로 계산하지 않았어요.

## 실행 시간

이 Windows / Node 24.14.0 환경에서 한 번씩 측정한 관측값이에요. 초기 설치·전체 회귀 시간이나 다른 기기의 성능 보장이 아니에요.

| 항목 | 관측값 |
| --- | --- |
| import 경계 분석 | Biome 내부 **61ms**, npm 시작 포함 **637ms** |
| 전체 lint | Node/Biome 시작 포함 **395ms** (당시 진단 존재) |
| 전체 format 검사 | Node/Biome 시작 포함 **351ms** (병행 변경의 서식 차이 존재) |
| 경계 회귀 9개 | 테스트 구간 약 **670ms** |

`quality`는 서식·lint·import를 하나의 Biome 실행으로 합치므로 위 개별 검사 시간을 모두 더해 실행하지 않아요. 전체 `quality`가 PASS하는 정상 경로의 시간은 통합 완료 후 측정해야 해요. 무거운 테스트·빌드·브라우저는 수정 중 기본 명령에서 분리했어요.

## 증거와 통합 후 실행

로컬 증거는 ignored `output/quality-adoption/`에 있어요: `format-summary.json`, `architecture-timing.json`, `architecture-tests.json`, `prose.json`, `workflow.json`, `final-checks.json`, `final-*.log`, `quality-full.log`, `quality-full-status.json`. 이 수치는 해당 시점의 결과이며 계속 바뀌는 공유 폴더 전체의 최신 PASS가 아니에요.

병행 개편 통합 후 `npm run format`으로 서식을 맞추고 `npm run quality:full`을 실행해요. UI 변화에 맞는 `verify:*` 또는 전체 `npm run verify:redesign`도 수행해야 해요. 사용법·예외 정책·도구 선택 이유는 [품질 안내](../docs/QUALITY.md)에 있어요.
