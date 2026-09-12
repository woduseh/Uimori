# 장면 삽화 생성

완성된 응답의 장면을 골라 삽화를 만들어 그 응답 아래에 표시하는 기능이에요. 삽화 생성은 본문 작성·번역·상태 작업과 별도 작업 큐에서 실행되며, 생성 중이거나 실패해도 읽기·쓰기·번역은 계속돼요. 생성기는 **Codex 프로바이더의 공식 이미지 생성 도구**와 **원격 PC의 ComfyUI API** 두 가지이며, NovelAI는 이번 범위에 없어요.

기존 **이미지 배치**(`image` 역할, 등록된 이미지를 문단 사이에 고르는 기능)와는 다른 기능이에요. 삽화는 새 이미지를 만들고, 배치는 이미 있는 이미지를 골라요. 두 기능은 저장 표·작업 큐·설정이 분리되어 있어요.

## 사용 흐름

1. **설정 → 삽화**에서 생성기를 고르고 저장해요.
   - Codex: **설정 → 에이전트**에서 ChatGPT 구독으로 로그인한 뒤, Codex 프로바이더의 모델 프리셋을 **Codex 삽화 모델**로 선택해요.
   - ComfyUI: 원격 PC의 주소(`http://192.168.0.10:8188` 같은 형식), ComfyUI에서 **Export (API)**로 저장한 워크플로 JSON, 장면을 그림 설명으로 옮기는 **프롬프트 모델**(어떤 텍스트 모델 프리셋이든 가능)을 지정해요. **ComfyUI 연결 확인** 버튼은 `GET /system_stats`만 호출해 버전·장치를 보여줘요.
2. 자동 생성을 켜면 새 본문이 저장될 때마다 장면당 삽화 1개를 예약해요. 자동 예약에서는 장면을 읽는 모델(Codex 또는 프롬프트 모델)이 그릴 순간이 없다고 판단하면 **생략**할 수 있고, 생략은 실패가 아니라 한 줄 안내로만 표시하며 개수 한도를 쓰지 않아요. 끄면 각 장면의 ⋯ 메뉴에서 **삽화 생성**을 눌러요. 직접 요청은 항상 그리려고 시도해요. 완료된 삽화가 있으면 **새 삽화 생성**으로 추가 삽화를 요청해요.
3. 결과는 해당 장면 아래 삽화 영역에 표시돼요. 실패한 삽화는 원인 코드와 안내를 보여 주고 **다시 요청**·**삽화 삭제**를 제공해요. 진행 중인 삽화는 **취소**할 수 있어요.
4. 채팅 설정 → 이미지의 **삽화 참조 이미지**에서 채팅에 등록한 이미지나 장착한 자료의 이미지를 **캐릭터 디자인** 또는 **그림체**로 지정해요. Codex 경로에서만 사용하며 ComfyUI에는 아직 보내지 않아요.

## 설정과 한도

| 항목 | 값 | 설명 |
| --- | --- | --- |
| 생성기 | `none` / `codex` / `comfyui` (`fixture`는 테스트 모드 전용) | 미지정이면 요청이 `ILLUSTRATION_GENERATOR_UNCONFIGURED`로 거절돼요. |
| 자동 생성 | 켜기/끄기 | 새 본문 저장 직후 예약. 후보 응답(candidate)·작성된 도입문·포크 복사본은 예약하지 않아요. |
| 장면당 최대 삽화 개수 | 1~8 | 이미지가 있는 완료 작업 + 진행 중 작업 수예요. 한 작업이 여러 이미지를 반환해도 1개로 세요. 최초 예약·수동 재요청·결과 회수 모두 현재 한도를 적용하며, 한도를 높이거나 기존 삽화를 삭제하면 다시 시도할 수 있어요. |
| 자동 재요청 횟수 | 0~5 | 접수 전 연결 실패가 확인됐거나 원격 실행 실패가 확정된 경우 등 안전한 실패에만 적용해요. 전송 후 timeout·연결 단절·ComfyUI POST 5xx는 접수 불확실로 남기고 자동 재생성하지 않아요. 설정 오류·거절·사용량 한도도 바로 실패예요. |
| 그림 지침 | 2,000자 | Codex에는 그대로, ComfyUI에는 프롬프트 모델에 전달해요. |

