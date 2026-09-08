# Gemini 번역 즉시 실패 조사·수정 결과

## 확정 원인

Oracle 운영 DB를 `DatabaseSync(..., { readOnly: true })`로 조회했어요. 첨부 job `dbfa78bc-a30a-4288-a71f-f2f1cb247cc3`은 `PROMPT_UNKNOWN_SLOT`로 실패했으며, 생성부터 종료까지 **46ms**, 연결된 provider attempt는 **0개**예요. 직전 4개 번역도 같은 오류로 45~51ms 안에 실패했어요. API admission에서 거절된 경우가 아니라 생성된 job의 요청 준비 실패예요.

고정 프롬프트 revision 9의 `pheme-7` 블록이 `glossary` 슬롯을 사용하지만 `compileTranslationPrompt`는 그 슬롯을 제공하지 않았어요. 일반 연결 테스트는 이 번역 프롬프트를 조립하지 않으므로 성공할 수 있어요. 공급자 요청 전 실패라 API 키·Gemini 응답·거절 판정·timeout이 이 장애의 원인은 아니에요.

첨부 JSON의 `error: null`은 DB 오류가 없다는 뜻이 아니었어요. 상세 화면이 `auxiliaryErrorDiagnostic(value.error).code`를 내보내는데, `PROMPT_UNKNOWN_SLOT`이 허용 목록에 없어 null/일반 안내로 가려졌어요.

## 실행 상태와 재현

- 로컬 HEAD와 Oracle checkout: `c1fc70476fe6f7c57e377850d54a2f0ead668a19`.
- 수정 전 로컬 `assertBuild()` PASS. Oracle 시작 로그의 buildId와 컨테이너 서버·웹 빌드 manifest 모두 `f25ac522bc589e972a6459a8d977193b4c317fac3b45de959f42db3a78ec9622`; distHash도 로컬과 같았어요. `npm start`가 재빌드하지 않는 것은 확인했으나 이번 장애는 빌드 불일치가 아니었어요. 인증 없는 health 조회의 401/Host 403은 별도 접근 보호 응답이며 번역 진단 근거로 사용하지 않았어요.
- 해당 job의 모델: `gemini-3.8-flash`, 모델 revision 2, `vertex-gemini-v1`, 공식 `aiplatform.googleapis.com`의 global 프로젝트 경로. 현재 저장 모델도 같은 ID/revision이에요.
- job에 고정된 refusal 모델도 Gemini 3.8 Flash이며, 정책은 maxRetries 1 / maxCalls 16이에요. classifier 미지정 가설은 배제했어요. 일반 연결 테스트 성공은 사용자 확인이며 해당 모델 ID의 connection-test 행은 조회에서 발견되지 않았어요.
- 첨부의 고정 program/initial을 이용한 컴파일 재현에서 수정 전 `PROMPT_UNKNOWN_SLOT(glossary)`, 수정 후 컴파일 성공을 확인했어요. 나머지 RunSnapshot은 합성 fixture였으며 개인 본문을 재전송하지 않았어요. 지속 회귀는 동일 슬롯 구조의 합성 자료로 남겼어요.

## 수정

- `core/translation-prompt.ts`: `glossary`를 명시적으로 빈 슬롯으로 제공해요. 현재 독립 glossary 자료 종류는 없으며 일반 모듈은 기존 source-time `lore`/`context.references`에 유지해요. 자료를 임의로 중복 분류하거나 저장 프롬프트를 변경하지 않아요.
- `core/prompt-program.ts`: 알 수 없는 슬롯의 실제 `blockId`와 `slotName`을 분리 보존해요.
- `core/auxiliary-diagnostic.ts`, `server/product-auxiliary.ts`, `server/store.ts`: 준비/번역/판정 단계, 코드, 해당 attempt ID 및 로컬 블록·슬롯을 `job.input.failureDiagnostic`에 보존해요. 기존 소유권·generation·원문 검사와 같은 트랜잭션 안에서 저장하며 모델·프롬프트·policy snapshot을 바꾸지 않아요. 공급자 원래 오류는 연결된 attempt의 response에 있어요.
- `web/auxiliary-error.ts`: 슬롯 오류를 명시적으로 안내하고 실제 코드가 상세 화면에서 null로 사라지지 않게 했어요. 원격 자유 텍스트는 계속 표시하지 않아요.
- `core/provider-http-error.ts`, `core/provider-http.ts`, `core/vertex.ts`, `core/transport.ts`: HTTP 오류 본문을 최대 16,384바이트로 제한하고 기존 timeout/cancel 안에서 읽어요. 허용한 status/code/request-id/필드 경로만 작은 진단으로 남겨요. 원문·메시지·인증정보·임의 필드는 저장하지 않고 기존 `HTTP_<status>`를 유지해요.
- `core/translation-settings.ts`: 별도로 확인한 파서 실패 조건도 좁게 개선했어요. 바깥 공백/BOM과 응답 전체의 단일 `json` 코드펜스만 정규화해요. 설명문 발췌, 다중 객체, 추가 필드, malformed는 계속 uncertain이에요. 이는 이번 즉시 실패의 원인은 아니에요. protocol 지원을 추정한 structuredOutput 변경은 하지 않았어요.

