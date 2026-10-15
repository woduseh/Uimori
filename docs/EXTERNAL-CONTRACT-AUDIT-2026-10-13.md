# 외부 연동 계약 조사 — 2026-10-13

## 기준과 범위

조사 시작점은 Uimori **0.8.2**, commit `8e2883697e9209a9635a7d5d0b731caa1727a42d`예요. [AGENTS](../AGENTS.md), [README](../README.md), [CODE-MAP](CODE-MAP.md), 각 소유 문서와 [DEVELOPMENT](DEVELOPMENT.md)를 기준으로 생성·취소·복구·자료 입출력에 연결된 현행 경로를 조사했어요. 개인 작업실의 원고·설정·자료 보존과 낮은 유지보수 비용을 판단 기준으로 삼았어요. 전체 의존성의 모든 기능을 검증한 보고서는 아니에요.

| 연동 | 현재 지원하는 경계 | 의도된 제한 / 확인하지 않은 대상 |
| --- | --- | --- |
| [프로바이더](PROVIDERS.md) | Responses `/v1/responses`, OpenAI/DeepSeek/Vercel Chat, Anthropic Messages와 main 전용 Batch, Google Studio Gemini `v1beta`, Vertex Gemini `v1` global. 직접 REST/SSE를 구현 | 임의 호환 서버의 모든 확장, 모든 모델·계정의 옵션 지원은 보장하지 않음. 외부 서비스 배포 버전 미확인 |
| [JEV](PROVIDERS.md#typesafe--jev-연결과-테스트) | TypeSafe `/v1/systemone`, `jev-latest`, Noul/Choice 판정. 로어·거절·이미지 메타데이터 선택 | 실제 응답 모델 버전·판단 품질 미확인. 이미지 픽셀 판정 아님 |
| [Codex](CODEX.md) | stdio App Server, 전용 로그인 디렉터리, native 도구·텍스트 실행·별도 삽화 실행. 기본 CLI 0.153.0+, native 검증 기준 0.158.0 | 작업 thread 자동 resume/replay 없음. 설치 schema·초기화 성공은 구독 생성·code_mode·imagegen 가용성 증거가 아님 |
| [ComfyUI](ILLUSTRATIONS.md) | self-hosted HTTP API-format workflow, `/prompt` 제출 → `/history/{id}` 조회 → `/view` 수집. 대상별 취소 미지원 시 queue 삭제만 시도 | 참조 이미지 업로드·WebSocket·모델/노드 자동 설치 없음. 원격 서버·커스텀 노드 버전 미확인 |
| [Risu 파일](RISU-IMPORT.md) · [내보내기](RISU-EXPORT.md) | CCv3 CHARX/CHARX-JPEG/PNG/JSON, RISUM v0, RISUP envelope v0/v2, 모듈 JSON/프로젝트 ZIP. 현재 원문과 지원 이미지로 새 파일 생성 | v2 신규 가져오기, 독립 JS 플러그인, 원본 컨테이너의 바이트 동일 보관은 미지원. 명시된 폐기 필드·연결 인증 설정 제외는 결함으로 분류하지 않음 |
| [Risu 실행](RISU-IMPORT.md) | 고정 Risu 소스의 CBS, 지원 regex/트리거/Lua, 격리 Wasmoon worker, 지원 Host API | 최신 Risu 전체 호환 아님. 표시 콜백은 상태 사본·일회성 VM. 임의 JS·iframe·미지원 Host API 및 inlay 모델 입력 전체를 보장하지 않음 |
| [테마](THEME-AUTHORING.md) | `uimori-theme` v1 JSON, 앱/본문 CSS와 Shadow DOM 슬롯·표시용 HTML | JS/CBS 실행·폼 제출·외부 이미지 묶음 자동 이식 없음. 외부 CSS/이미지 URL은 브라우저 정책에 의존 |
| [런타임·저장](DATA-MIGRATIONS.md) | Node 24.x, SQLite schema 15 / `uimori-personal-v1`, 온라인 백업, 현재 자료의 새 사본 가져오기와 중복 방지 영수증 | 구형 DB 자동 변환·초기화 없음. 운영 DB·개인 원고·인증 파일은 조사하지 않음 |

## 버전 증거

`package.json`, lockfile v3의 `packages`, 실제 `node_modules/*/package.json`을 별도로 읽었어요. 직접 의존성 전체의 버전은 세 위치가 일치했으며, 아래는 이번 경계에 관련된 항목이에요. 숫자만 적힌 선언은 범위 지정이 아닌 정확 버전이에요.

| 대상 | 선언 | lockfile 해석 | 실제 설치 / 실행 |
| --- | --- | --- | --- |
| Node | `>=24.14.0 <25`; `.nvmrc`는 `24.21.0` | npm 패키지 잠금 대상 아님 | **24.14.0**, npm 11.20.0 |
| HTTP dispatcher `undici` | 7.29.1 | 7.29.1 | 7.29.1. Node 내장 fetch의 Undici **7.21.0**과 구분 |
| Google 인증 `google-auth-library` | 11.0.2 | 11.0.2 | 11.0.2. 생성 SDK가 아니라 OAuth 인증에 사용 |
| Lua `wasmoon` | 1.16.0 | 1.16.0 | 1.16.0; npm gitHead `87c783a8d0bf65afeda933fa47d8dc996be53bb3` |
| `dompurify` / `markdown-it` | 3.4.15 / 15.0.2 | 3.4.15 / 15.0.2 | 3.4.15 / 15.0.2 |
| `msgpackr` / `stream-json` | 1.11.8 / 3.7.0 | 1.11.8 / 3.7.0 | 1.11.8 / 3.7.0 |
| `sharp` | 0.35.4 | 0.35.4 | 0.35.4 |
| `react` / `react-dom` | 19.2.8 / 19.2.8 | 19.2.8 / 19.2.8 | 19.2.8 / 19.2.8 |
| 토크나이저 `tiktoken` / `@huggingface/tokenizers` | 1.0.22 / 0.2.0 | 1.0.22 / 0.2.0 | 1.0.22 / 0.2.0; 로컬 추정은 원격 과금 증거가 아님 |
| 검사 `@playwright/test` | 1.63.0 | 1.63.0 | 1.63.0 |
| `@types/node` | 26.4.1 | 26.4.1 | 26.4.1. 타입 버전은 실행 Node 버전의 증거가 아님 |
| SQLite / 브라우저 | Node 내장 / Chrome 또는 Edge | npm 패키지 잠금 대상 아님 | SQLite **3.51.2**, Chrome **154.0.8037.99** |
| 외부 Codex CLI | 프로젝트 npm 의존성 없음; 위 문서의 지원 기준 | 프로젝트 lockfile에 없음 | Uimori PATH 탐색 대상 **0.162.0-alpha.17.2**, 별도 npm 설치 **0.162.0**. 운영 설치 버전은 미확인 |

포함 외부 소스는 [Risu SNAPSHOT.json](../third_party/risuai/cad8595a/SNAPSHOT.json)의 **`cad8595aa39620df4246f56918f0962c2aa0263a`**예요. RPack 해독표·CBS·로어·타입 추출을 포함하며 원본 파일 해시와 변경 내용이 기록돼 있어요. 대응 release tag나 설치 Risu 앱 버전으로 추정하지 않았어요. `@risuai/ccardlib` **0.4.2**는 이 스냅샷의 타입·일부 함수 출처이며 설치 의존성이 아니에요. 토크나이저 자산의 개별 출처는 [자산 안내](../third_party/tokenizers/README.md)가 소유하며 이번에 모델별 추정 정확도까지 조사하지 않았어요.

OpenAI/Anthropic/TypeSafe 생성 SDK와 ComfyUI SDK는 사용하지 않아요. Uimori 프로토콜 이름의 `-v1`은 어댑터 식별자이며 원격 서버 릴리스 버전이 아니에요. Anthropic는 명시적인 `anthropic-version: 2023-06-01`을 사용해요. `jev-latest`의 실제 모델은 호출하지 않았고, 공식 모델 문서의 현행 `jev-1.13.0`을 설치/응답 버전으로 취급하지 않았어요.

## 확인한 현재 결함과 수정

각 항목은 명시 지원 범위와 구체적인 입력/응답 위반을 함께 확인했어요. 확신은 모두 **높음**이며 실제 원격 서비스 장애를 관측했다는 뜻은 아니에요. 파일 위치는 해당 심벌 기준이고, 아래 출처 ID는 마지막 표의 버전·확인 날짜를 가리켜요.

| ID | 증상과 발생 조건 | 코드 위치·수정 | 계약 및 재현 근거 |
| --- | --- | --- | --- |
| F1 | CCv3 PNG에서 `assets`를 생략하면 기본 표지가 누락 | [readCardPng](../server/risu-card-path.ts): 생략한 경우만 기본 `icon/main/ccdefault:` 부여. 명시적 `[]` 유지 | CCv3의 기본 assets 규정(S1). 실제 PNG 준비 결과 이미지 0개 → 1개, 저장·CHARX 재출력 확인 |
| F2 | `icon/main` 뒤의 배경/일반 `main` 이미지가 대표를 덮어씀 | [importRisuAssets](../server/risu-import-assets.ts): icon/main 우선. 아이콘 없는 카드의 기존 선택 규칙 유지 | CCv3 대표 icon 규정과 Risu 고정 소스(S1/S2). 순서가 다른 CHARX 두 경우의 저장·내보내기 검증 |
| F3 | Lua `LLM`/`axLLM`에 `sys`·`bot` 역할을 넣으면 호출 전 실패 | [createNativeRisuHost](../server/risu-native-host.ts): `sys→system`, `bot/char→assistant`; 내용·순서 유지 | 지원 Host API의 고정 Risu 소스 매핑(S3). 수정 전 `RISU_NATIVE_MODEL_PROMPT`, 수정 후 Lua→호스트→직렬화 HTTP 요청과 응답 회수 |
| F4 | 실제 Risu 중지 트리거가 미지원 효과로 실패 | [executeNativeRisuInvocation](../server/risu-native-runtime.ts): `v2StopPromptSending` 추가. 기존 `v2StopPrompt`·`stop` 유지 | 고정 triggers.ts 명칭(S3). 수정 전 `RISU_NATIVE_EFFECT_UNSUPPORTED`, 수정 후 실행 결과의 변수·메시지와 stopChat 효과 확인. 중단한 실행의 DB 저장을 검증한 것은 아님 |
| F5 | Comfy 프롬프트에 `{{negative}}`·`{{seed}}`가 있으면 모델이 작성한 문자열이 변형됨 | [fillComfyWorkflow](../core/illustration-workflow.ts): 원래 템플릿에만 한 번 치환 | Uimori 고정 프롬프트 계약과 CLIPTextEncode 문자열 입력(S6). 실제 POST body에서 `inscription {{negative}}, code {{seed}}`가 변형되는 실패 후 문자 그대로 전송 |
| F6 | 접수 후 history의 401/403/404/429를 대기로 오판해 timeout까지 반복·상태 누락 | [fetchComfyUIResult](../server/comfyui-client.ts): 즉시 조회 실패, 기존 결과 미확인 경로로 prompt ID·HTTP 상태 보존 | HTTP 오류 의미(S7), 공식 history의 미완료 `{}`와 오류 응답 구분(S6). fixture HTTP 및 임시 DB에서 재접수 0회·같은 prompt 결과 회수 검증 |
| F7 | DeepSeek 원격 중단이 미지원 형식 오류로 기록됨 | [ChatDecoder.finalize](../core/openai-chat-protocol.ts): `aborted`·`insufficient_system_resource`를 알려진 partial/error로 처리 | 공식 finish_reason(S8). 종료 사용량·후행 usage·[DONE]·불완전 도구 인수를 포함한 SSE 회귀. 미완성 도구 실행/자동 재요청 없음 |
| F8 | 테마 맨 앞 `<style>`이 사라지고, 맨 앞 `<script>`도 미지원 안내 없이 빠짐 | [themeTemplate](../web/ThemeFrame.tsx): 비활성 template 조각을 파싱해 DOMPurify에 전달 | 명시된 인라인 style/미지원 안내 계약, DOMPurify 3.4.15의 문서 파싱과 DOM 입력(S9). 실제 Chrome에서 style 0개/검정 → 1개/지정 색, script 거절 확인 |
| F9 | CCv3 PNG 첨부 키가 숫자 대신 `images/scene.webp`이면 전체 가져오기 실패 | [readCardPng](../server/risu-card-path.ts): 문자열 키→통제된 내부 순번 매핑. 원래 키를 파일 경로로 사용하지 않음 | 공개 PNG `{path}` 규정과 Risu 문자열 키 처리(S1/S2). 수정 전 `RISU_IMPORT_INVALID_FILE`, 수정 후 실제 PNG→저장→CHARX의 원문·이미지명·역할·바이트 보존. 중복 키 거절 유지 |

F8 수정 전에도 script가 실행된 증거는 없어요. 스타일 보존과 오류 안내의 결함이며 보안 침해로 과장하지 않아요. 변경한 소유 문서는 [PROVIDERS](PROVIDERS.md), [ILLUSTRATIONS](ILLUSTRATIONS.md), [RISU-IMPORT](RISU-IMPORT.md), [THEME-AUTHORING](THEME-AUTHORING.md)예요.

## 남긴 위험과 분류

| 분류 | 조건·사용자 영향 | 위치·근거·확신 / 수정하지 않은 이유 |
| --- | --- | --- |
| 공개 experimental 계약 의존 | Codex CLI 갱신으로 native 도구·환경 선택 요청이 거절될 수 있음 | `core/codex-protocol.ts`, `server/codex-runtime.ts`; S4. **높음**. 비공개 API는 아니지만 안정성을 보장하지 않음. 현재 위반을 입증하지 못함 |
| 비공개·미보장 구현 의존 | Risu 포맷/Wasmoon 갱신 시 파일 해독·Lua 시작 실패 가능 | `server/compat/risu/`, `server/risu-lua-worker.ts`; S2/S3/S5. **높음**. RISUM/RISUP 내부 codec·고정 키 및 WASM 메모리 패치는 공개 안정 계약이 아님. 고정 버전에서 검사 통과, 자동 최신화 없음 |
| 소스 관찰에 의존 | 커스텀 Comfy 서버가 실행 도중 history를 게시하면 완료 판정이 달라질 수 있음 | `server/comfyui-client.ts`; S6. **중간**. 조사한 공식 소스는 종료 후 history 저장. 모든 파생 서버의 게시 순서를 공개 보장으로 취급하지 않음 |
| 공개 보장 없는 파일 위치 | Codex가 inline 결과 없이 전용 home 밖 savedPath만 반환하면 삽화 수집 실패 가능 | `server/codex-runtime.ts`; S4. **중간**. 저장 위치는 DTO의 보장 아님. 현재 재현이 없어 파일 접근 범위를 넓히지 않음 |
| 실제 대상 확인 필요 | Vercel reasoning_details의 동일 index 분할 서명이 후속 도구 요청에서 거절될 가능성 | `core/openai-chat-protocol.ts`의 배열 metadata 누적; S10. **낮음**. 증분/index는 문서화됐지만 replay 재조립 실패는 미재현. 예방 변환을 추가하지 않음 |
| 실제 대상 확인 필요 | DeepSeek 추천 `deepseek-v4-flash`와 현 문서 `deepseek-flash` 차이 | `core/provider-catalog.ts`; S8. **낮음**. 이전 ID 거부 근거 없음. 원격 목록·직접 ID 입력 유지, 최신 이름으로 임의 교체하지 않음 |
| 지원 범위 확인 필요 | Lua `useMultimodal`과 inlay를 텍스트 모델 호출에 전달했을 때 실제 첨부로 해석되지 않을 수 있음 | `server/risu-native-host.ts`; S3. **중간**. Lua inlay 모델 입력 전체 지원이 명시되지 않아 범위를 임의 확장/축소하지 않음 |
| 실제 대상 확인 필요 | Batch HTTP 연결이 열린 채 응답이 멎으면 취소/재시작 전까지 정체 가능 | `server/anthropic-batch.ts`, `core/provider-fetch.ts`; S12. **중간**. 구체 원격 장애·SLA 위반 미입증. 임의 timeout/retry 정책을 추가하지 않음 |
| 실제 대상 확인 필요 | Comfy 원격 재시작·history 삭제 뒤 prompt ID의 결과가 없어질 수 있음 | `server/comfyui-client.ts`; S6. **높음**. 원격 영속성 미보장. 불확실 실행을 자동 재접수하지 않는 기존 정책 유지 |

**지원 범위 밖의 차기 버전에서만 재현되는 확정 결함은 발견하지 못했어요.** Google Interactions, 새 Anthropic beta 기능, 최신 Risu 전체 동작, Comfy Cloud 전용 기능을 현행 지원 계약에 끼워 넣지 않았어요. Generate Content의 Legacy 표기만으로 현재 경로를 결함 처리하거나 폐기하지 않았어요.

반대로 현재 대조에서 맞은 주요 경계는 Responses의 수동 입력과 실제 opaque 출력 재전송, Gemini/Anthropic 사고 서명·종료 이벤트, Batch의 custom_id 결과 대응과 불명확 POST 무재전송, JEV의 Noul/Choice·선택지/예산 제한, Codex의 initialize·RPC ID·turn 완료·취소 후 늦은 응답 차단, 가져오기 영수증과 DB 형식 거절이에요. 이는 조사한 요청·이벤트·파일 사례에 대한 판단이며 무결함 선언은 아니에요.

## 검증 수준

1. **공식 문서·소스 대조:** 아래 버전 기준으로 요청·응답·상태·파일 계약을 대조했어요. 공개 규격과 공식 구현 관찰을 위 표에서 구분했어요.
2. **로컬 합성 계약 검증:** 직렬화 HTTP/SSE, loopback Comfy, 합성 PNG/CHARX/RISUM/RISUP, 임시 SQLite, 실제 Wasmoon 및 Chrome을 사용했어요. 개발 환경 doctor의 Node·자식 프로세스·SQLite 재열기·loopback HTTP도 PASS예요.
3. **실제 지원 대상 통합:** 설치된 Codex **0.162.0-alpha.17.2**의 빈 임시 인증 폴더에서 initialize/account/read와 experimental schema만 **1/1 PASS**예요. 모델 호출 0, 로그인 시도 없음. 별도 npm stable 0.162.0의 생성 통합 결과가 아니에요.

| 검사 | 결과·범위 |
| --- | --- |
| Responses/Chat/JEV 사전 focused | 4파일 194 PASS. DeepSeek 변경 후 Chat/HTTP 2파일 116 PASS |
| Google/Vertex/Anthropic | 8파일 190 PASS, 합성 인증·HTTP·Batch 복구 등 당시 실행 범위 |
| Codex | 합성 4파일 78 PASS; 설치 preflight는 위 별도 범위 |
| ComfyUI | 5파일 95 PASS, 실제 POST body·401/403/404/429/503·재접수 금지·결과 확인 |
| Risu 파일 | 표지·대표 수정 후 7파일 88 PASS. PNG 문자열 키 수정 후 영향받는 3파일 34 PASS, PNG/CHARX 왕복과 중복 키 거절 |
| Risu 실행 | 3파일 29 PASS, 개인 CHARX 표본 3 SKIP. Lua→HTTP 요청과 중지 효과 |
| 테마 저장·DB·백업 | 3파일 25 PASS. 실제 임시 SQLite 파일·지원하지 않는 DB 보존 |
| 정적 검사·빌드 | `npm run quality` PASS: Biome 1,184파일 및 TypeScript. `npm run build` PASS; 기존 대형 청크 안내만 남음 |
| 테마 브라우저 | `npm run verify:themes` **15 PASS**, 서버·임시 DB 정리 PASS. Chrome의 실제 스타일 값·미지원 HTML 거절과 기존 읽기 상태 보존 확인, 새 표본 스크린샷도 점검 |
| 문서 | `node scripts/check-documentation.mjs`, `git diff --check` PASS |

여러 Vitest 검사의 첫 sandbox 실행은 임시 SSR 파일 `ENOENT` 또는 파일 작업 `EPERM`으로 실패했어요. 위 PASS는 허용된 일반 호스트에서 동일 검사를 재실행해 얻은 결과예요. 실패/미실행을 PASS로 합산하지 않았고 중복 재실행 횟수를 테스트 수로 더하지 않았어요.

테마 브라우저의 첫 sandbox 실행도 15개 시나리오는 통과했지만 소유 서버 종료 권한 문제로 전체 결과는 FAIL이었어요. 기록된 자식 PID의 실행 경로·부모를 호스트에서 확인해 정리한 뒤 같은 검사를 다시 실행했고, 위 최종 결과는 시나리오와 정리 모두 PASS예요. 로컬 증거는 `output/playwright/themes-2026-10-13T02-24-19-624Z-9015a72d/summary.json`, 빌드 증거는 `output/build/build-2026-10-13T02-23-00-856Z-32036bf4/summary.json`에 있어요. 두 검사의 빌드 ID는 `bb786bbb0b7ca715d1a010535d6b7f3a2f22466414302a88efc18658dd8c240d`로 같아요. 전체 `quality:full`·전체 브라우저 묶음은 실행하지 않았어요.

실제 모델 API/JEV 호출, Google 서비스 계정 인증, Comfy GPU 실행, 실제 Risu 앱의 가져오기·내보내기, 개인 카드 전체, 물리 모바일 기기, 운영 데이터·배포는 확인하지 않았어요. 합성 PASS를 서비스 호환성·모델 품질·실제 청구의 증거로 사용하지 않아요. 유료 호출·운영 데이터 변경·push·배포는 수행하지 않았어요.

## 외부 출처

| ID | 링크·적용 버전 또는 문서 기준 | 확인 날짜 |
| --- | --- | --- |
| S1 | [CCv3 3.0 명세](https://github.com/kwaroran/character-card-spec-v3/blob/f3a86af019fbd99f788f7a1155f399655b34ab35/SPEC_V3.md): commit `f3a86af019fbd99f788f7a1155f399655b34ab35`; PNG 첨부·assets 기본값·icon 규정 | 2026-10-13 |
| S2 | RisuAI commit `cad8595aa39620df4246f56918f0962c2aa0263a`: [characterCards.ts](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/characterCards.ts), [modules.ts](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/modules.ts), [database.svelte.ts](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/storage/database.svelte.ts). 공식 구현 관찰, 설치 앱 버전/공개 codec 안정성 보장은 아님 | 2026-10-13 |
| S3 | 동일 Risu commit: [scriptings.ts](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/scriptings.ts), [triggers.ts](https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/triggers.ts). Lua 역할·중지 효과의 소스 계약 | 2026-10-13 |
| S4 | [Codex 0.153.0 README](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/README.md), commit `41e22fee981a63b3698df7ed36bad393cda24715`. 0.158.0 commit `064c6b8c737f5b41d171fdda80bd9ef10ad06eb3`의 [dynamic tools](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/protocol/src/dynamic_tools.rs), [item](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/app-server-protocol/src/protocol/v2/item.rs), [이미지 저장](https://github.com/openai/codex/blob/064c6b8c737f5b41d171fdda80bd9ef10ad06eb3/codex-rs/ext/image-generation/src/tool.rs). [App Server 현행 문서](https://learn.chatgpt.com/docs/app-server)는 버전 비고정 보조 자료 | 2026-10-13 |
| S5 | [Wasmoon 1.16.0 npm metadata](https://registry.npmjs.org/wasmoon/1.16.0), gitHead `87c783a8d0bf65afeda933fa47d8dc996be53bb3`; [factory.ts](https://github.com/ceifa/wasmoon/blob/87c783a8d0bf65afeda933fa47d8dc996be53bb3/src/factory.ts) | 2026-10-13 |
| S6 | [Comfy self-hosted routes](https://docs.comfy.org/development/comfyui-server/comms_routes)는 버전 비고정. [v0.26.0 server](https://github.com/Comfy-Org/ComfyUI/blob/v0.26.0/server.py), [execution](https://github.com/Comfy-Org/ComfyUI/blob/v0.26.0/execution.py), [nodes](https://github.com/Comfy-Org/ComfyUI/blob/v0.26.0/nodes.py): commit `f6c162ddcfbd7eefb39c06fe5b8d4c46e8d09f40`. [v0.3.76 server](https://github.com/Comfy-Org/ComfyUI/blob/v0.3.76/server.py): `30c259cac8c08ff8d015f9aff3151cb525c9b702`도 대조. 이 태그들은 원격 설치/최소 지원 버전 선언이 아님 | 2026-10-13 |
| S7 | [RFC 9110 HTTP 401](https://www.rfc-editor.org/rfc/rfc9110.html#name-401-unauthorized), 2022년 RFC; 인증 오류와 미완료 history 구분 | 2026-10-13 |
| S8 | [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/), [thinking](https://api-docs.deepseek.com/guides/thinking_mode/). 현행 `/v1` 호환 API 문서, 원격 구현 릴리스·문서 revision 미제공 | 2026-10-13 |
| S9 | [DOMPurify 3.4.15 README](https://github.com/cure53/DOMPurify/tree/3.4.15), [purify.ts](https://github.com/cure53/DOMPurify/blob/3.4.15/src/purify.ts); [WHATWG template·slot](https://html.spec.whatwg.org/multipage/scripting.html#the-template-element)은 Living Standard, 고정 revision 미확인 | 2026-10-13 |
| S10 | [Vercel reasoning](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning), 표시 갱신일 2026-09-08, 서비스 릴리스 비고정 | 2026-10-13 |
| S11 | [Gemini v1beta REST](https://ai.google.dev/api/generate-content), [Flex](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures). [Vertex Flex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo)는 표시 갱신일 2026-10-12. 모두 원격 릴리스·고정 문서 revision 미제공. google-auth-library 해당 태그 소스는 웹 조회 실패로 직접 대조 범위에서 제외 | 2026-10-13 |
| S12 | Anthropic `2023-06-01`: [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [Batch 생성](https://platform.claude.com/docs/en/api/messages/batches/create), [Batch 처리](https://platform.claude.com/docs/en/build-with-claude/batch-processing). 현행 문서, 모델 배포 버전 미확인 | 2026-10-13 |
| S13 | [OpenAI Responses stream](https://developers.openai.com/api/reference/resources/responses/streaming-events), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Chat stream](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events). 현행 API 문서, 원격 릴리스·문서 revision 미제공 | 2026-10-13 |
| S14 | [TypeSafe API](https://docs.typesafe.ai/api), [모델 목록](https://docs.typesafe.ai/models). `/v1/systemone` 현행 문서, `jev-latest` 실제 해석 모델 미확인 | 2026-10-13 |
| S15 | [Node 24.14.0 SQLite](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html), 실제 실행 버전과 같은 문서. DatabaseSync·backup은 공개 API지만 이 버전에서 Stability 1.1 | 2026-10-13 |