한 장면에는 동시에 하나의 삽화 작업만 진행돼요(`ILLUSTRATION_ACTIVE`). 설정은 **예약 시점에 작업 안에 고정**되며, 저장을 바꿔도 진행 중인 작업과 과거 결과는 바뀌지 않아요. 새 삽화 생성이 실패해도 이전에 완료된 삽화는 그대로 남아요.

## 저장과 표시 계약

- 표는 `illustration_settings`, `illustration_references`, `illustration_jobs`, `illustration_images`예요. 스키마 버전은 **v15 그대로**이고, 기존 v15 DB를 열 때 없으면 `CREATE TABLE IF NOT EXISTS`로 추가해요. 다른 표와 사용자 데이터는 건드리지 않아요.
- 작업은 `source_revision`과 예약 당시 `source_hash`에 귀속돼요. 원문을 나중에 고쳐도 완료된 삽화는 요청 당시 장면의 것으로 그 응답 아래 남고 **수정 전 원문의 삽화**로 표시해요. 새 본문에 자동으로 다시 붙이지 않아요. 실행 시에는 예약 hash의 원문을 다시 읽어요(`sourceAtHash`).
- 원문 구간 정책(`sourceSegments`)이 있는 원고는 `main` 구간의 본문만 생성기에 보내요. 별도 구간(aside/annotation)의 내용은 삽화 입력에서 제외해 공개 카드로 새지 않게 해요.
- 상태는 `queued → running → completed | failed | cancelled | interrupted`예요. 취소는 `generation`을 올려 늦게 도착한 결과를 버리고, 서버 재시작은 `running`을 `interrupted`로 바꾸며 자동 재생하지 않아요(`queued`는 다시 실행해요).
- 이미지 bytes는 SQLite `illustration_images`에 PNG·JPEG·WebP 16MB 이하로 저장하고 `/api/illustration-images/:id`로 읽어요. 캡션·프롬프트·Codex의 revised prompt는 함께 저장해요. 자동 생략은 이미지 없는 `completed`이며 `diagnostic.skipped`에 이유를 남겨요.
- Reader(`GET /api/chats/:id/reader`)는 페이지 안 장면의 `illustrations`를 돌려 주고, SSE 이벤트 `illustration.*`는 해당 장면만 갱신해요. 작업 현황(`reader.activity`)에는 `kind: 'illustration'`으로 나타나며 `activeJobs` 계산에는 넣지 않아 본문 진행 표시를 막지 않아요.
- 포크는 복사한 원문의 **완료된** 삽화만 함께 복사하고, 채팅·분기 삭제는 삽화 표도 함께 지워요. JSON archive(v15)는 네 표를 포함하며 표가 없는 예전 archive도 복원돼요. 복원 시 고정된 모델 프로바이더는 다른 snapshot처럼 비활성화·비밀키 참조 제거 처리를 해요.
- 참조 이미지는 예약 시 `{ref, role, title, mime, hash, url}`로 고정하고 실행 시 hash가 같은 bytes만 보내요. 사이에 삭제된 이미지는 빠지고 작업은 계속돼요.
- JSON 복원은 전역 자동 생성을 끄고 생성기를 미지정으로 바꾸며 ComfyUI 인증 환경변수 참조도 제거해요. 과거 ComfyUI 입력은 비활성화되어 재전송·결과 회수를 하지 않아요. 원격 연결을 다시 설정한 뒤 새 요청으로 사용해요. 완료 이미지와 실제 attempt의 사용량·비용은 보존하고, 포크는 실행 attempt 소유권을 복제하지 않아요.
- 이미지 저장과 archive 복원은 PNG·JPEG·WebP의 MIME과 실제 파일 서명, 16MB 한도, hash와 채팅 귀속을 확인해요. 완전한 이미지 디코더로 손상 여부까지 검사하는 계약은 아니에요.

## Codex 경로

