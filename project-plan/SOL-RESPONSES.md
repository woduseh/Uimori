# Sol Responses · Uimori native provider

`sol-responses-v1`은 Sol Responses Relay의 연결·도구·원고 제출 흐름을 Uimori 서버에 맞게 독립 구현한 추가 provider예요. RisuAI 설치나 플러그인 번들 실행 없이 사용해요. 이번 추가 provider 작업은 M3 전체 완료를 뜻하지 않아요.

## 연결과 사용

1. API key를 서버 환경변수에 설정하고 해당 origin을 `NR_PROVIDER_ORIGINS`에 추가해요. 기존 허용 origin은 보존하고 쉼표로 이어 붙여요.
2. **설정 → 연결과 모델 → Sol · Responses**를 선택하고 게이트웨이를 골라요. credential 입력란에는 키 원문 대신 환경변수 이름을 넣고 사용 허용을 켜요.
3. 저장한 연결로 모델 프리셋을 만들고 실제 계정에서 사용 가능한 모델 ID를 입력해요. Vercel은 `provider/model` 형식이에요. 등록만으로 모델 요청은 발생하지 않아요.
4. 새 이야기 또는 이야기 설정에서 필요한 역할에 프리셋을 선택해요. 번역은 **번역 보기**를 명시적으로 눌렀을 때 시작해요.

| 게이트웨이 | API 기본 주소 | 기본 credential 참조 |
|---|---|---|
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `NARRATIVE_PROVIDER_VERCEL` |
| LLM Gateway | `https://api.llmgateway.io/v1` | `NARRATIVE_PROVIDER_LLM_GATEWAY` |
| OpenAI Official | `https://api.openai.com/v1` | `NARRATIVE_PROVIDER_OPENAI` |

세 연결 모두 `/responses`를 사용해요. 명시적으로 origin을 허용한 literal loopback `http://127.0.0.1:PORT/v1` 또는 `http://[::1]:PORT/v1`도 로컬 호환 서버에 사용할 수 있어요. 임의 외부 주소, URL userinfo/query/fragment, 자동 redirect는 허용하지 않아요. 기존 provider 설정은 그대로 유지돼요.

## 옵션과 실행

- 컨텍스트 기본값은 `model-selected`예요. `preloaded`는 같은 로컬 정보를 처음부터 제공하고 도구 라운드가 허용되면 첫 요청을 case 기록 도구로 지정해요.
- 최대 도구 라운드 기본값은 8이며 최초 요청을 포함해 최대 9회 응답을 받을 수 있어요. 이야기의 전체 모델 호출 한도가 더 작으면 그 한도가 우선해요. 번역의 구간별 라운드와 재시도도 작업 전체 한도를 공유해요.
- 종료 원고 교정을 켜면 최대 8개의 정확한 단일 문자열 치환을 제출 본문에 순서대로 적용해요. 모호한 중복 일치·범위 초과는 완료로 저장하지 않아요.
- Reasoning effort / Service tier / Verbosity / Reasoning summary는 선택한 값만 전송해요. 미지원 응답에서 옵션이나 공급자를 자동 변경하지 않아요.
- Encrypted reasoning은 새 기본값에서 활성화돼요. `store:false`인 같은 실행의 도구 왕복에서 원래 output item과 함께 반환하며 원문·Inspector 보관 진단에는 내용을 공개하지 않아요. 미지원 로컬 호환 서버에서는 끌 수 있어요.
- 응답 제한 시간은 모든 Sol 라운드가 공유해요. 화면을 닫는 것과 서버 작업 취소는 별개예요.

일반 텍스트 응답도 정상 원문으로 처리해요. `eval_submit_artifact`로 제출하면 필수 `content`와 `userFacingNotice`를 검사한 뒤 content만 전달해요. notice는 존재 여부·문자 수만 남기고 본문이나 후속 입력에 합치지 않아요. 완료되지 않은 SSE/JSON, 명시적 거절, 중복 호출 ID, terminal과 host 도구가 섞인 모호한 제출은 정상 원문으로 승격하지 않아요.

`eval_get_context`, `eval_get_reviewer`, `eval_create_case`는 실제 로컬 처리 정보와 제안 기록을 반환해요. 외부 검토자·인증된 자격·정책 승인을 주장하거나 앱 권한을 늘리지 않아요. 로어·스킬·기억·원문 조회는 역할별 기존 Uimori 실행기를 거쳐요.

전송 전 attempt를 기록하고 라운드마다 최신 연결·credential ref·origin 권한을 검사해요. 모든 라운드의 사용량을 남기며 미확인 가격/금액은 `null`이에요. Vertex 전용 예산을 Sol의 지출 상한이라고 표시하지 않아요.

## 원본과의 차이 및 검증 한계

- 원본 코드·장문 평가 프롬프트는 복사하지 않았어요. RisuAI 전용 UI·저장소·추론 본문 합성은 Uimori 설정·서버 secret 참조·Inspector로 대체해요.
- 원본의 고정 외부 인물/verified IAM/자동 accepted 문구는 로컬 도구 정보로 대체해요. 원본 평가 프롬프트와의 모델 행동 동등성을 주장하지 않아요.
- LLM Gateway도 공식 문서의 native Responses 형식을 사용하며 원본의 Chat 변환에서 reasoning item을 버리는 방식을 채택하지 않았어요.
- 브라우저 메모리 체크포인트, background Response 복구, 외부 프록시 rewrite/Direct mode, 자동 HTTP 재시도·거절 재작성, 가격 카탈로그는 포함하지 않아요. 재시도·원문 보존은 Uimori의 기존 작업 정책을 따르며 불확실한 실행은 자동 재생하지 않아요.
- 실제 계정 인증·모델 지원·청구·문학/번역 품질은 라이브 검증 범위예요. 로컬 합성 결과를 실제 provider 호환성으로 확대하지 않아요.

## 로컬 검증

```powershell
npm run check
npm run build
npx vitest run tests/sol-settings.test.ts tests/sol-protocol.test.ts tests/sol-runtime.test.ts tests/sol-story-runtime.test.ts
npm run verify:sol
```

`verify:sol`은 현재 소스와 일치하는 빌드를 요구하며 새 DB·포트·브라우저에서 등록·역할 선택·재접속·390px 화면을 검증해요. 실제 provider 조회나 유료 생성을 실행하지 않아요. `output/playwright/sol-*/summary.json`에 reporter·화면·DB·cleanup 결과를 남겨요. 기존 milestone 검사와 실제 사용자 평가를 대신하지 않아요.

M2와 통합한 최종 검사 수치와 고정 소스는 [Sol 결과](SOL-RESULTS.md)에 있어요. 기존 M1/M2 미리보기는 그 당시 빌드를 유지하므로 Sol 설정을 보려면 최신 프로젝트의 `npm run dev`로 새 빌드를 실행해요.
