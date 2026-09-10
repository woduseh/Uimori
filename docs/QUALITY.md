# 코드 품질 검사

Node **24.14 이상 24.x**와 `npm ci`를 사용해요. 프로젝트의 `strict` TypeScript 검사를 유지하며, Biome **2.5.12** 하나가 서식·lint·import 경계를 검사해요. 도구 버전은 package-lock.json과 함께 고정해요.

## 실행 시점

| 시점 | 명령 | 범위 |
| --- | --- | --- |
| 수정 중·리뷰 전 | `npm run quality` | 서식 + lint + 타입 + 모듈 의존성. 파일을 수정하지 않아요. |
| 검증 스크립트 변경 | `npm run test:tooling` | Node 기본 실행기의 하네스 회귀. 0개·skip·todo·취소·실패를 거부하고 보고서를 남겨요. |
| 작업 완료(매 변경) | `npm run quality:full` + `npm run verify:smoke` + 변경 영역의 `verify:*` 하나 | 품질 검사 → 하네스 회귀 → 새 빌드 → 전체 Vitest, 최소 앱 검증, 해당 영역의 합성 브라우저. 영역 대응은 [TESTING-AUDIT.md](TESTING-AUDIT.md)를 따라요. |
| UI 동작 변경 | 빌드 후 관련 `verify:*` | 새 DB/port를 사용하는 기존 합성 브라우저 검증. 전체 회귀로 대신하지 않아요. |
| 기본 UI 연결 확인 | `npm run verify:browser-smoke` | 채팅 진입·생성 및 전역 프롬프트 설정의 작은 브라우저 묶음. 전체 기능 검사를 대신하지 않아요. |
| 릴리스 전 1회 | `npm run verify:redesign` | 전체 기능 흐름. 대표 모바일/데스크톱 폭을 사용해요. 매 변경의 완료 조건이 아니며 실패는 "다음 릴리스 전에 볼 것"으로 분류해요. |
| 배치·반응형 시각 검토 | `npm run verify:visual` | 전체 기능 + 추가 화면 폭·정밀 배치·성공 PNG. 사람이 화면도 확인해야 해요. |
| 반복 성능 측정 | `npm run benchmark:story` | 긴 본문 동작 검사에 warmup/반복 표본과 측정 산출물을 추가해요. |
| 서식 수정 | `npm run format` | Biome가 지원하는 프로젝트 소스·설정의 서식만 수정해요. |
| lint 수정 | `npm run lint:fix` | 도구가 안전하다고 분류한 수정만 적용해요. 해결되지 않은 진단은 실패로 남아요. |
| 개별 검사 | `npm run lint`, `npm run format:check`, `npm run check`, `npm run lint:architecture` | 실패한 단계만 조사할 때 사용해요. |

`quality`는 Biome의 서식·lint를 한 번에 실행해 중복 스캔을 줄여요. 기본 검사에는 서버 실행, 브라우저, 모델 호출, 네트워크 조회, 의존성 설치가 없어요. 매 저장·커밋마다 전체 테스트를 강제하는 Git hook은 설치하지 않아요. 작업에 필요한 검사가 통과하면 변경이나 새 실패 근거 없이 반복하지 않아요.

`quality:full`은 새 빌드를 만든 뒤 Vitest를 실행해요. 서버 프로세스 재시작 테스트가 `dist/server/index.js`를 실행하므로 이 순서가 필요해요. 개별 `npm test`를 실행할 때도 서버 코드를 변경했거나 `dist`가 없으면 먼저 `npm run build`를 실행해요.

수정 중에는 `npm test -- tests/관련.test.ts`와 해당 영역의 `verify:*`를 선택해요. 매 변경의 완료 조건은 `quality:full`, `verify:smoke`, 변경 영역의 `verify:*` 하나까지예요. 전체 브라우저 회귀 `verify:redesign`은 릴리스 전 1회로 내리고, 여러 영역을 함께 바꿨어도 매 변경마다 돌리지 않아요(2026-09-10 결정 3, [DECISIONS-2026-09-10.md](DECISIONS-2026-09-10.md)). 검사별 유지·통합·선택 실행 이유는 [TESTING-AUDIT.md](TESTING-AUDIT.md)에 있어요.

빌드 지문은 앱 소스와 실제 빌드 설정·실행기·의존성 파일을 포함해요. 테스트/검증 스크립트만 바꾸면 기존 앱 빌드를 재사용할 수 있어요. 브라우저와 milestone 결과에는 이와 별개로 테스트·검증 설정까지 포함한 전체 지문을 기록하고 실행 전후 동일성을 확인해요. 테스트를 실행 중에 고친 결과는 PASS로 남기지 않아요.