기존 Gemini 중간 system 정규화는 중복 수정하지 않았어요. 실제 Vertex·OpenAI Responses/Chat·Vercel 인코더에서 bare/namespaced 모델 ID와 원본 불변성을 검증했어요. prefill 및 마지막 assistant의 독립 오류 조건도 유지해요. 판정 실패 후보·usage·기존 성공본 보존, 불확실 실패의 자동 재전송 금지, 현재 설정의 새 번역/과거 snapshot 불변성을 회귀로 확인했어요.

## 검증

- 관련 테스트를 먼저 실행한 뒤 `npm run quality:full` PASS: quality·도구 **31개**·새 build·Vitest **1,429 PASS / 선택 검사 1 skip**.
- 중간 테스트 추가에서 발견된 TypeScript unknown spread 오류는 타입 가드로 수정 후 위 전체 검사에 포함했어요. 처음 sandbox spawn EPERM은 승인된 로컬 실행에서 해소됐어요.
- 기존 공통 브라우저 실행기에 auxiliary-recovery/global-models 파일을 지정: **3 PASS**, cleanup/종료 지문 PASS. 최초 실행은 3개 검사 자체는 통과했으나 실행기에 축약한 필수 제목을 지정해 FAIL로 남았고, 정확한 제목으로 재실행했어요.
- `git diff --check` PASS. 사용자 기존 README·배포 문서 변경은 보존했어요.

증거:

- `output/build/build-2026-09-08T22-47-34-373Z-ddf9fd49/summary.json`
- `output/tooling/2026-09-08T22-47-32-706Z-bf45817e/`
- `output/playwright/translation-diagnostics-2026-09-08T22-49-38-213Z-fe1ce954/summary.json`
- 수정 빌드 sourceHash: `75ed544fb51b42978170e8d3bf633f13f77cea5942da5be0b563f28767201e61`.

## 사용자 승인 후 실제 Google 검증

수정 빌드의 실행 코드를 Oracle 컨테이너의 격리된 임시 디렉터리에서 실행했어요. 운영 앱을 교체하거나 Store를 생성하지 않았으며 DB는 읽기 전용, claim/finish는 메모리 bridge였어요. 인증정보는 기존 서버 resolver 내부에만 유지했고 로컬로 가져오지 않았어요. 임시 코드는 실행 후 삭제했어요.

실패 job에 고정된 실제 모델 옵션·프롬프트 revision 9·판정 모델을 사용하되, 원문과 참고 자료는 개인정보 없는 짧은 도서관 장면으로 대체했어요. 시험 호출 한도 2, 자동 재시도 0으로 제한했어요.

| 단계 | 실제 결과 | 입력/출력 토큰 |
| --- | --- | --- |
| 번역 | completed, 정상 한국어 평문 | 5,625 / 3,558 |
| 거절 판정 | completed, `{"verdict":"accepted"}` | 186 / 220 |

총 **2회, 32,136ms**, 전체 작업 completed예요. 공급자가 실제 비용을 보고하지 않아 costUsd는 null로 유지했어요. 토큰 수로 비용을 추정하지 않았어요. 기존 실패 job의 input/error/status는 실행 전후 동일해요. onWire만으로 공급자 수신을 주장하지 않으며 이 검증은 실제 completed 응답까지 확인했어요.

증거: `output/translation-debug-20260909/live-result.log`와 합성 시험 runner. 원본 장문 전체·실제 창작 품질·휴대폰 검증은 수행하지 않았어요. 저장 프롬프트에는 이전 JSON 전달 지시가 일부 남아 있지만 이번 합성 실제 응답은 평문이었으며 운영 프롬프트를 임의 수정하지 않았어요.

## 적용 상태

디버깅 검증 완료 시점에는 수정이 로컬 작업 트리에 있었고 운영 DB·설정·실패 job 수정이나 커밋·푸시·배포는 수행하지 않았어요. 이후 사용자가 커밋·푸시·Oracle 배포를 승인했으며, 해당 실행 결과는 `output/translation-deploy-20260909/RESULTS.md`에 별도로 기록해요.