- 별도 Codex 프로세스에서 `thread/start` → `turn/start` 한 턴을 실행해요. 텍스트 판단 턴과 같은 cached 웹 검색·격리 JavaScript 계산에 `features.image_generation=true`를 추가해요. shell·파일·MCP·앱·외부 스킬의 환경 접근은 [Codex 실행 경계](CODEX.md)에 따라 제한해요. 텍스트 판단 턴에는 `features.image_generation=false`를 명시해 이미지 생성의 예약·귀속·저장을 삽화 경로에 유지해요.
- 입력은 `{task, styleGuidance, characterNotes, illustrationInstructions, attachedReferences, scene}` JSON 텍스트와 참조 이미지(`{type:'image', url:'data:...'}`)예요. 장면은 끝에서 24,000자까지 보내요. 패키지의 `instructions.target: 'image'` 지침과 봇·페르소나 본문을 인물 참고로 함께 넣어요.
- 결과는 `item/completed`의 `imageGeneration` 항목에서 읽어요. `result`(base64)를 우선 쓰고, 비어 있으면 전용 Codex home 안의 `savedPath` 파일을 읽은 뒤 삭제해요. 최종 `agentMessage`는 `{caption}` JSON으로 제약해요.
- 실패 코드: `CODEX_IMAGE_USAGE_LIMIT`(항목의 `failure.usageLimitExceeded`, 자동 재요청 없음), `CODEX_IMAGE_NOT_GENERATED`(이미지 항목 없음, 재요청 가능), 기존 Codex 코드(`CODEX_LOGIN_REQUIRED`, `CODEX_TURN_FAILED` 등).
- 삽화 턴은 텍스트 턴의 동시 실행 슬롯과 별도 슬롯(동시 1개, 대기 8개)을 써요. Codex 로그인·프로바이더 권한은 텍스트 턴과 같은 검사를 거치며 attempt는 `role: 'illustration'`으로 기록하고 첨부 bytes는 attempt에 넣지 않아요.
- 이미지 크기·품질 옵션은 Codex가 정해요. 사용량은 ChatGPT 구독 한도에 포함되고 비용·내부 호출 수는 `null`이에요.

## ComfyUI 경로

- 원격 주소는 `http://`·`https://`만 허용하고 인증 정보·쿼리를 포함할 수 없어요. 프록시 인증이 필요하면 서버 환경변수 이름을 **인증 헤더 환경변수**에 적어 두면 그 값을 `Authorization` 헤더로 보내요. 브라우저는 ComfyUI에 직접 접근하지 않아요.
- 실행 순서: 프롬프트 모델 호출(장면 → `{prompt, negativePrompt, caption}` JSON, 자동 예약이면 `{decision:'skip', reason}` 허용) → 워크플로의 `{{prompt}}`·`{{negative}}`·`{{seed}}` 치환 → `POST /prompt` → `GET /history/{prompt_id}` 폴링 → `GET /view`로 이미지 다운로드.
- 취소는 사용자의 명시 취소일 때만 원격에 닿아요. `POST /api/jobs/{prompt_id}/cancel`의 대상별 취소를 사용해요. 해당 API가 없는 서버(404/405)는 `POST /queue {delete:[id]}`로 대기 항목만 제거하고, 실행 중인 원격 렌더는 계속될 수 있어요. 전역 `/interrupt`는 호출하지 않아요. 서버 종료·timeout은 원격 취소를 보내지 않으며 로컬 generation 보호가 늦은 저장을 막아요.
- **시간 초과(`COMFYUI_TIMEOUT`)는 원격 렌더를 건드리지 않아요.** 작업은 `prompt_id`를 보존한 채 실패로 남고, 삽화 카드의 **결과 확인**(`POST /api/illustrations/:id/reconcile`)이 `GET /history/{prompt_id}`를 한 번 읽어 끝난 결과를 저장해요. 결과 확인은 새로 그리지 않으며, 아직 결과가 없으면 이전 상태로 되돌려요. 서버 재시작으로 `interrupted`가 된 ComfyUI 작업도 같은 버튼으로 회수해요.
- 워크플로는 API 형식(`노드 ID → {class_type, inputs}`)만 받아요. UI 형식(`nodes`/`links`)은 `COMFYUI_WORKFLOW_UI_FORMAT`으로 거절해요. 문자열 입력 안의 자리표시자만 바꾸고 노드 구조는 그대로예요. `{{seed}}`만 있는 문자열은 숫자로 바꿔요.
- 출력은 `outputs[*].images` 중 `type: 'output'`을 우선해 최대 4장까지 저장해요. 프롬프트 모델이 쓴 캡션을 삽화 캡션으로 써요.
- 실패 코드와 진단: `COMFYUI_PROMPT_REJECTED`는 노드 오류를, `COMFYUI_EXECUTION_FAILED`는 실행 오류를 **생성 상세**에 표시해요. 접수 여부는 전송 전부터 기록하며 `COMFYUI_SUBMISSION_UNCERTAIN`은 새 렌더를 자동 제출하지 않아요. 접수 후 조회 실패는 `COMFYUI_RESULT_UNAVAILABLE`과 prompt ID를 보존해 **결과 확인**을 제공해요. 요청 전체 deadline은 응답 헤더뿐 아니라 JSON·이미지 body 읽기에도 적용해요. reader는 취소 신호를 직접 구독하며 본문·정리 응답이 멈춰도 종료가 지연되지 않아요.
- 참조 이미지 업로드(`POST /upload/image`)는 이번 구현에 없어요. 작업 입력에는 참조 목록이 그대로 고정되므로 나중에 ComfyUI 어댑터만 확장하면 돼요.