기본 브라우저 검사는 기능·키보드·취소·초안·오류·터치 영역을 유지해요. 성공 화면 캡처·추가 폭 전수 반복·정밀 정렬은 `NR_VISUAL_REVIEW=1`에서 실행하며 실패 screenshot/trace는 항상 보존해요. 특정 도메인의 시각 검사만 필요하면 PowerShell에서 `$env:NR_VISUAL_REVIEW='1'`을 설정해 기존 `verify:*`를 실행한 뒤 환경변수를 제거해요. 기본 성능 단위검사는 큰 본문과 이력 격리 기능을 한 번씩 검사하며, 반복 측정·성능 파일은 `NR_BENCHMARK=1`에서만 만들어요.

`build`는 별도 `.build-*` 폴더에서 서버·웹을 모두 컴파일하고 소스 지문을 확인한 뒤 `dist`를 교체해요. 컴파일 실패·환경 차단·소스 변경이면 이전 빌드를 보존하며 `output/build/<run-id>/summary.json`과 단계별 로그를 남겨요. 보존된 빌드는 현재 소스의 검증 근거가 아니므로 브라우저 검증의 지문 검사는 그대로 적용해요. 같은 checkout의 동시 빌드는 `output/build/active.json`으로 거부해요. 강제 종료 후 잠금이 남았다면 기록된 PID와 해당 실행의 staging/이전 빌드 경로를 확인한 후에만 잠금을 정리해요.

`test:tooling`은 `tests/*.node.test.mjs`와 `scripts/*.test.mjs`를 자동으로 찾아 자식 프로세스 없이 파일 보존·진단·HTTP fixture·SQLite 증거 판정을 검사해요. 각 디렉터리에서 검사 파일이 발견돼야 하며 실행 파일마다 실제 선언한 검사가 있어야 해요. 결과는 `output/tooling/<run-id>/`에 남으며 전체 Vitest·앱 자식 실행·브라우저를 대체하지 않아요.

합성 브라우저·milestone·worktree 검증과 로딩 측정은 `scripts/lib.mjs`의 `localVerificationEnv`로 무작위 loopback 포트·test mode·빈 인증·Codex 비활성화를 고정해요. 부모 프로세스의 self-host origin과 Codex 실행 경로는 자식 환경에서 제거하고, 등록 검사의 loopback fixture origin과 실행별 DB·temp·브라우저 경로는 유지해요. 실제 공급자와 self-host 검증은 각자의 실행 설정을 사용해요.

VS Code에서는 권장 `biomejs.biome` 확장을 설치하면 지원 코드 파일을 저장할 때 서식을 맞출 수 있어요. 확장 설치는 선택 사항이며 CLI와 CI가 동일한 설정을 사용해요. `.editorconfig`와 기존 `.gitattributes`는 UTF-8·LF·공백 2칸 기준을 맞춰요.

## 검사 범위와 예외

- `core/`, `server/`, `web/`, `tests/`, `scripts/`, `fixtures/`, 루트 TS/MJS/JSON 설정과 `.vscode` 설정을 검사해요. 기존 `tsc` 범위에 없던 검증용 `.mjs`도 lint해요.
- `node_modules`, `dist`, `output`, `.local`, 비밀 설정과 사용자 DB는 검사·자동 수정 대상이 아니에요. `package-lock.json`은 npm이 관리해요. 과거 UI 시안과 Markdown 문서는 코드 lint 대상이 아니에요.
- Biome의 recommended preset에서 코드 정확성·의심스러운 구문 검사를 사용하고 warning도 실패로 처리해요. Hooks 의존성도 검사하되, effect의 의도된 갱신 조건은 검토 후 해당 위치의 이유 있는 주석으로 보존해요. deps 자동 추가로 요청 재실행이나 반복을 만들지 않아요.
- 스타일·복잡도·접근성 규칙 묶음은 이번 필수 lint에 포함하지 않아요. 서식은 formatter가 담당하고, 접근성·UI 동작은 실제 화면 검증으로 다뤄요. 이 설정이 접근성 검증을 대신하지는 않아요.
- `noExplicitAny`, `noAssignInExpressions`, `noThenProperty`, `noArrayIndexKey`는 비활성화해요. 기존 DB/fixture 타입 경계, 파서 루프, PromptProgram의 `then` 필드, 순서가 고정된 표현 목록을 일괄 재설계하지 않기 위한 선택이에요. TypeScript `strict`는 유지해요.
- 그 외 예외는 해당 구문에 `biome-ignore lint/<group>/<rule>: <이유>`로 좁게 남겨요. 새 파일 전체 제외나 이유 없는 규칙 완화로 검사를 통과시키지 않아요. 자동 수정 후에도 의미 변화가 있는지 diff를 확인해요.

## 모듈 경계

Biome `noRestrictedImports`를 디렉토리별로 적용해 다음 import/re-export를 금지해요. 정적인 모듈 문자열을 검사하며, `.js` specifier와 동적 `import()`의 고정 문자열도 대상이에요.

