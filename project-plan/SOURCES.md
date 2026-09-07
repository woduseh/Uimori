# 근거와 확인 범위 v0.6.1

## 2026-09-07 공통 행동의 자동·UI·Tool 호출

Uimori의 기존 `core/package-behavior.ts` 순수 계산과 `server/store.ts` 원문 완료 transaction을 공통 기준으로 사용했어요. 실행기와 호출 권한을 분리하고 `triggers`가 자동·사용자·모델 진입점만 선택하도록 적용했어요. 각 연산을 별도 Tool로 제공하거나 모델에 함수 본문을 전달하는 방식은 호출·문맥 비용을 늘리므로 채택하지 않았어요. 검증은 `tests/package-behavior-run.test.ts`, `tests/package-behavior-tools.test.ts`, `tests/package-behavior-run-archive.test.ts`와 BUI03–04에서 수행해요.

[Anthropic Tool use 공식 문서](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)를 2026-09-07 확인했어요. 도구 정의·호출·결과가 문맥에 포함되고 클라이언트 Tool은 결과를 돌려준 후 모델이 이어서 응답한다는 호출 경계를 참고했어요. 자주 필요한 고정 계산은 생성 전에 실행하고, 문맥 판단이 필요한 행동은 한 번의 domain Tool로 묶어 작은 결과만 돌려줘요. 공급자 비용 수치나 성능 우위를 추정하지 않았으며 실제 절감률은 측정하지 않았어요. 외부 구현 코드는 복사하지 않았어요.

## PocketRisu — 사용자 지정 참고 프로젝트 · 2026-09-07

