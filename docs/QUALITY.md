# 코드 품질 검사

Node **24.14 이상 24.x**와 `npm ci`를 사용해요. 프로젝트의 `strict` TypeScript 검사를 유지하며, Biome **2.5.12** 하나가 서식·lint·import 경계를 검사해요. 도구 버전은 package-lock.json과 함께 고정해요.

## 실행 시점

| 시점 | 명령 | 범위 |
| --- | --- | --- |
| 수정 중·리뷰 전 | `npm run quality` | 서식 + lint + 타입 + 모듈 의존성. 파일을 수정하지 않아요. |
| 작업 완료·통합 전 | `npm run quality:full` | 위 검사 + 전체 Vitest + 빌드. |
| UI 동작 변경 | 빌드 후 관련 `verify:*` 또는 `npm run verify:redesign` | 새 DB/port를 사용하는 기존 합성 브라우저 검증. |
| 서식 수정 | `npm run format` | Biome가 지원하는 프로젝트 소스·설정의 서식만 수정해요. |
| lint 수정 | `npm run lint:fix` | 도구가 안전하다고 분류한 수정만 적용해요. 해결되지 않은 진단은 실패로 남아요. |
| 개별 검사 | `npm run lint`, `npm run format:check`, `npm run check`, `npm run lint:architecture` | 실패한 단계만 조사할 때 사용해요. |

`quality`는 Biome의 서식·lint를 한 번에 실행해 중복 스캔을 줄여요. 기본 검사에는 서버 실행, 브라우저, 모델 호출, 네트워크 조회, 의존성 설치가 없어요. 매 저장·커밋마다 전체 테스트를 강제하는 Git hook은 설치하지 않아요. 작업에 필요한 검사가 통과하면 변경이나 새 실패 근거 없이 반복하지 않아요.

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

`core`에는 공용 데이터뿐 아니라 Node transport도 있으므로 Node 사용을 전면 금지하지 않아요. 이 검사는 직접 import 문자열에 적용되며 별칭 해석·전이 의존성·순환 검사는 하지 않아요. 새 경로 별칭이나 서버 SDK를 도입하면 규칙과 경계 테스트도 함께 갱신해요. 전체 브라우저 번들 안전성은 빌드와 실제 실행에서도 확인해야 해요. 기존 저장소·transport·요청 구성의 순환 제거는 별도 구조 변경으로 다뤄요.

## CI

`.github/workflows/quality.yml`은 PR과 main push에서 Windows / Node 24.14.0으로 `npm ci` 후 **같은 `npm run quality:full`**을 실행해요. npm 다운로드 캐시를 재사용하고 같은 브랜치의 오래된 실행은 취소해요. 브라우저 전체 회귀는 수동 실행의 `browser` 옵션으로 추가할 수 있어요. 로컬 검증과 GitHub에서 실제 실행된 결과는 구분해요.

## 채택 이유와 후속 범위

도입 당시 TypeScript는 7.0.2이며, typescript-eslint 8.69.0의 공식 npm peer 범위는 `>=4.8.4 <6.1.0`이었어요. dependency-cruiser 18.2.0 역시 TypeScript 7에서 TS 파일 분석이 누락될 수 있음을 확인해 채택하지 않았어요. TypeScript를 내리거나 별도 파서 환경을 관리하는 대신, Biome와 기존 `tsc`를 조합했어요. typescript-eslint의 타입 기반 Promise 검사 전체와 동등한 범위를 주장하지 않아요. [typescript-eslint 지원 범위](https://typescript-eslint.io/users/dependency-versions/) · [Biome lint](https://biomejs.dev/linter/) · [Biome import 규칙](https://biomejs.dev/linter/rules/no-restricted-imports/).

Knip, mutation/property-based testing, 전체 coverage 목표, 추가 의존성 서비스는 이번 기본 도입에 포함하지 않아요. 기존 계약 테스트를 재사용하고, 초기 품질 검사의 실행 시간과 진단 효용을 확인한 뒤 필요할 때 추가해요. 현재 성능·실행 결과는 `project-plan/QUALITY-RESULTS.md`를 봐요.
