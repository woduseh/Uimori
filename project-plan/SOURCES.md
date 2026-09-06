# 근거와 확인 범위 v0.6.1

## 사용자 제공 자료

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
