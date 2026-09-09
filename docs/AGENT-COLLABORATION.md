# 메인 작문과 커스텀 에이전트 협업

작문 프롬프트 편집기의 **에이전트 협업**에서 인물·설정과 기억·직접 만들기 템플릿을 추가해요. 이름, 메인이 참고할 역할 설명, 지침, 모델, 참여 시점, 추가 조회 도구와 호출 한도를 편집할 수 있어요. 템플릿은 편집 가능한 시작점이며 특정 프롬프트나 작품을 전제로 하지 않아요.

기본은 꺼짐이에요. 협업을 끄면 저장한 정의는 보관하고 기존 메인 요청 경로를 사용해요. 작문 프리셋을 적용하면 협업 구성도 현재 작문 작업본으로 복사해요. 프리셋의 후속 수정·삭제는 작업본을 바꾸지 않아요. 정의는 작문 프로그램에 속하며 함께 저장·복제·JSON 내보내기를 해요. 독립된 에이전트 등록부는 만들지 않아요.

## 참여 방식과 문맥

- **작성 전**: 등록한 순서대로 한 번 의견을 받고 메인에 전달해요.
- **메인이 필요할 때**: 메인이 `agents.consult({agentId, question})`로 질문해요. 같은 에이전트에 다시 요청하면 처음 질문의 결과를 반환하며 새 모델 호출을 하지 않아요.
- **함께 따를 지침**과 선택한 **프롬프트 옵션의 현재 값**을 메인과 보조가 함께 받아요. 메인 프롬프트 전체를 자동으로 복사하거나 특정 옵션 ID를 추정하지 않아요.
- 보조는 예약된 Run의 사용자 요청, 작문용 원문 projection, 고정 자료, 상태·메모·요약 문맥을 받아요. 추가 조회는 선택한 `knowledge`, `skills`, `notes`, `story` 도구와 기존 메인 조회 권한의 교집합이에요. 체크박스는 기본 문맥을 제거하는 필터가 아니라 추가 조회 도구 선택이에요.

보조 결과는 근거와 가설을 구분하는 참고 의견이에요. 메인이 최종 창작 결정을 맡아요. 자동 후처리나 원문 재작성은 없으며 보조는 원문·정사·상태를 저장하거나 추첨을 실행하지 않아요. 다른 보조를 부르거나 `story.submit`, 패키지 상태 도구, 평가 도구를 호출할 수 없어요. 모델 프리셋의 `evaluationTools` 설정도 보조의 읽기 권한을 늘리지 않아요.

## 호출과 저장 계약

`PromptProgram.collaboration`은 아래 데이터를 보관해요. `validatePromptProgram`과 `validateAgentCollaboration`이 알 수 없는 필드·ID 중복·공유 옵션 참조·수치 한도를 검사해요. `definePrompt` 제작 API도 같은 필드를 받아요.

```ts
type AgentCollaboration = {
  enabled: boolean;
  sharedInstructions: string;
  sharedControls: string[];
  maxCalls: number; // 모든 보조가 나눠 쓰는 1~12회
  agents: {
    id: string;
    title: string;
    description: string;
    instructions: string;
    model: { id: string } | null; // null이면 메인 모델 상속
    trigger: 'before' | 'on-demand';
    tools: ('knowledge' | 'skills' | 'notes' | 'story')[];
    maxCalls: number; // 한 에이전트의 전체 조회 왕복 포함 1~6회
    maxOutputChars: number; // 메인에 전달할 최대 길이 500~20,000
  }[]; // 최대 6명
};
```

API는 기존 `POST/PUT /api/prompt-presets`의 `program`을 사용하며 수정은 `expectedRevision` CAS로 보호해요. 잘못된 편집 초안은 화면에서 보존하지만 저장·미리보기·JSON import 전에 검증해요. 별도 협업 편집 후 오래된 본문 undo가 협업 설정을 지우지 않아요.

현재 프롬프트와 모델을 Run 예약 시 고정해요. `ProfileSnapshot.collaborationModels`에 에이전트 ID별 모델·연결·파라미터를 보관하므로 진행 중 설정 수정은 다음 Run부터 적용돼요. 매 호출에 최신 연결 권한을 다시 검사하고 전송 전에 attempt를 기록해요. 기존 `role: main` 전송을 사용하되 attempt의 host 전용 `agentId`로 보조 호출을 구분해요. 이 ID는 공급자에게 보내거나 모델 출력에서 받지 않아요.

모든 보조 호출은 요약·메인과 같은 `settings.maxCalls`에 포함돼요. 보조 전체 한도와 각 에이전트 한도도 동시에 적용하며 메인의 다음 호출 1회분을 남겨요. 기본 전체 추가 호출 한도는 3회, 템플릿별 한도는 2회예요. 최종 작문이 더 많은 도구 왕복을 요구하면 기존 전체 한도에서 끝날 수 있어요. 켜진 협업은 호출 여부와 별개로 도구 설명·공유 지침만큼 메인 입력이 늘어나요.

모델별 출력 토큰·입력 한도와 timeout을 사용해요. 보조의 timeout은 한 상담의 여러 호출이 나눠 써요. `maxOutputChars`는 응답을 받은 뒤 메인에 전달하는 UTF-16 길이 상한이며, 공급자의 생성 토큰 한도를 대신하지 않아요. 잘린 의견은 `truncated`로 표시해요.

보조 실패·거절·부분 응답·불확실 연결 종료는 사용 불가 결과로 전달하고 자동 재호출하지 않아요. 이미 소비한 호출과 usage는 유지하며 실제 비용 미제공 값 `null`을 0으로 바꾸지 않아요. 취소하면 보조와 메인을 함께 멈추고 늦은 결과를 원문으로 저장하지 않아요. 서버 재시작·보관 복원도 불확실 실행을 자동 재생하지 않아요.

## 진단과 보관

Run의 `agents.consult` tool event에 의견·상태·호출량·질문·출처를 남겨요. `agents.read`에는 실제 읽기 결과를 남기고, 모델 입력은 `agentId`로 구분해요. 원문에는 메인의 최종 응답만 저장해요. 보조가 읽은 본문을 다음 Run의 유지 로어로 자동 승격하지 않아요.

협업 설정은 현재 schema/archive v15의 JSON 필드에 보관해요. 협업 전용 DB 테이블이나 구형 DB 이관은 없어요. 복원은 에이전트 모델 귀속을 검사하고 메인·보조 snapshot의 인증 참조를 제거하며 연결을 비활성화해요. 현재 프롬프트나 진행 중 Run이 참조한 모델은 삭제를 막아요. 현재 연결을 해제하고 Run이 종료되면 오래된 프롬프트의 모델 선택만으로 삭제를 막지 않으며 과거 Run의 자체 모델 snapshot은 보존해요.

## 검증 범위

설정·보관 검사는 `tests/agent-collaboration-config.test.ts`, `tests/agent-collaboration-store.test.ts`예요. `tests/agent-collaboration-runtime.test.ts`는 실제 loopback Responses 서버와 새 SQLite DB로 순서·추가 조회·권한·호출량·중복·취소·설정 변경을 검사해요. 브라우저는 `tests/agent-collaboration-browser.spec.ts`의 AGENTUI01/02에서 모바일·데스크톱 편집과 실제 저장/미리보기 API를 확인해요.

합성 검사는 구현 계약의 증거예요. 실제 모델의 창작 품질 향상, 비용 대비 효과, 실제 공급자 응답 지연은 평가하지 않았어요. 이를 비교하려면 같은 요청·프롬프트·모델로 협업 OFF와 필요한 보조만 켠 구성을 사용자가 직접 비교해야 해요.