## API

| 경로 | 설명 |
| --- | --- |
| `GET/PUT /api/illustration-settings` | 전역 설정. `PUT`은 `expectedRevision` CAS. |
| `POST /api/illustration-settings/comfyui/test` | `{baseUrl, authorizationEnv}`로 `system_stats` 확인. 실패는 502에 `{code, comfyui}` JSON. |
| `GET/PUT /api/chats/:id/illustration-references` | 채팅별 참조 역할. 후보는 채팅 이미지와 장착 자료 이미지. |
| `POST /api/sources/:id/illustrations` | 수동 예약. `expectedSourceHash`(선택). 테스트 모드에서만 `fixture` 옵션. |
| `GET /api/chats/:id/illustrations`, `GET /api/illustrations/:id` | 목록과 고정 입력을 포함한 상세. |
| `POST /api/illustrations/:id/retry`, `/cancel`, `DELETE /api/illustrations/:id` | 다시 요청·취소·삭제. |
| `POST /api/illustrations/:id/reconcile` | 기록된 ComfyUI `prompt_id`의 결과만 읽어 저장. 새 생성 없음. 대상이 아니면 409 `ILLUSTRATION_NOT_RECONCILABLE`. |
| `GET /api/illustration-images/:id` | 이미지 bytes. |

테스트 모드(`NR_TEST_MODE=1`)에서는 `/api/test/control`의 barrier·failure point `illustration`과 모의 생성기 `fixture`가 추가돼요.

## 검증

로컬 합성 검사(실제 Codex·ComfyUI 호출 없음):

```powershell
npx vitest run tests/illustration-core.test.ts tests/comfyui-client.test.ts tests/codex-image.test.ts tests/illustration-store.test.ts tests/illustration-runner.test.ts tests/illustration-api.test.ts
```

| 검사 | 확인 내용 |
| --- | --- |
| `illustration-core` | 워크플로 파싱·치환, 프롬프트 JSON 해석, 캡션 envelope, 이미지 형식 감지, 재요청 분류 |
| `comfyui-client` | 합성 HTTP 서버로 인증·접수/조회/이미지 body 정체·응답 유실·5xx·대상별 취소와 구버전 대기 삭제·shutdown 미접촉·결과 회수 검사 |
| `codex-image` | 합성 app-server로 `features.image_generation`, data URL 첨부, base64/저장 파일 결과, 사용량 한도, 이미지 없음, 텍스트 턴의 이미지 차단 |
| `illustration-store` | v15 DB 표 추가, 설정 CAS·검증, 예약 한도·동시 1개, 자동 예약과 설정 오류 표시, 재요청·취소·복구, 참조 고정, 포크·삭제·archive |
| `illustration-runner` | 모의 생성기의 자동 재요청·한도·취소, Codex 턴 입력·attempt·캡션, 프롬프트 모델+ComfyUI 전체 경로와 실패 분류, 자동 예약의 생략(skip)과 직접 요청의 생략 금지, 시간 초과 후 결과 확인(reconcile) |
| `illustration-api` | 테스트 모드 App에서 수동·자동 생성, 한도, 자동 재요청, 다시 요청, 취소, 주입 실패, 참조·설정 API, Reader·이벤트 반영 |
| `npm run verify:illustration` | 빌드 후 합성 브라우저(2560·412px): 장면 메뉴의 삽화 생성, 완료 이미지 표시와 새로고침 유지, 실패 카드의 다시 요청, 삭제 확인, 설정 저장과 CAS 충돌 시 초안 유지 |

사용자가 직접 확인해야 하는 항목(실제 서비스 호출):

