# Sol Responses provider · 통합 결과

2026-09-07 요청한 추가 provider 구현과 M1·M2 로컬 통합 검증을 완료했어요. [통합 요약](../output/sol-provider/2026-09-07/summary.json)은 전체 unit 598개·browser 34개 PASS를 기록해요. 이 문서의 source/dist와 미리보기·검증 결과는 당시 고정 기록이며, 현재 작업 상태는 [CURRENT](CURRENT.md)를 확인해요.

## 구현과 사용

- **설정 → 연결과 모델 → Sol · Responses**에서 Vercel AI Gateway / LLM Gateway / OpenAI Official 및 명시적으로 허용한 local Responses 연결을 등록해요.
- 모델별 문맥 제공 방식, 도구 라운드, 제한 문자열 교정, Service tier·Verbosity·Reasoning summary·encrypted reasoning 옵션을 저장해요. 기존 설정/archive와 역할 선택 흐름을 유지해요.
- 본문·번역뿐 아니라 M2 state/memory 작업에도 같은 옵션·도구 처리·실행 한도를 연결했어요. 각 역할의 기존 host 도구와 원문·근거 검증을 거쳐요.
- SSE와 완료 JSON, 일반 텍스트와 `eval_submit_artifact`를 처리해요. 필수 notice의 본문은 제외하고 존재 여부·문자 수만 저장해요. 원래 reasoning/output item은 해당 실행의 후속 요청에서만 유지해요.
- 전송 전에 attempt를 남기고 매 라운드 최신 enabled/endpoint/credential ref/origin을 재검사해요. 전체 timeout·호출 한도, 취소, 불확실 실행 자동 재생 금지, source/hash·CAS·owner/generation을 유지해요. 실제 금액을 모르는 비용은 `null`이에요.

주소·credential 설정·원본과의 차이는 [사용법](SOL-RESPONSES.md), 참고 snapshot과 채택 근거는 [SOURCES](SOURCES.md#2026-09-07-sol-평가-도구-참고와-provider-분리)에 있어요.

## 실제 검증

모든 최종 검사는 공용 root의 같은 source/dist에서 수행했어요. 새 합성 DB·포트·브라우저만 사용했으며 기존 사용자 DB를 열거나 변경하지 않았어요.

| 검사 | 실제 결과 | 근거 |
|---|---|---|
| 타입 검사·production build | PASS | 아래 최종 summary의 M0/M1/M2 command 기록 |
| 전체 Vitest | **598/598 PASS**, 실패·skip 0 | [전체 reporter](../output/sol-provider/2026-09-07/final/vitest.json) |
| Sol 설정·codec·실행·M2 결합 | **31/31 PASS**: 설정 5, codec 12, HTTP/SQLite 실행 8, M2 HTTP 결합 6 | 위 reporter의 `sol-*.test.ts` |
| M0 + 검증기 selftest | **13 unit + 3 browser**, 실패 탐지 **11 PASS** | [M0](../output/playwright/2026-09-07T02-07-56-425Z-80356ead/summary.json) |
| M1-local | **55 unit + 6 browser PASS** | [M1-local](../output/playwright/2026-09-07T02-08-52-402Z-cb518110/summary.json) |
| M2-local | **78 unit + 4 browser PASS** | [M2-local](../output/playwright/m2-2026-09-07T02-09-18-590Z-36b1092a/summary.json) |
| 기존 UI | **9 unit + 19 browser PASS** | [UI](../output/playwright/ui-2026-09-07T02-09-41-126Z-d7e26af4/summary.json) |
| Sol UI | **2 browser PASS**, 4 PNG 직접 확인 | [Sol UI](../output/playwright/sol-ui-2026-09-07T02-10-02-278Z-1a8f24c4/summary.json) |

선택 검사에 포함된 unit은 전체 598개와 중복돼요. 브라우저는 합계 **34개**, 검증 서버 **5개 cleanup PASS**예요. 최종 데스크톱 설정·재접속 역할 선택·390px 연결·Sol 옵션 화면을 직접 확인했어요. Sol 문맥·선택 옵션 레이블이 잘리지 않고 가로로 넘치지 않아요. 긴 모델 이름은 기존 선택 상자의 너비에 따라 일부만 보일 수 있어요. 이전 격리 UI의 실패 및 수정 전·후 증거는 삭제하지 않았어요.

실제 localhost HTTP와 파일 SQLite 검사는 전송 전 attempt, host/local 도구 혼합, opaque 재전송, terminal notice 비노출, 원문에 붙는 번역, 연결·credential 철회, 오류·partial·취소·timeout·호출 cap, 중복 ID·terminal 혼합 거부, 직접 수정 CAS를 확인해요. M2 결합 검사는 state/memory 옵션 전달과 terminal JSON 이후의 source/hash·근거·author-canon 검증, 타 채팅 읽기 차단과 local tool 처리까지 포함한 전체 deadline을 확인해요.

## 고정 근거와 보존

- [최종 요약](../output/sol-provider/2026-09-07/summary.json), [전체 실행 기록](../output/sol-provider/2026-09-07/final/summary.json), [고정 소스](../output/sol-provider/2026-09-07/source/README.md).
- source/build: `881ae5a7ea83909a77556f7d2cbb5c6341f345388d8294c775db5161d5ded63c`
- dist SHA-256: `527639a18db32e4d8c27014623d30a3aa7b537fb8d40ade8d11257f755f5ec20`
- M2 인계 기준: `f1bd1f6aa5914f1519d5a0c4ce8ca692f496ffde71c74c01b1666225f8fdfaec`. [파일별 통합 기록](../output/sol-provider/2026-09-07/integration.json)과 변경 전 파일 백업을 남겼어요.
- M1 preview 50695와 M2 preview 54490의 별도 프로세스·DB·dist는 보존했어요. 이 고정 미리보기에는 Sol 변경을 덮어씌우지 않았어요. 최신 사용은 프로젝트 root의 `npm run dev`를 이용해요.

## 한계

추가 유료 요청은 **0회**예요. 실제 계정 인증·게이트웨이별 모델/옵션 지원·청구·문학/번역 품질은 검증하지 않았어요. 원본 장문 평가 프롬프트·외부 검토자/자동 승인 주장·브라우저 복구/자동 HTTP 재생·Chat 변환은 포함하지 않으며 원본과 모델 행동 동등성을 주장하지 않아요. 실제 휴대폰·키보드/IME, 외부 배포도 별도예요. 이번 결과는 추가 provider의 로컬 구현 완료이며 M2의 Q04/native 포팅 및 M3 전체 인수를 대신하지 않아요.
