# Codex 에이전트 연결 결과 · 2026-09-07

사용자 요청에 따라 개인 ChatGPT 구독의 공식 Codex App Server를 본문·번역·장면 상태 표시·이미지 작업 지시·상태·기억 및 모델 등록 에이전트에 연결했어요. ‘자연어 모델 등록’ UI 이름은 **에이전트에게 모델 등록 요청하기**로 바꿨어요. 설정의 **에이전트** 항목에서 별도 서버 로그인, 사용률 확인, 로그인 취소와 연결 해제를 제공해요. 역할별 모델 선택·원문 귀속·저장 검증은 기존 하네스를 사용해요.

## 구현

- `core/codex-protocol.ts`: 고정 주소와 출력 envelope, 허용 도구·호출 ID·JSON 검증, 논리 메시지 보존, 미지원 prefill/필수 cache 거부.
- `server/codex-process.ts`, `server/codex-runtime.ts`: 공식 CLI stdio JSON-RPC, 전용 home·환경변수 격리·환경 접근 차단, ephemeral 실행, attempt 선기록, 전송 직전 연결 재검사, 취소·시간 제한·종료 경합 처리.
- `server/agent-runtime-routes.ts`와 기존 app/runner 연결: 앱 인증·Origin·no-store·안전한 오류, 모든 역할과 등록 작업의 공통 Codex 콜백.
- `server/provider-budget.ts`: Codex RPC의 고정 endpoint·role/model 식별을 확인하고 `not-estimated`로 기록해요. Vertex 예산을 요구하거나 가격을 0원으로 추정하지 않아요.
- UI: 공식 로그인 URL만 열기, 설정 탭 이동 중 초안 보존, 연결·모델 저장, 출력 목표 토큰과 고정 구조화 출력 안내.
- 기본 비활성, 선택적 Docker CLI 설치, Git/Docker의 전용 로그인 폴더 제외. [사용·서버 설정](../docs/CODEX.md), [공식 근거](SOURCES.md#codex-app-server-채택-2026-09-07).

## 확인한 결과

| 검사 | 결과·증거 |
| --- | --- |
| 타입 검사 `npm run check` | PASS |
| Codex codec/process/runtime/integration 및 기존 provider-budget 회귀 | **74/74 PASS**, [JSON reporter](../output/codex-tests.json) |
| 설치된 공식 CLI 0.153.0, 새 빈 home의 initialize/account 확인 | **1/1 PASS**, 로그인·모델 호출 0, [preflight](../output/codex-preflight/summary.json) |
| `npm run build` | PASS, Vite 500kB chunk 권고 경고만 남음 |
| `npm run verify:providers` | **10/10 PASS**, [summary](../output/playwright/provider-management-2026-09-07T11-53-00-662Z-68cf50ea/summary.json), PMUI10 모의 인증·취소·연결 해제·Codex 연결/모델 저장 포함 |
| 390px Codex 설정 화면 | 줄바꿈·버튼·메뉴·하단 안내를 직접 확인, [화면](../output/playwright/provider-management-2026-09-07T11-53-00-662Z-68cf50ea/browser/provider-management-browse-72a0c-nd-model-without-generation/codex-subscription-settings-mobile.png) |

브라우저 검사의 source/build는 `141c60768042769baa0845996de3392b85f3699d679b2e53f97c5c9874bab8d7`이며 종료 시 지문 일치와 cleanup PASS를 확인했어요. 단위 reporter는 해당 명령 실행 시점의 결과예요. 병행 중인 다른 작업 전체에 대한 인수 완료를 대신하지 않아요.

실제 CLI 사전 검사에서 처음에는 내장 `openai` provider의 retry override 때문에 시작이 거부됐어요. 해당 설정을 제거한 뒤 공식 initialize를 통과했으며 CLI 내부 retry 횟수는 통제하지 못한다는 한계를 반영했어요. 앱 통합 검사는 처음 Codex를 Vertex 예산 분기로 잘못 분류해 실패했고, 엄격한 RPC 분기를 추가한 뒤 6개 역할·등록·archive와 예산 변조 회귀를 통과했어요.

## 남은 실제 사용 확인

실계정 로그인·구독 모델 생성·응답 품질·내부 호출 횟수·사용량과 Linux Docker 빌드/기동, 실제 휴대폰은 검증하지 않았어요. 브라우저 인증은 mock이며 실제 설치 CLI 검사는 모델 요청 없는 연결 확인이에요. Codex의 자체 지침·내부 재시도는 유지되고 `maxOutputTokens`는 강제 상한이 아니에요. 상세한 계약 한계는 [Codex 안내](../docs/CODEX.md#실행-계약과-한계)를 따라요.