1. **Codex**: 설정 → 에이전트에서 로그인 후 Codex 모델 프리셋을 삽화 모델로 지정하고 한 장면에서 **삽화 생성**을 눌러요. 확인할 것: 이미지가 장면 아래에 표시되는지, 참조 이미지를 지정했을 때 인물·화풍이 반영되는지, 실패 시 코드(`CODEX_IMAGE_USAGE_LIMIT` 등)가 표시되는지, ChatGPT 계정의 이미지 생성 사용량이 늘어나는지.
2. **ComfyUI**: 원격 PC에서 ComfyUI를 `--listen`으로 띄우고 방화벽을 열어요. **ComfyUI 연결 확인**으로 버전·장치가 보이는지, 실제 워크플로(Export API)에 `{{prompt}}` 자리표시자를 넣고 생성이 끝나 이미지가 저장되는지, 워크플로에 없는 모델 이름을 넣었을 때 노드 오류가 화면에 나오는지, ComfyUI를 끈 상태에서 `COMFYUI_UNREACHABLE`과 자동 재요청 횟수가 표시되는지.
3. **공통**: 자동 생성을 켠 채 본문을 여러 번 이어 쓰면서 읽기·번역이 막히지 않는지, 새로고침·재접속 뒤 삽화가 그대로 보이는지, 장면당 최대 개수에 닿으면 요청이 거절되는지.

## 결정 기록 (2026-09-09)

- **별도 표·별도 큐**: 기존 `jobs`는 `kind IN ('translation','status','image')` CHECK와 텍스트 모델 역할(`TaskRole`) 실행기에 묶여 있어요. 새 kind를 넣으면 v15 DB를 초기화해야 하고 보조 실행기 곳곳에 분기가 늘어나요. 삽화는 텍스트 모델 역할이 아니고 생성기마다 계약이 다르므로 `illustration_*` 표와 `server/illustration-runner.ts`로 격리했어요. 스키마 버전은 올리지 않고 없는 표만 추가해요.
- **Codex는 이미지 생성 턴, ComfyUI는 프롬프트 모델 + HTTP**: 두 생성기를 하나의 공통 API로 뭉개지 않았어요. Codex는 장면을 직접 읽고 그리며, ComfyUI는 글을 읽지 못하므로 텍스트 모델이 프롬프트 JSON을 써요. 프롬프트 모델 호출은 기존 `executeProvider`와 attempt 기록을 그대로 써요.
- **참조 이미지는 Codex 우선**: 채팅별 역할 지정을 예약 시 고정하고 Codex 입력에 role 라벨과 함께 첨부해요. ComfyUI 업로드는 어댑터 확장 지점으로 남겨요.
- **비채택**: 실패 시 다른 생성기로 자동 우회, 프롬프트 자동 변형, 범용 플러그인 시스템, 외부 큐 서비스, NovelAI. RisuAI의 `stableDiff.ts`는 ComfyUI 흐름(`/prompt`→`/history` 1초 폴링→`/view`, 자리표시자 치환, 시드 무작위화)만 원리로 참고했고 코드는 복사하지 않았어요.
- **오류 문구 정책**: LLM 공급자 문구는 기존처럼 코드만 보여 주지만, ComfyUI 노드 오류·실행 오류 문구는 사용자의 서버가 낸 진단이므로 길이를 제한해 표시해요.
- **새 생성과 결과 확인의 분리**(통합 감사에서 보완): ComfyUI 시간 초과·서버 재시작·접수 후 조회 실패는 자동으로 다시 POST하지 않아요. POST 5xx도 서버 접수를 배제할 수 없으므로 자동 재요청에서 제외해요. 접수 전 연결 실패나 원격 실행 실패가 확인된 경우만 재생성할 수 있어요.
- **자동 생략**(검토서 3.1·7장 반영): 자동 예약에서만 모델이 `skip`을 돌려줄 수 있고, 생략은 이미지 없는 완료로 기록해 한도를 쓰지 않아요. 직접 요청은 `allowSkip=false`로 보내 항상 그리게 해요.
- **미채택·후속**: 수동 요청의 request key(현재는 장면당 동시 1개와 화면의 진행 잠금으로 이중 요청을 막아요), 첫 이미지 수신 즉시 Codex 턴 중단, 최근 삽화 요약을 계획 입력에 넣기, ComfyUI WebSocket 진행 표시, 표시용 축소본, 문단 사이 배치, NovelAI. 참고 설계 문서(`~/Downloads`의 계획·검토서)는 인수 뒤 확인했고, 위 결정은 그 문서의 불변 조건을 현재 코드에 맞춰 적용한 결과예요.