1. `core → server/web` (타입 포함).
2. `server → web` (타입 포함).
3. 제품 코드 `core/server/web → tests/scripts` (타입 포함).
4. `web → server` (타입 포함). 공용 `ChatFolder`는 `core/product.ts`에 있어요.
5. `web → Node 내장 모듈/서버 SDK` (타입 포함).

`core`에는 공용 데이터뿐 아니라 Node transport도 있으므로 Node 사용을 전면 금지하지 않아요. 이 검사는 직접 import 문자열에 적용되며 별칭 해석·전이 의존성·순환 검사는 하지 않아요. 새 경로 별칭이나 서버 SDK를 도입하면 규칙과 경계 테스트도 함께 갱신해요. 전체 브라우저 번들 안전성은 빌드와 실제 실행에서도 확인해야 해요.

`core/`·`server/` 사이의 값 import 순환은 `tests/module-cycles.test.ts`가 정적 `import`/`export … from` 문만 보고 강결합 성분을 계산해 알려진 목록과 비교해요(`import type`와 인라인 `type` 지정자는 간선이 아니에요). 2026-09-10 결정 6으로 `product-store` ↔ `story-archive`·`helper-archive`·`package-start`(모델 snapshot 검증은 `server/provider-archive.ts`, 패키지 값 키는 `core/content-package.ts`), `main-request` ↔ `prompt-snapshot`(호스트 문맥은 `server/main-host-context.ts`), `transport` ↔ `vertex`·`provider-http`·`vertex-auth`(연결·요청·카탈로그 검증은 `core/provider-request.ts`)의 순환을 없앴어요. 남은 순환은 `server/package-images.ts` ↔ `server/source-editing.ts` 하나이며 목록에 적어 두었어요. 새 순환은 이 검사가 막고, 목록에 추가하는 것은 결정이 필요한 변경이에요.

## CI

`.github/workflows/quality.yml`은 PR과 main push에서 Windows / Node 24.14.0으로 `npm ci` 후 **같은 `npm run quality:full`**을 실행해요. npm 다운로드 캐시를 재사용하고 같은 브랜치의 오래된 실행은 취소해요. 브라우저 전체 회귀는 수동 실행의 `browser` 옵션으로 추가할 수 있어요. 로컬 검증과 GitHub에서 실제 실행된 결과는 구분해요.

`verify:redesign`은 모든 브라우저 spec을 한 번의 Playwright 명령으로 돌리므로 공용 기본값 600초로는 끝나지 않아요. 2026-09-10에 한 기계에서 잰 완주 시간은 9.2분과 11.8분이고, 그 이전 기록의 반복된 timeout FAIL도 같은 원인이에요. 그래서 이 검사만 30분 한도를 직접 지정하고 CI job 한도를 45분으로 두었어요. 두 값은 멈춤을 잡기 위한 상한이지 목표 실행 시간이 아니에요. 검사마다 자기 묶음에 맞는 한도를 지정하는 기존 방식을 따랐어요. `runBrowserVerification`에 한도를 직접 넘기는 검사는 이 검사를 포함해 열여섯 개이고, 나머지 열다섯 개는 모두 120~360초로 기본값보다 좁혀요. 기본값보다 늘리는 것은 이 검사뿐이에요. `verify:self-host`와 `verify:worktrees`도 `timeout`을 쓰지만 공용 실행기를 거치지 않는 개별 명령·조작의 한도예요. Windows CI에서의 실제 완주 시간은 아직 측정하지 않았어요. 2026-09-10 macOS 측정에서 남은 실패가 macOS·Edge 한정인지 가르기 위한 Windows 전체 회귀 1회 재측정과 완주 시간 지연 조사([회귀 브리프](../project-plan/BRIEF-FULL-RUN-REGRESSION-2026-09-10.md))는 릴리스 주기의 작업이에요.

## 채택 이유와 후속 범위

도입 당시 TypeScript는 7.0.2이며, typescript-eslint 8.69.0의 공식 npm peer 범위는 `>=4.8.4 <6.1.0`이었어요. dependency-cruiser 18.2.0 역시 TypeScript 7에서 TS 파일 분석이 누락될 수 있음을 확인해 채택하지 않았어요. TypeScript를 내리거나 별도 파서 환경을 관리하는 대신, Biome와 기존 `tsc`를 조합했어요. typescript-eslint의 타입 기반 Promise 검사 전체와 동등한 범위를 주장하지 않아요. [typescript-eslint 지원 범위](https://typescript-eslint.io/users/dependency-versions/) · [Biome lint](https://biomejs.dev/linter/) · [Biome import 규칙](https://biomejs.dev/linter/rules/no-restricted-imports/).

Knip, mutation/property-based testing, 전체 coverage 목표, 추가 의존성 서비스는 이번 기본 도입에 포함하지 않아요. 기존 계약 테스트를 재사용하고, 초기 품질 검사의 실행 시간과 진단 효용을 확인한 뒤 필요할 때 추가해요. 현재 성능·실행 결과는 `project-plan/QUALITY-RESULTS.md`를 봐요.