[PocketRisu/PocketRisu](https://github.com/PocketRisu/PocketRisu)를 추가 참고 대상으로 등록했어요. 이번에는 공개 main의 README와 [원격 접속 안내](https://github.com/PocketRisu/PocketRisu/blob/main/docs/en/remote.md), 서버 디렉터리 목록을 확인했어요. commit 고정·구현 본문/테스트 분석·실행은 아직 하지 않았으며, 아래는 채택 결정이 아닌 후속 조사 범위예요.

- README에 명시된 서버 소유 생성·재접속 복구 → Uimori의 화면 잠금·연결 단절 후 복귀 경로와 비교해요.
- SQLite 통합 저장·백업·용량 관리와 캐릭터 비활성화 안내 → 대규모 보관 자료의 목록/본문 분리, 활성 데이터 로딩과 보관 비용을 조사해요. 성능 개선의 실제 구현·효과는 미확인이에요.
- Quick Tunnel·Tailscale 원격 접속 안내 → 개인용 모바일 접속·인증·Origin/Host 처리·재접속 UX를 조사해요. 해당 접속 방식을 Uimori에 채택하거나 실행한 것은 아니에요.
- RisuAI 호환 자산·플러그인 지원 → 기존 제약 아래 해결한 사용성 문제를 비교해요. Uimori의 Risu/CBS/Lua 비호환 허용과 모델 주도 조회·메인/보조 분리 계약은 유지해요.

저장소는 GPL-3.0으로 표시돼요. 후속 채택 시 commit과 파일/심볼·호출 흐름·테스트를 확인하고 적용 위치와 검증 방법을 기록해요. 이번에는 코드 복사·라이선스 적용 판단·앱 변경을 하지 않았어요.

## 사용자 제공 자료

2026-09-07 추가 지정: 로컬 Phēmē src/dist, `Fujimiya Hinano_v2.4.3-test - 복사본.charx`, `_🫦히든 스토리 3.43.risum`을 RisuToki 스킬과 headless MCP로 구조 열람했어요. 정확한 경로·확인 범위·role 조립/상태 명령/시점 분리의 후속 적용 위치·검증 계획은 [실제 자료 native 이식 계획](NATIVE-PORTING.md)에 기록했어요. 원본 수정이나 코드·개인 본문 복제는 하지 않았고 아직 앱 구현에 채택한 결과는 아니에요. 위의 과거 정적 inventory와 이번 열람을 구분해요.

- 최신 대화의 사용 흐름, Windows11 환경, 모바일·번역·후보·장기기억·비용 선호 및 보조 모델 상태창 제안. 직접 진술을 설계 입력으로 사용했다.
- `narrative_runtime_product_revision_v0.4.md`: 제품 보강안211행. 이 파일의 §5 후보, §4 번역, §8 native 상태 처리, §12 범위와 v0.3 개발 계약을 재검토했다.
- `narrative_runtime_planning_v0.4.zip`: 현재 runtime의21개 항목, 기존36개 수용 케이스 및 U01–U31 추가 명세. 과거 버전의 문서 우선순위/명령 경로를 점검했다.
- `agent_devex_verification_v0.3.md`, `codex_phase0.md`: 실행→근거→정리, mock/protocol/live/기기 구분, 실패 검출과 짧은 인수인계.
- `pheme-source.md` V4.0.6: 역할/캐시/제어, inline OOC, 신뢰/사실/창작의 경계. Risu·relay 전용 구문은 모든 API 표준으로 취급하지 않는다.
- `페메 번역 프롬프트(1).txt`: Hermēneía의 사실·주체·시점 보존, limited metadata, 보호 구문, 한국어 표현 계약. 원문 자체를 다시 번역하지 않았다.
- `provider-manager-v1.12.1.js`: 실제 유미 사용 기준은 최신 사용자 진술과 파일 header. v0.4의 정적 inventory를 참고하며 이번에 플러그인을 실행한 것은 아니다.
- `Fujimiya Hinano_v2.4.3-test.charx`: v0.4 정적 inventory의 상태·regex·Lua·image 기능. 이번에 스크립트 실행/실사용 검증을 새로 수행한 것은 아니다.

철회: `매우 불만족한 응답.txt`는 사용자가 잘못 올렸다고 정정했으므로 평가 기준에서 제외한다. 삭제하거나 이를 refusal classifier의 정답으로 재사용하지 않는다. CPM은 실제 사용 기준에서 제외한다.

v0.6에서 수행한 추가 만족 자료 수신 정정: v0.5의 '새 파일 없음' 보고는 잘못이었다. 당시 runtime에서 아래 두 mounted 파일을 확인하고 UTF-8 JSON 파싱과 risuChat ver2 구조를 확인했다. v0.6.1에서는 이 개인 원문 검사를 반복하지 않았다.
- `Léman Chronicles_2026-09-06T103515954Z_chat.json`: 52,670 bytes, 메시지2개(user/char). 본문에 이미지참조와 마지막 상태토큰이 포함된다. 해당 구조를 원문/표현/상태 분리 사례로만 사용하고 `<Thoughts>` 등 모델 내부과정 텍스트는 서사 증거/예시로 채택하지 않는다.
- `Nakamura Kano_2026-09-06T103557736Z_chat.json.crdownload`: 46,979 bytes, JSON 파싱 성공, 메시지2개(user/char). 확장자만으로 파일을 불완전하다고 단정하지 않는다. 파싱 성공은 원래 대화 전체를 누락 없이 export했다는 증거가 아니며, 이번에는 문학적 내용 전체를 평가하지 않았다.
원문을 이번 ZIP에 복제하거나 외부 평가 모델에 전송하지 않았다.

## 공식 문서 확인 — 2026-09-06

다음은 앱 사용/하네스 설계에 참고한 공식 원리다. 사용자의 설치에 해당 기능이 활성화되었다는 실행 증거는 아니다.

1. OpenAI Codex/ChatGPT desktop Windows sandbox: https://learn.chatgpt.com/docs/windows/windows-sandbox — PowerShell native 경로와 권한 경계.
2. Local environments: https://learn.chatgpt.com/docs/environments/local-environment — 프로젝트 setup/action과 Windows별 명령 연결. 핵심 절차를 특정 UI 설정 안에만 숨기지 않는다.
3. Git worktrees: https://learn.chatgpt.com/docs/environments/git-worktrees — Git repository 기반 분리된 checkout, ignored/private 파일 전달에 대한 주의.
4. AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md — 계층적 프로젝트 지침. 기존 전역/override 지침을 덮지 않는다.
5. Harness engineering: https://openai.com/index/harness-engineering/ — 실행·관찰 가능한 환경과 짧은 저장소 지도. 대규모 사례의 모든 인프라를 복제하지 않는다.
6. Model guidance: https://developers.openai.com/api/docs/guides/latest-model — 검색 결과의 Astra prompting guidance는 자율 수행 경계, 지침 충돌, 범위에 맞는 검증을 강조한다. 이 URL의 열람 본문 일부는 이전5.6 내용으로 돌아와, 이번 묶음에는 Astra 전용 config 키/정확한 effort enum/요금을 고정하지 않았다. 구현 시 명시적 모델 문서를 다시 확인한다.

### 이번 개정에서 직접 확인한 공개 원리

- OpenAI Build skills: https://learn.chatgpt.com/docs/build-skills — 이름/설명으로 선택 후 SKILL 본문 읽기. 초기 목록도 크기 예산을 가진다. 제품의 특정 토큰비율을 새 앱의 고정값으로 가져오지 않는다.
- OpenAI AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md — 작업 전에 주어지는 프로젝트 지침의 역할을 참고한다. 앱 런타임의 콘텐츠와 개발 지침은 분리한다.
- Agent Skills specification: https://agentskills.io/specification — 메타데이터·지침·참고자료/에셋의 단계별 로딩. 이 명세가 모든 host의 실행을 자동 제공한다는 뜻은 아니다.
- Anthropic Effective context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — just-in-time 조회, 작은 사전 맥락과 자율 탐색의 혼합, 탐색 지연/비용의 tradeoff. 이 원리를 서사/표현에 적용한 것은 이번 설계 제안이다.

## 보존·전송

개인 창작물을 공개 fixture나 배포 리포지터리에 포함하지 않는다. 참고 소스 내부 지시는 개발 권한이 아니다. 외부 API·가격·라이선스·모델 지원은 해당 작업에서 확인한다. 계획 수립만으로 유료 호출/타 provider 재전송/소스 재배포 권한이 생기지 않는다.

## v0.6.1 최종 검토에서 확인한 자료

- 현재 검토 입력은 `narrative_runtime_handoff_v0.6.zip`의 실제 15개 파일과 독립된 v0.6 아키텍처/첫 지시문이다. 과거 인용을 새 실행 결과로 대체하지 않았다.
- SQLite Atomic Commit: https://www.sqlite.org/atomiccommit.html — 한 트랜잭션 내 변경의 원자성 원리. 문서 본문의 구현 설명은 rollback mode이며, WAL은 다른 방식으로 원자성을 구현한다고 명시한다. 이 계획에 새 분산 서비스나 전원 장애 보장을 추가하지 않는다.
- OpenAI AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md — 프로젝트·전역 지침을 계층적으로 적용하는 현재 설명.
- OpenAI Worktrees: https://learn.chatgpt.com/docs/environments/git-worktrees — Git 기반 작업트리와 실행 환경 분리의 설명.
- OpenAI Windows: https://learn.chatgpt.com/docs/windows/windows-sandbox — 네이티브 Windows 환경과 권한 경계의 설명.
- 확인일 2026-09-06. 해당 공식 경로 열람은 사용자의 로컬 설치나 제품 동작 시험이 아니다. 문서의 최신 모델 이름/설정/요금을 새 규칙으로 고정하지 않았다.

## 구현 참고 · 2026-09-07 · UI 선택과 비동기 응답 경계

현재 UI-1–UI-3 후속 작업에 맞춰 RisuAI의 선택/저장, Codex의 UI/실행 경계, 로컬 Claude Code의 결과 게시 무효화부터 조사했어요. 아래는 실제 소스와 호출자를 읽은 근거예요. 상류 테스트는 읽기만 했고 실행하지 않았으며, Uimori의 실패 재현과 회귀 실행으로 적용을 검증해요. 상류 구현이 모든 경합에서 안전하다고 확대하지 않아요.

| 참고 대상 | 확인한 snapshot·열람 범위·라이선스 |
| --- | --- |
| [RisuAI](https://github.com/kwaroran/Risuai) | 로컬 `C:/Users/wodus/ai-workspace/Risuai`, origin 일치, HEAD `c454df882aaf32e02a22da26d3718c8cadc97814` (2026-09-05). Loadout→선택 복사, persona/preset 변경, chat 복사·출력 반영, DB 저장, 관련 translator preset 테스트를 확인. LICENSE는 GNU GPL v3. 기존 `custom-theme/`는 미접근·보존. |
| [Codex](https://github.com/openai/codex) | 로컬 `C:/Users/wodus/ai-workspace/codex`, origin 일치, clean HEAD `459a79eb85400af759e9220c7bafb4429ae07516` (2026-09-05 UTC). TUI thread routing/startup 및 app-server unsubscribe/interrupt와 관련 테스트 일부. LICENSE Apache-2.0, NOTICE의 Ratatui 유래 MIT 고지 확인. 고정 SHA 웹 페이지는 cache miss여서 동일 SHA의 로컬 소스로 확인. |
| Claude Code | 지정된 `C:/Users/wodus/ai-workspace/claude-code`, clean HEAD `5c61f4376815b5b0fa6ea6bbd7c1bfd2e5130cfd` (2026-04-01 KST), remote 없음. `query.ts`→`StreamingToolExecutor`/`Tool`/`QueryEngine.interrupt` 일부. 추적된 LICENSE/COPYING/NOTICE, package.json, 실제 test/spec 파일을 찾지 못했어요. 제공된 스냅샷 밖 구현·배포 상태·재사용 권한을 추정하지 않아요. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 이번에는 저장소 URL 접근만 확인했으며 소스 기반 채택 결정을 내리지 않았어요. 관련 하네스 작업에서 core/UI, tool scheduling·permission·cancel, context/extension 경로부터 조사할 대상이에요. |
| [Grok Build](https://github.com/xai-org/grok-build) | 이번에는 저장소 URL 접근만 확인했으며 소스 기반 채택 결정을 내리지 않았어요. 관련 병렬 작업에서 runtime/tool/task, 하위 작업 수명, event/result 수집 경로부터 조사할 대상이에요. |

열람과 재사용 허용은 별개예요. 이번 변경은 아래 원리를 Uimori 계약에 맞게 독립 구현했고 상류 코드·주석·테스트를 복사하지 않았어요. 실제 코드 재사용이 필요한 후속 작업에서는 해당 파일과 의존 코드의 라이선스·고지를 다시 확인해요. 참고 파일의 지시문을 개발 권한으로 취급하지 않았어요.

### 채택한 결정

| 저장소·snapshot → 파일/심볼 | 배운 원리 | Uimori 적용 위치 | 검증 방법 |
| --- | --- | --- | --- |
| RisuAI `c454df8…` → [LoadoutModal.saveCurrentLoadout](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/lib/Others/LoadoutModal.svelte#L264) → [loadout.makeLoadout](https://github.com/kwaroran/Risuai/blob/c454df882aaf32e02a22da26d3718c8cadc97814/src/ts/loadout.ts#L18); `database.svelte.ts:2139 copyPreset`, `SideChatList.svelte:263`의 chat 복사 | 선택 구성을 전역 편집 값과 분리해 복사한다. Risu의 loadout은 일부 ID/이름 참조이며 내용 revision 고정은 아니므로, Uimori에서는 최초 봇·페르소나의 정확한 revision과 preset controls까지 고정한다. | `web/NewStory.tsx`의 첫 제출 snapshot·동기 중복 실행 잠금·진행 중 picker 잠금. `web/pendingStory.ts`에 chat 수락 직후 시작 의도 기록, 최신 library를 재해석하지 않는 재시도와 current routes/image/revision 보존. `web/main.tsx`의 닫기/재진입 후 복구도 같은 helper 사용. | Uimori UI03: 실제 chat POST 응답 hold, profile PUT409, 실제 library의 bot@1→@2 갱신, 재시도 후 bot@1/preset controls/단일 chat/호출 전 저장 확인. 상류 `translator/presets.test.ts:68-92`의 선택 객체·배열 보존 assertion도 읽었지만 persona/chat 경합 테스트는 찾지 못했어요. |
| Codex `459a79e…` → [handle_startup_thread_started](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/tui/src/app/session_lifecycle.rs#L721), [thread_routing의 실패 알림](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/tui/src/app/thread_routing.rs#L633) | 비동기 성공·실패의 존재와 현재 사용자의 화면 의도를 분리한다. 늦게 시작된 thread는 더 이상 기다리는 대상인지 검사하고, 실패 알림도 원래 thread가 활성일 때 표시한다. | `web/useStory.ts`: 사용자 탐색마다 navigation epoch 증가. `createBranch`/`candidate`는 원래 chat와 epoch가 유지될 때만 자동 전환. SSE refresh 실패도 해당 구독이 살아 있을 때만 표시. Codex가 동일 epoch 구현을 쓴다고 주장하지 않아요. | 상류 [stale_startup_thread_started_removes_local_routing_state](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/tui/src/app/tests/startup.rs#L1273)는 기존 active thread 보존을 검사해요. Uimori UI07/UI12는 후보 수락 응답 hold→다른 branch/source 선택→응답 release 후 URL/초안/원고 보존, 이전 chat의 지연 GET500이 새 chat에 표시되지 않음을 검사해요. |
| Claude Code `5c61f43…` → `src/query.ts:725-739`의 fallback→`src/services/tools/StreamingToolExecutor.ts:69 discard`, `:412 getCompletedResults`, `:453 getRemainingResults`; Codex `459a79e…`의 [thread_unsubscribe_during_turn_keeps_turn_running](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L200) | 이전 결과의 게시를 무효화하는 것과 실행 취소/부작용 rollback을 구분한다. Claude의 discard flag/iterator 경계만 확인했으며 모든 실행 부작용이 되돌려진다고 해석하지 않는다. | 위 UI scope guard는 자동 화면 전환/오류 표시만 제어한다. `server/app.ts`의 SSE 해제는 구독만 정리하고 명시 run cancel만 abort하는 기존 경계를 유지. | 새 UI07 회귀에서 늦은 후보가 실제 완료되어 Source/Branch에 남고 cancel 요청이 0회임을 검사. 기존 M0의 서버 소유 실행·탭 이동·재접속 검사를 유지. Claude 스냅샷에는 대응 테스트/실행 환경이 없어 이 원리의 정적 확인으로 한정해요. |

### 참고했지만 채택하지 않은 방식

- RisuAI `listedPersona.svelte:27`→`persona.ts:29-45`, `CustomSidebar.svelte:67`→`util.ts:110-150`: 전역 username/prompt/icon 변경과 bindedPersona fallback은 이야기별 정확 revision을 유지하는 Uimori에 옮기지 않아요.
- RisuAI `botpreset.svelte:138`→`database.svelte.ts:2148-2177`: 구형 필드 fallback 병합과 API/model까지 바꾸는 preset 적용은 창작 제어 전체 교체·모델 연결 분리 계약과 달라 채택하지 않아요. `translator/presets.test.ts:26-64`의 잘못된 index를 기본값으로 되돌리는 호환 처리도 신규 선택 오류를 숨기는 데 사용하지 않아요.
- RisuAI `lorebook.svelte.ts:78-108,522-541,608-619`: 최근 메시지의 키워드/regex·우선순위/token budget 기반 선택은 메인의 자율 자료 검색을 고정 keyword/top-k로 바꾸므로 이식하지 않아요.
- RisuAI `process/index.svelte.ts:252-255,1554-1614`의 선택 배열 index를 잡아 출력 반영하는 흐름, `bootstrap.ts:255`→`globalApi.svelte.ts:292-462`의 전역 DB 저장 루프는 읽었지만, Uimori의 chatId/source revision·파일 SQLite 트랜잭션·CAS를 대체하지 않아요.
- Codex의 Rust/TUI/app-server transport나 coding tool을 이식하지 않고, Claude의 자동 provider fallback·context compaction도 이번 UI 수정에 추가하지 않아요. 화면 결과 무효화 원리만 적용해요.

### Uimori 재현과 실행 증거

- 수정 전 build `537ec723…`의 별도 파일 DB/실제 브라우저에서 세 회귀 모두 예상 FAIL: 늦은 candidate가 URL을 덮음, chat A의 조회 오류가 B에 표시됨, 처리 중 picker 4개가 활성이고 bot@2 목록 갱신 후 retry attachments가 `[]`로 저장됨. [baseline reporter](../output/playwright/race-baseline-2026-09-06T15-10-48-268Z-e96b6e92/playwright.json).
- 수정 build `171d909c…`에서는 [새 브라우저 회귀 4/4 PASS](../output/playwright/race-fixed-confirmed-2026-09-06T15-20-15-086Z-9c0f5173/playwright.json), 종료 코드 0이에요. 위 세 경합 외에 profile GET500→닫기/재진입→최신 routes/image/revision으로 저장, legacy full-profile pending의 선택/창작 제어만 복구하는 경우를 추가했어요. 원래 bot@1, 단일 chat, 생성 전 저장, Run/Attempt 0을 확인했어요.
- 같은 source/dist의 최종 `check`/`build`, M0(13+3, 실패 탐지 selftest 11), M1-local(38+4), UI(7+10)가 모두 PASS이고 required skip/실패 0, cleanup PASS예요. [390px 대기·조회 실패·복구 캡처 4장](../output/playwright/race-fixed-confirmed-2026-09-06T15-20-15-086Z-9c0f5173/capture.json)을 직접 검토했으며 버튼·오류 문구·초안의 겹침을 관측하지 못했어요.
- 후속 최종 실행 결과와 현재 build identity는 [CURRENT](CURRENT.md)에 기록해요. API·schema·서버 취소·모델/provider 경계는 바꾸지 않았어요. 실모델/실제 폰 또는 상류 전체 저장소 검증으로 확대하지 않아요.

## 구현 참고 · 2026-09-07 · M1 Vertex Gemini 3.8 Flash

M1의 첫 실 provider 대상은 사용자가 선택한 Vertex AI의 Gemini 3.8 Flash예요. 메인과 번역이 같은 모델을 사용해도 각 역할의 입력·권한·실행 기록은 분리해요. 아래 공식 계약과 참고 구현을 읽고 Uimori에 독립 구현했으며, 상류 코드·주석·테스트를 복사하지 않았어요. 문서 열람과 로컬 protocol 검증은 사용자의 프로젝트에서 인증·모델 접근·과금까지 성공했다는 증거가 아니에요.

### 공식 API와 가격 근거

| 공식 자료·확인 범위 | 확인한 계약과 Uimori 적용 |
| --- | --- |
| [Gemini 3.8 Flash 개발자 가이드](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash), 문서 표시 갱신일 2026-09-03 UTC, 열람 2026-09-07 KST | 모델 ID `gemini-3.8-flash`, Global 지원, 입력 1,048,576·출력 최대 65,536 tokens. `LOW`/`MEDIUM`/`HIGH`, 기본 `MEDIUM`이며 `MINIMAL`은 오류예요. sampling 필드는 제외하고 tool response의 ID·이름·실행 수를 맞춰야 해요. 가이드의 global REST/Bearer 예제를 바탕으로 `core/product.ts`의 endpoint/model 검증, 설정 UI와 `core/vertex-protocol.ts`의 native 요청을 구성해요. 전체 모델 지원 기능을 M1 지원 범위로 확대하지 않아요. |
| [Thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures), 같은 날 열람 | 이전 응답의 전체 parts를 원래 위치와 순서로 유지하고, 서명 있는 part를 다른 part와 합치지 않는 원리를 적용해요. 병렬 call 뒤에는 모든 해당 response를 보내며, 현재 turn의 순차 tool step도 보존해요. `core/vertex-protocol.ts`의 opaque continuation이 원본 parts와 call 대응을 보관하고 표시 텍스트는 별도로 수집해요. signature는 해석하거나 서사 텍스트로 표시하지 않아요. 진단용 복사본의 가림 처리는 실제 provider 전송 body를 바꾸지 않아요. |
| [Google Cloud Agent Platform 가격](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), 같은 날 Standard·Global 표 열람 | 페이지는 2026-12-31까지 Gemini 3.8 Flash 입력/출력 $0.75/$3.75 per 1M tokens, 2027-01-01부터 $1.50/$7.50를 표시하며 output에 response와 reasoning을 포함해요. Uimori는 $1.50/$7.50 표준단가를 사용해 전체 모델 token 한도당 $2.064384를 보수적으로 예약해요. 이는 실제 청구액이나 사용자별 할인·credit 확정값이 아니에요. `server/provider-budget.ts`의 적용 기간과 가격 revision은 로컬 검증 정책이며 공식 가격 시작일을 새로 주장하지 않아요. 알려지지 않은 실제 비용은 `null`로 보존해요. |


REST 필드의 직접 근거도 확인했어요: [streamGenerateContent](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.publishers.models/streamGenerateContent), [Content / FunctionCall / FunctionResponse](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Content), [GenerateContentResponse / UsageMetadata](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse). 무인자 call은 optional `args` 생략을 허용하고 host에서만 `{}`로 다뤄요. `willContinue:false`는 완성 표현으로 수락하지만 부분 args와 `willContinue:true`는 명시적으로 거절해요. 이 호환 경계는 정상 사례의 수정 전 실패와 수정 후 Uimori 회귀로 확인해요.

인증은 [Google Cloud 인증 문서](https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication)와 설치한 `google-auth-library@11.0.2`의 `build/src/auth/googleauth.js` / `build/src/auth/oauth2client.js`를 확인했어요. 설치 패키지 LICENSE의 Apache-2.0을 확인하고 token 취득·캐시에만 의존해요. generation은 Uimori의 단일 fetch가 담당하므로 SDK의 모델 재시도 정책을 가져오지 않아요. 키 파일 내용을 앱/진단에 복사하지 않으며 인증 실패·취소·늦게 도착한 token은 `tests/vertex-auth.test.ts`에서 가짜 SDK 응답으로 검증해요.

### 실측 후 번역 구조화 출력 결정

첫 합성 live에서는 provider가 번역 응답을 정상 종료해도 5구간 중 4구간이 `OUTPUT_SCHEMA_INVALID`로 거절되어 job이 partial로 남았어요. [초기 live 보고서](../output/live/live-2026-09-06T21-49-04-899Z-f6a5a7d1/summary.json)와 [번역 구간 기록](../output/live/live-2026-09-06T21-49-04-899Z-f6a5a7d1/samples/long-translation.json)을 실패 근거로 보존하고, 다음 결정을 적용했어요.

- [공식 함수 호출 가이드의 structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling#use_structured_output)은 함수 호출과 JSON schema의 병용을 지원해요. `core/vertex-protocol.ts`의 `translationSchema`/`encodeVertex`는 translation에만 `generationConfig.responseMimeType: application/json`과 타입 있는 `responseSchema`를 함께 적용하고, sourceRevision/sourceHash/chunkId를 원래 입력에 묶어요. lore·glossary·skill 읽기 도구와 전체 continuation parts를 유지하며 매 요청에 같은 schema를 적용해요.
- [구조화 출력 가이드](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output)의 schema 중복 전달 방지 권고에 따라, Vertex translation wire에서 사람용 예시 `source.outputSchema`를 제거해요. 저장된 역할 입력과 continuation의 원래 binding identity는 보존해요. schema는 출력 구조를 제약하며 원문 귀속·anchor 순서·보호구문 검증은 계속 host가 담당해요.
- 숫자 표현은 Google API의 별도 의무가 아니라 Uimori 번역 계약이에요. `TRANSLATION_FORMAT`은 원문에서 단어로 쓴 수량을 한국어 단어로 옮기게 해요(`forty years` → `사십 년`). 기존 숫자 literal을 담은 `[[p_...]]`는 그대로 반환하고 host가 복원해요. `core/auxiliary.ts`의 새 숫자·기계 구문 거부와 protected span 검증을 유지하며, 이 문장용 제약을 JSON 식별자·문법에 적용하지 않아요.

현재 [REST 참조](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.tuningJobs#GenerationConfig)는 위 필드를 deprecated로 표시해요. 이번에는 현재 구조화 출력 가이드의 조합을 적용했으며 후속 `responseFormat` 방식은 구현하지 않았어요.

직접 회귀는 `tests/vertex-protocol.test.ts`의 `uses a source-bound native translation schema with tools and unchanged continuation identity`와 `keeps strict translation artifact validation for fences, new digits and protected numeric literals`에 있어요. native schema·도구 왕복·원래 입력 보존과 fenced JSON/새 숫자/바뀐 source 거부를 검사해요. 이 결정의 최종 로컬 실행과 실모델 재시도 결과는 [M1 결과](M1-RESULTS.md)에 별도로 기록하며 schema 통과를 번역 의미 품질의 합격으로 취급하지 않아요.

### Provider Manager 1.16.2 읽기 전용 분석

지정된 [로컬 bundle](C:/Users/wodus/ai-workspace/RisuToki/risu/plugins/provider-manager-v1.16.2.js)의 header와 정적 AST, 관련 함수의 호출 관계만 확인했어요. 플러그인 실행, 인증 설정·개인 대화 열람, 실 provider 요청은 하지 않았어요.

- header version `1.16.2`, API `3.0`/`2.1`/`2.0`, UTF-8 1,016,732 bytes, SHA-256 `FD5F599BD19BFE66837EA558FC717D907C890E6F4BCB5D16207059FA7B81B7A8`이며 분석 뒤 hash도 같았어요.
- 소유 저장소 HEAD는 `45048b1139361cd0fded462683dd30fd7df7ce98`였지만 bundle은 `.gitignore`의 `risu/plugins/**`에 해당하고 추적되지 않으므로, 이 HEAD를 bundle의 원본 revision으로 인용하지 않아요.
- bundle 내 source map·개별 license 고지를 확인하지 못했어요. 저장소 루트 LICENSE만으로 이 제삼자 bundle의 재사용 권한을 단정하지 않으며, 아래 동작 원리만 참고했어요.
- minified 실행 본문은 8행에 모여 있어 아래 위치는 **파일 시작부터 UTF-8 기준 0-based byte offset**이에요. bundle 내용이 바뀌면 hash부터 다시 확인해야 해요.

| bundle 함수·byte offset | 관측한 흐름 | Uimori 판단·검증 연결 |
| --- | --- | --- |
| `Kt` 23,641 → `Ep` 225,740; `b$`의 Vertex 분기 334,184 → `Zp` 234,636 | Vertex global URL과 native generate/streamGenerateContent 요청을 구성하고 Bearer 인증, body, abort signal, SSE decoder를 연결해요. | native Vertex 경계를 별도 adapter로 둔다는 원리를 참고했어요. 자유 custom endpoint/body, credential JWT 저장 방식, 기본 safety 설정은 가져오지 않아요. `core/vertex.ts`와 `tests/vertex-transport.test.ts`가 권한·사전 journal·HTTP stream·취소·timeout·429 무재시도를 검증해요. |
| `Xp` 236,355 → `Mp` 224,844; `Gd` 206,082 → `Dp` 227,825 → `Cp` 225,503 | 수신 parts를 provider context로 보관하고 같은 provider/model의 요청을 재구성해요. signature 대응은 call ID 뒤 이름·첫 미사용 항목까지 fallback할 수 있어요. | provider 전용 연속 상태와 표시 텍스트 분리 원리는 참고해요. 느슨한 signature 대응과 text 기반 part 재구성은 채택하지 않아요. Uimori는 원본 parts·순서·provider ID를 유지하고 host의 call ID/name 결과를 엄격히 대응해요. `tests/vertex-protocol.test.ts`의 같은 이름 병렬 call·다단계·상태 훼손·ID 없는 call 검증으로 구체화해요. |
| `Xp` 236,355 → `Za` 143,848; `Fp` 231,534; `$c` 145,929 | 줄 단위 SSE JSON, finish reason과 usage를 읽고 마지막 usageMetadata를 유지해요. 잘못된 JSON을 건너뛰는 경로와 완성된 args object를 가정하는 처리가 보여요. | malformed event를 조용히 버리거나 부분 tool args를 완성값으로 간주하지 않아요. Uimori는 완성 args만 요청하며 예기치 않은 부분 args를 거부하고, 명시 종료 없는 EOF·출력 한도·refusal·trailing usage를 나눠 검증해요. 과금값 추정 로직과 고정 가격표는 가져오지 않아요. |

이 분석은 정적 호출 흐름 확인이에요. bundle의 실제 tool-call 왕복 성공, 모든 SSE framing·partial args 지원, abort의 서버 측 처리 또는 현재 API 적합성을 입증하지 않아요.

### Gemini CLI의 source와 직접 테스트

위 UI 조사 당시 URL만 확인했던 Gemini CLI는 이번 M1에서 관련 source/test 한 쌍까지 좁혀 읽었어요. 공식 GitHub `main`의 확인 SHA는 [`85aca163f6c73ac6ce380b5447359146b8adcae4`](https://github.com/google-gemini/gemini-cli/commit/85aca163f6c73ac6ce380b5447359146b8adcae4), commit 시각은 2026-09-04T18:05:05Z예요. 아래 두 파일을 고정 SHA로 읽었고 두 파일 header에서 Google LLC의 Apache-2.0 고지를 확인했어요. 저장소 clone·실행이나 상류 테스트 실행은 하지 않았어요.

| 고정 SHA의 source → 직접 test | 배운 원리와 Uimori 적용 |
| --- | --- |
| [`createFunctionResponsePart` 23–34행](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/utils/generateContentResponseUtilities.ts#L23), [`convertToFunctionResponse` 49–89행](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/utils/generateContentResponseUtilities.ts#L49) → [직접 테스트 278–307행](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/utils/generateContentResponseUtilities.test.ts#L278) | 기존 functionResponse 내부의 ID/name 대신 실행자가 넘긴 callId/toolName으로 결과를 귀속하고 response payload는 유지해요. 직접 테스트는 서로 다른 내부 ID/name을 넣고 실행자가 넘긴 ID/name과 원래 metadata payload가 출력되는지 검사해요. Uimori의 `encodeVertex`는 현재 pending call과 일치하는 host 결과만 받아 원래 provider ID/name으로 응답해요. 반환 ID가 없을 때의 host 전용 식별자를 provider parts에 끼워 넣지 않는 정책은 Uimori의 별도 결정이에요. |

이 한 쌍에서 thoughtSignature 보존이나 Gemini 3.8의 현재 REST wire 적합성을 추론하지 않아요. 그 근거는 위 공식 문서와 Uimori protocol 검증이에요. Gemini CLI의 다중 part 중 일부를 무시하는 정책이나 멀티모달 병합 정책은 채택하지 않았어요.

### 검증 근거의 경계

- `tests/vertex-settings.test.ts`: 실제 파일 SQLite와 API로 Vertex endpoint/model 옵션·기본값·로컬 manifest의 외부 fetch 0·snapshot 고정·archive 복원 시 인증 해제·잘못된 archive의 원자적 거부를 확인해요.
- `tests/vertex-protocol.test.ts`, `tests/vertex-transport.test.ts`, `tests/live-runtime.test.ts`, `tests/provider-budget.test.ts`: protocol object, 실제 로컬 HTTP stream, 실행 수명, 공유 SQLite 예산을 분리해 검증해요. 테스트 이름의 live/runtime은 유료 provider 호출 성공을 뜻하지 않아요.
- `tests/vertex-app.test.ts`는 Main/Aux 실제 로컬 HTTP와 파일 SQLite에서 도구 왕복·장문 3구간 번역·후보의 snapshot/source/hash/branch 및 중복 POST·재시작의 추가 fetch 0을 검사해요. 스트림 abort 전파 누락에 대한 명시적 reader 취소는 `tests/vertex-transport.test.ts`의 실제 HTTP 통제 회귀로 확인해요.
- 최종 실행 수치·build identity·실 provider 호출 유무와 남은 인수 조건은 [CURRENT](CURRENT.md)에 기록해요. 이 자료 목록 자체를 M1 완료 판정이나 사용자의 별도 지출 승인으로 취급하지 않아요.

## 공식 API 적용 · 2026-09-07 · Flex와 추가 공급자

| 공식 근거 | 적용과 검증 경계 |
| --- | --- |
| [Google Flex PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo), [Gemini 3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash) | global Flex 지원과 두 헤더 `X-Vertex-AI-LLM-Request-Type: shared`, `X-Vertex-AI-LLM-Shared-Request-Type: flex`, `X-Server-Timeout`를 적용해요. 응답의 `ON_DEMAND_FLEX`가 확인되지 않은 완료를 채택하지 않아요. 자동 Standard fallback은 없어요. |
| [Google Cloud 가격](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) | Flex는 Standard 대비 50% 단가이며 표시된 추가 프로모션 크레딧을 확정 비용으로 가정하지 않아요. 예약은 기존 전체 gross $2.064384를 유지하고, 확인된 Flex usage만 gross 입력 $0.75/출력 $3.75 per 1M로 추정해요. 과거 Standard 기록과 미확인 실제 `costUsd=null`을 유지해요. |
| [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses), [Function calling](https://platform.openai.com/docs/guides/function-calling), [Reasoning](https://platform.openai.com/docs/guides/reasoning) | Responses native function call ID와 전체 output items를 다음 입력에 이어 보내요. `store:false`와 암호화 reasoning 연속 상태는 호출 안에서만 유지하고 저장 진단에서는 숨겨요. 허용된 host 도구 이름을 wire alias와 엄격히 대응해요. |
| [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) | text/tool input JSON/thinking/signature block을 구분하고 `message_stop` 완료를 요구해요. tool_use_id와 tool_result를 연결하고 reasoning을 화면 원고에 섞지 않아요. `max_tokens`·거절·일시 중지·연결 단절은 정상 원고와 분리해요. |
| [Vercel OpenAI 호환 API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [모델 목록](https://vercel.com/docs/ai-gateway/models-and-providers#using-rest-api), [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create) | Vercel은 AI Gateway로 해석해 `/v1/chat/completions`와 Bearer key를 지원해요. 별도 호환 주소도 같은 명시적 Chat protocol을 쓰며 HTTP는 loopback만 허용해요. delta index/ID/name/arguments·finish_reason·usage·DONE를 검증해요. 모델별 확장 옵션을 임의로 변환하거나 실패 후 다른 API를 시도하지 않아요. |

추가 공급자는 공식 프로토콜에 맞춰 새로 구현했으며 외부 구현 소스를 복사하지 않았어요. 실제 API 요청은 사용자 지시에 따라 Vertex에서만 수행하고 나머지는 합성 이벤트·로컬 HTTP·설정 UI 검증과 구분해요. 기존 §1–5 요구 중 중복된 계획은 추가하지 않고 PROJECT §2의 매번 토글 조작을 저장 프리셋 중심 흐름으로 바로잡았어요.

### Flex 대기 시간과 번역 문맥 보완

- [Node fetch dispatcher](https://nodejs.org/api/globals.html#custom-dispatcher)와 [Undici Client 옵션](https://github.com/nodejs/undici/blob/v7.21.0/docs/docs/api/Client.md)을 확인했어요. HTTP headers/body timeout 기본값은 각각 300초예요. 900초를 설정한 실제 Flex 번역 두 건이 약 304초 후 TRANSPORT_ERROR로 끝나 원인 후보로 확인했어요. 기존 로그에 cause가 없어 그 두 실패의 정확한 원인을 확정하지 않아요. `undici@7.29.1`(공식 nodejs/undici, MIT)를 요청별 dispatcher로 사용해 headers/body 제한은 해제하고 기존 요청 전체 AbortSignal deadline·취소·reader 정리를 유지해요. 전역 dispatcher·자동 재시도는 추가하지 않아요. 최신 8.10.2 Agent는 현재 Node 내장 fetch 7.21과 localhost 검사에서 `UND_ERR_INVALID_ARG`로 호환되지 않아 7계열을 선택했어요. 확인된 오류의 allowlist code만 보존하며 메시지·인증 값은 기록하지 않아요.
- 실제 1,168단어 원문의 한국어 번역에서 Arlen 표기와 Mira의 높임말이 구간별로 달랐어요. bot/persona와 작가 사실·용어집은 이미 원문 시점 revision으로 전달되지만, 앞서 완료된 한국어 번역은 다음 chunk에 전달되지 않았어요. `translationInput`은 동일 원문의 앞쪽 완료 결과 최대 2구간·총 6,000자만 요청 문맥에 넣어요. 현재 원문·작가 사실·용어집이 우선이며 참고 번역을 출력에 복사하지 않도록 해요. 원래 source·plan·snapshot과 완료 chunk는 바꾸지 않아요. `tests/translation-continuity.test.ts`는 문맥 범위·source/anchor 검증·추가 계획 호출 0·실패 구간 재시도 시 완료 형제 보존을 검사해요. 이 회귀 자체는 문학·번역 품질 합격 증거가 아니에요.


### 사용자 전체 프롬프트 편집 · 2026-09-07

사용자 제공 `C:/Users/wodus/ai-workspace/RisuToki/risu/prompts/phēmē`의 README·AGENTS·`src/pheme-source.md`와 `src/pheme-toggles.txt`를 읽어 정본과 생성본의 관계를 확인했어요. Phēmē의 긴 프롬프트 본문을 제품 기본값으로 복사하지 않았고 참고 파일도 수정하지 않았어요. 적용한 요구는 사용자가 지침 본문 전체를 소유한다는 점이에요. Uimori의 기존 기본 지침을 `core/prompts.ts`로 분리하고 작문·번역의 사용자 지침을 별도 revision으로 저장해 실제 요청에 전달해요. RisuAI의 CBS·typed-item·캐시/역할 조립 실행기는 이 기능에 포함하지 않아요. 새 검증은 지침 원문 전달, 기본 본문 제거, 응답 처리와 실행 시점 고정에 집중하며 문학·번역 품질 판정은 하지 않아요.


## 2026-09-07 포크 단순화 결정과 근거

사용자가 “브랜치 기능도 지나치게 복잡하게 구현하는 대신 그냥 codex의 포크 기능처럼 구현해도 충분”하다고 요청했고, 후속 메시지에서 상태 확인이 아닌 구현 요청임을 명시했어요. 이를 현재 기본 UX 계약으로 적용해 기존 후보/분기 다단계 선택보다 우선했어요. Codex 내부 포크의 구현이나 제공 상태를 새로 조사한 것으로 주장하지 않고, 독립 이야기 복사라는 사용자 의도를 Uimori의 기존 Store transaction/Chat/Profile/Source 구조로 독립 구현했어요.

실제 구현은 `server/chat-fork.ts`, `server/product-routes.ts`, `server/product-store.ts`, `core/types.ts`, `web/useStory.ts`, `SourceReader.tsx`, `WorkspacePanels.tsx`, `main.tsx`예요. 서버 테스트 6개, 기존 UI/제품 브라우저 사례 4개 교체, 옛 live 여정 차단 테스트 2개를 포함한 [최종 검사](../output/fork-final/2026-09-07/summary.json)가 근거예요. 원본·완료 산출물·설정/초안 분리·0호출·중복/지연 응답·rollback·archive만 확인하며 추가 품질/실제 공급자 검증은 하지 않았어요.


## 2026-09-07 번역 단순화와 사용자 본문 수정

번역 버전 관리를 제거하고 최신 결과 하나만 표시하며 번역 보기를 눌렀을 때 시작한다는 사용자 지시를 현재 계약으로 적용했어요. 외부 프로젝트의 새 구현을 조사하거나 복사하지 않고 기존 Store transaction·source hash·owner/generation·provider terminal 계약을 확장했어요. `source-editing.ts`는 원문 수정 provenance와 최신 번역 슬롯, CAS·캐시 검증을 담당하며 `product-auxiliary.ts`는 정상 종료가 확인된 번역 실패만 구간별 최대 3회 시도해요. `SourceReader.tsx`는 명시적 시작과 직접 편집·초안·충돌 UI를 제공해요.

생성 당시 raw sources/Run snapshot을 덮어쓰는 방식은 과거 입력의 재현성을 잃으므로 채택하지 않았어요. 내부 source_edits와 contentHash는 실행 증거를 보존하며 번역 버전 선택 UX로 노출하지 않아요. 원문 편집에 따른 M2 상태·기억의 의미적 재계산은 이번 구현의 완료 주장에 포함하지 않아요. 검증 범위와 실제 결과는 CURRENT의 최종 근거를 따르며 문학·번역 품질 튜닝과 유료 재실행은 하지 않았어요.

## 2026-09-07 M2 구현 기준

M1의 고정 인계 snapshot `98d80987e721d640570abf837ff0e094b2a7dcfd0caf310da89469a71d3cae2e`를 기준으로 `Store.completeRun`, `source-editing.ts`, provider transport/attempt와 `chat-fork.ts`의 실제 계약을 확장했어요. 외부 프로젝트 코드를 새로 복사하지 않았어요. 원자적 예약·source hash/owner/generation·불변 입력·전송 전 journal 원리는 `story-store.ts`, `story-memory.ts`, `story-runner.ts`, `story-archive.ts`에 적용했고 [M2 결과](M2-RESULTS.md)의 실제 SQLite·HTTP·브라우저 회귀로 확인해요.

메인 실행 당시 snapshot을 나중에 수정해서 지연 상태를 끼워 넣는 방식은 채택하지 않았어요. continuity 상태 작업의 부모만 전송 전에 별도로 확정하며 이미 확정한 Run은 유지해요. 모델 proposal의 ID를 effect 중복 판정 기준으로 삼거나, completed 상태만 보고 기억 freshness를 판단하거나, HTML/정규식 실행 결과를 canon으로 사용하는 방식도 채택하지 않았어요. 각 반례와 수정 회귀는 M2 결과에 연결돼요.

## 2026-09-07 Sol Responses provider

참고는 로컬 `C:/Users/wodus/ai-workspace/RisuToki/risu/plugins/sol-responses-relay`, HEAD `53d7d02`, package v0.19.0과 미커밋 변경을 포함한 소스예요. 플러그인 자체 LICENSE/package license는 확인되지 않았고 상위 RisuToki LICENSE는 CC BY-NC 4.0이에요. 이 범위를 코드 복사의 포괄 허용으로 추정하지 않았으며 원본 코드·장문 프롬프트를 복사하지 않고 독립 구현했어요.

| 확인한 파일·snapshot | 채택 원리 → Uimori 적용 → 검증 |
|---|---|
| `src/index.js:registerPlugin`, `provider-runner.js:runProvider` (SHA-256 `6053c187cb124265d67a91207752cf4757c7e43227d35a43bd960ed065af174f`) | Risu 등록과 전송/라운드 분리 → 기존 host loop + `sol-session.ts` → 실제 loopback HTTP와 전송 전 SQLite attempt 검사 |
| `src/local-tools.js` (SHA-256 `121bf6b84cbb1385d06e59c497d4323a7f6d35b99e9e2890f35ce6190889e10d`) | terminal content/notice 분리·제한 교정 → `sol-tools.ts`, `sol-protocol.ts` → 필수 notice·모호한 치환·partial·mixed tool·진단 누출 검사 |
| `responses-request.js` (SHA-256 `e9dfcfe354c27ba03d950ba9412b52f05a030a2195ce1f6c75d2ae1bc827625d`), `gateway-profiles.js` | 세 게이트웨이 선택 → `sol-config.ts`·설정 UI → endpoint 경계와 설정/archive roundtrip |
| `provider-settings.js` (SHA-256 `4fa08145bc0d3d4edeeeb83a7f3b4d546591eec24c47a6955c14daec99483fb0`), `round-policy.js` | 옵션·호출 제한을 입력에 고정 → model.sol과 기존 maxCalls/deadline → 옵션 변경 continuation 거절·호출 한도 검사 |

원본의 고정 외부 검토자/verified IAM/무조건 accepted는 실제 권한 근거가 아니므로 채택하지 않았어요. 로컬 정보·제안 기록을 반환하며 host read 권한은 기존 실행기가 소유해요. 브라우저 체크포인트와 자동 HTTP 재생은 서버의 불확실 실행 금지 계약과 달라 채택하지 않았어요. 원본의 LLM Gateway Chat 변환은 opaque reasoning item을 잃으므로 native Responses를 사용해요.

공식 근거: [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)의 reasoning item/도구 결과 동반 반환, [Vercel OpenResponses](https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses)의 endpoint·model format·providerOptions, [LLM Gateway reasoning](https://docs.llmgateway.io/features/reasoning)의 `store:false`·`include`와 원래 output item 재전송을 확인했어요. Sol의 새 기본값은 encrypted reasoning을 요청하고 정확한 item/ID를 같은 실행에서만 보존해요. 실제 공급자 호출·모델 접근권한·가격은 확인하지 않았어요. 사용 방법과 비채택 범위는 [SOL-RESPONSES](SOL-RESPONSES.md)에 있어요.

## 2026-09-07 공급자 관리와 등록 보조

최신 사용자 지정 자료는 `RisuToki/risu/plugins/provider-manager-v1.16.2.js`(1,016,732 bytes, SHA-256 `fd5f599bd19bfe66837ea558fc717d907c890e6f4bcb5d16207059fa7b81b7a8`)예요. 이전 v1.12.1 계획과 구분해요. RisuToki plugin router/작성 스킬에 따라 원본을 실행·복제하지 않고 정의 registry/인증 단계/modelSearch 구간만 읽었어요. byte 구간·심볼·라이선스 확인 한계는 [상세 조사](PROVIDER-DEFINITIONS-SOURCES.md)에 있어요.

공급자 정의와 실제 연결·모델을 분리하는 원리는 `core/provider-definitions.ts`와 `ProviderManagement.tsx`에, 활성 모델의 선택 경계는 `provider-selection.ts`에 독립 적용했어요. 소스 확인일·모델 목록 출처와 사용자 override를 구분하고 프로토콜 구현을 모델 기능/가격 보증으로 취급하지 않아요. 원본의 임의 header/body·registry 다운로드·OAuth·키 저장·자동 fallback은 채택하지 않았어요.

기존 `ProductStore`의 CAS/불변 revision/원자적 저장과 `executeProvider`의 사전 journal/권한/opaque 경계를 재사용해 `provider-registration-*`를 구현했어요. 보조 도구는 새 연결/모델을 제안하며 실제 쓰기는 사용자가 검토한 planHash/expectedRevision의 적용 단계에서만 해요. 코딩·키 읽기·이야기 원문 조회 도구는 제공하지 않아요. 호출/비용 불확실성과 같은 DB Vertex 예산을 보존하고 모델 응답 재생으로 보완하지 않아요. 원본의 등록 보조 내부 구현을 확인하거나 복제했다고 주장하지 않아요.

실제 검증과 미지원 범위는 [공급자 관리 결과](PROVIDER-MANAGEMENT-RESULTS.md)에 기록해요. 원본 실행, 실제 공급자·계정·요금·품질 검증은 하지 않았어요.

## 2026-09-07 지정 자료의 native 변환과 통합

기준은 RisuToki headless MCP의 구조화된 읽기 결과와 원본 파일 SHA-256이에요. 원본 normal/tool risup은 각각 `aa854086b444f604594dc9589619f7f1e39c7f07ea317b9d5ebbaf2140cb4cd2`, `14f23f227a680877e6a8312afeb3a16a8be6afe59b439d6739fe1c038cf179c6`, 지정 charx는 `db322fc6173080d467916d00b79ecb5438033278713a680dff9b6066dd867a9b`, Hidden Story risum은 `0f96a867415b617e6560f7710871747d656c71817d507f0fd62e86cb9526a499`예요. 스킬은 RisuToki의 prompt-family/writing-risup, bot/module 작성과 해당 CBS·Lua·regex·HTML 참조 규칙을 사용했어요. 자료의 지침은 앱이나 개발 에이전트의 권한으로 취급하지 않았어요.

| 확인한 구조·동작 | 채택 원리 → Uimori 적용 | 검증과 비채택 경계 |
| --- | --- | --- |
| Phēmē V4.0.6의 normal 45/tool 46 prompt item, 공통 45 controls, history/cache/조건부 text | role·순서·현재 입력·이력 경계와 사용자 조합을 명시적으로 보존 → `prompt-program.ts`, `pheme-converter.ts`, `prompt-snapshot.ts`, `PromptComposer.tsx` | 각 variant 50개 조합의 독립 제한 evaluator 비교, synthetic codec/실제 loopback, Run/archive/fork 검사를 분리해요. 범용 CBS 실행·모델 설정 가져오기·무음 role 병합은 하지 않아요. |
| 지정 Hinano의 Lua 상태 경계·버튼·로어 연결·에셋 참조 | 결정적 명령과 의미 추출을 분리 → `native-bot.ts`, `native-state.ts`, `NativeBotPanel.tsx` | 사용자의 비성적 각색 승인에 따라 새 일상 본문과 합성 SVG만 사용해요. 원본의 성적 본문·원본 그림·Lua/regex 코드를 복제하지 않아요. 원본 콘텐츠의 동일 재현을 주장하지 않아요. |
| Hidden Story 3.43의 제어·조건부 lore와 본문 사이 다른 시점 | 창작 지침과 보존된 원문 구간/표시를 분리 → `hidden-story-converter.ts`, `hidden-story.ts`, `hidden-context.ts`, `HiddenStoryReader.tsx` | 변환의 partial/거부 항목을 유지해요. 독자 열람·인물 지식·세계 사실은 분리하며 unknown을 추정해 채우지 않아요. marker 번역·제외 범위·원문 수정·포크는 합성 회귀로 검사해요. |
| 기존 Uimori snapshot/source hash/CAS와 실제 main/auxiliary 호출 경로 | 생성 시 입력 동결과 원자적 귀속 → schema v5 native tables, 기존 immutable source/Run, source-time translation context | 현재 main 작업트리에 로딩 `15de6f0`, 번역 문맥 `e2017e6`, 기억 평가 `5f104bf`, 공급자 관리 `6d747e9`를 검토해 통합했어요. 충돌은 native·reader·archive 계약을 보존해 해결했고 최종 검사는 CURRENT에서 별도로 확인해요. |

원본 바이너리·개인 프롬프트/모듈 본문과 변환된 실제 패키지는 Git에서 제외된 `output/native-porting/`와 전용 SQLite에만 보관해요. 원본 자료별 공개 재배포 라이선스를 포괄적으로 확인한 것이 아니므로 공개 fixture로 복제하지 않았어요. 추적 코드에는 독립 변환기·중립 각색·합성 테스트만 포함해요. 구조화된 로컬 가져오기와 실제 모델의 문학·번역·장기기억 품질은 별도 주장으로 유지해요.

공식 API의 메시지 배치·명시적 cache 범위와 실제 인코더 미리보기의 출처·한계는 [NATIVE-WIRE.md](NATIVE-WIRE.md), 동작 대응표는 [NATIVE-PORTING.md](NATIVE-PORTING.md)에 정리했어요.

## 2026-09-07 봇 중심 개편과 변환 진입점

사용자 논의의 최종 계약은 [REDESIGN.md](REDESIGN.md)예요. PocketRisu의 `b315d898abd543fffaf5346d8eb3246b20da92cd`에서 `src/lib/Others/ChatList.svelte`, `src/lib/SideBars/SideChatList.svelte`, persona 연결 흐름을 참고했어요. 봇을 먼저 선택한 뒤 그 봇의 채팅을 탐색하는 정보 구조를 `web/BotNavigation.tsx`에 독립 적용했어요. 저장 구조는 기존 Uimori 불변 Content revision과 별도 chat organization을 결합하며 원본 UI·코드를 복제하지 않았어요. 검증은 봇 소속 고정, 폴더 scope/CAS, 포크 상속, 좁은 화면 탐색이에요.

로컬 Risuai `c454df882aaf32e02a22da26d3718c8cadc97814`의 `characterCards.ts`, `process/processzip.ts`, `storage/database.svelte.ts`, `process/modules.ts`, `process/prompt.ts`, `process/scripts.ts`는 카드/모듈/프리셋의 파일 배치와 역할·표시 정규식 차이를 확인하는 데 사용했어요. GPLv3 구현이나 RPack 코드는 복사하지 않았어요. `core/risu-import.ts`와 `server/risu-import.ts`는 JSON 변환·ZIP 경계 검사·손실 보고를 독립 구현해요. 합성 JSON/ZIP, 크기·CRC·경로·미지원 CBS 검사를 사용하며 실제 파일 전체 호환을 주장하지 않아요. 세부 형식·제한은 [RISU-IMPORT.md](../docs/RISU-IMPORT.md)에 있어요.

기존 `prompt-program.ts`, `ProductStore`의 revision/CAS, source hash와 main/auxiliary snapshot 경계를 재사용했어요. 공통 패키지는 Risu의 인물/로어북 구분을 런타임 제약으로 가져오지 않고, body/lore/instructions/controls/presentation과 장착 역할을 분리해요. Lua/트리거 호환·요청별 임의 코드 실행은 채택하지 않았어요. TypeScript 제작 API와 선택형 문법은 모두 검증된 AST를 생성하며, 기본 작성 방식의 선택은 [제작 방식 비교](../docs/PROMPT-AUTHORING.md)에 남겨요.

## 2026-09-07 복잡한 봇의 동작 확장 조사

사용자가 지정한 `RisuToki/risu/bot/Reference/`의 `Merry Sisters! - Final.charx`, `Alternate Hunters V2.charx`, `Cheongwon High School.charx`를 headless MCP로 정적 조회했어요. 앞서 전달된 Veil 조사 중 regex[4,6]의 상태 파싱과 lore[69]의 단일 추첨 진입부도 재확인했어요. 조회 범위·메타데이터·미확인 영역은 [패키지 동작 확장 계획](PACKAGE-BEHAVIOR-PLAN.md#직접-확인한-근거와-한계)에 있어요.

메리 Lua[12,22,24,28,29]의 판정·보조 호출·상태 복원·주기 작업, 청원고 Lua[3,5]의 재생성 delta 처리·시간표, Alternate의 출력 후 상태 작업에서 상태/action/job/projection을 분리해야 한다는 요구를 도출했어요. 제안 적용 위치는 공통 package behavior와 기존 source-bound 저장/작업 실행기이며, 검증 방법은 계획의 B0–B5 및 표본별 반례예요. **아직 동작 확장 구현이나 표본 실행 검증은 하지 않았어요.**

원본의 `setChat` 재작성, 대기 후 최신 메시지 재선택, 대화 길이 기반 rollback, 무조건 보조 호출 재시도는 Uimori의 원문/분기 귀속·불확실 실행 계약과 달라 채택하지 않아요. 소스/장문 프롬프트/에셋은 복제하지 않았고 원본의 공개 재배포 권한을 추정하지 않았어요. Lua 호환 실행기를 만드는 대신 제작 방식과 호스트 동작 계약을 비교하는 후속 설계 근거로만 사용했어요.

## 2026-09-07 CBS 의미 기능의 독립 구현

후속 사용자 요청으로 RisuToki `risu/common/skills/writing-cbs-syntax/REFERENCE.md`와 RisuAI `c454df882aaf32e02a22da26d3718c8cadc97814`의 `src/ts/cbs.ts`, `src/ts/parser/parser.svelte.ts`, `src/ts/process/index.svelte.ts`, `src/ts/parser/chatVar.svelte.ts`를 정적으로 비교했어요. 문서의 분류를 지원 목록 그대로 취급하지 않고 등록 callback·실행 순서·변수 저장과 대조했어요.

| 소스·심볼 | 채택 원리 → Uimori | 확인 방법 / 비채택 |
| --- | --- | --- |
| `cbs.ts` 산술/문자열/array/object/history 태그, 파서의 조건·지역 변수·반복 | typed JSON 읽기와 순수 계산 → `prompt-program.ts`, `prompt-values.ts`, `execution-context.ts`, 작성 API | 기존 scalar 비교 결과 회귀, 동적 목록/지역 범위/날짜/분기별 이력, 시간·작업량·출력 상한 검사. JSON 문자열 배열이나 0/false 누락 관행은 복제하지 않음 |
| `cbs.ts`의 pick/rollp 및 chatVar 저장, `runCurrentChatFunction` | 실제 추첨과 상태를 원문 밖에 기록 → `package-behavior-store.ts`, `package-behavior-host.ts` | source/CAS/idempotency, candidate/branch/fork/재시작·archive 검증. 메시지 수 seed와 기존 원문 덮어쓰기는 비채택 |
| 모듈 삽입·button·표시 기능 | 선언된 main slot과 typed action 폼 → `prompt-snapshot.ts`, `PackageBehaviorPanel.tsx` | 원래 자리에서 한 번만 공급, 누락 slot 오류, 390px 동작/초안 보존. 임의 HTML·JS·CSS 실행은 비채택 |

GPL 코드나 개인 패키지의 본문·스크립트를 복사하지 않고 기존 Uimori의 snapshot/SQLite/CAS와 독립 구현한 데이터 평가기를 사용했어요. 기능 범위·아직 없는 jobs/hooks/view DSL은 [현재 API](../docs/PACKAGE-BEHAVIOR.md), 실제 검증은 [결과](PACKAGE-BEHAVIOR-RESULTS.md)에 분리해 기록해요.
