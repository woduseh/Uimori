# 하네스 지시와 자율성

2026-09-11 사용자 결정에 따라 검증 정책을 먼저 검토하고 내부 지시를 정리했어요. 평가 도구는 개편 대상에서 제외했어요. 실제 모델·공급자·Codex 내장 도구의 사용 품질은 사용자가 검증하며, 아래 결과는 로컬 코드·합성 검사 범위예요.

## 지시가 있는 곳

| 위치 | 역할 |
| --- | --- |
| `core/provider.ts`, `server/main-request.ts` | 본문 실행의 자료 조회, 사용자 메모, 구성·상태·협업·최종 제출 경계 |
| `core/provider-messages.ts`, `server/main-host-context.ts` | 선택 프롬프트의 역할·순서와 동적 참고 JSON 전달 |
| `core/codex-protocol.ts`, `server/codex-runtime.ts` | Codex의 논리 메시지·최종 JSON·Uimori 도구 요청, 내장 도구 실행 범위 |
| `core/auxiliary.ts`, `server/product-auxiliary.ts` | 번역, 표시용 요약·분위기, 기존 이미지 선택과 원문 귀속 |
| `server/story-runner.ts` | 원문 증거에 근거한 패키지 상태 변경 제안과 구조 검증 |
| `core/context-summary-policy.ts` | 요약의 귀속·약속·불확실성·사용자 정정·진행 중 요청 이어가기 |
| `server/context-compaction.ts`, `server/context-tool-compaction.ts`, `core/context-tools.ts` | 대화 및 읽기 결과 압축, 작업 기억 저장·새 문맥 창 |
| `server/helper-runtime.ts`, `server/helper-workspace.ts` | 앱 도우미의 실행·편집·저장·가정 장면, 직접 사용자 요청에서 부여하는 권한 |
| `server/agent-collaboration.ts`, `core/agent-collaboration.ts` | 선택 협업자의 지침·기본 템플릿·자료 조회·후속 상담 |
| `core/illustration.ts` | 장면 삽화 프롬프트와 Codex 이미지 생성 지시 |
| `server/chat-title.ts`, `server/product-auxiliary.ts`의 거절 판정 | 짧은 제목, 번역 응답의 명확한 거절 판정 |

선택한 PromptProgram이 문체·작가 역할·창작 방식을 정해요. 하네스는 수행 가능한 도구, 원문·개정 귀속, 저장·취소·결과 형식에 필요한 계약을 보탠다고 해석해요. 페메/번역 프롬프트와 Risu 협업 파이프라인은 참고했지만 자료 이름에 따른 분기나 특정 문체의 강제 규칙은 추가하지 않았어요.

## 달라진 정책

- **도구 오류 수정**: 복구 가능한 오류를 합계 3회·동일 요청 2회에서 중단하던 별도 제한을 제거했어요. 잘못된 인수나 번역·이미지 조회의 미발견은 모델이 수정하거나 다른 경로로 마칠 수 있게 반환해요. 호출·시간·입력 예산은 각 실행기가 유지해요.
- **저장 완료**: 대상이 명확한 제작·수정 요청은 그 대상의 저장까지 허용해요. 검토·제안·초안만 요청하거나 저장을 금지하면 그 범위를 지켜요. 인용문·픽션 OOC·미확정 조건은 쓰기 허가가 되지 않아요. 새 자료 제작을 기존 편집기의 저장 권한으로 넓히지 않아요.
- **사용자 메모**: `core/notes.ts::AUTHOR_NOTE_GUIDANCE`를 공통으로 전달해요. 메모·정정은 파생 요약과 충돌하는 과거 주장보다 우선하며 최신 명시 정정·철회가 해당 메모를 대체해요. 메모는 작가 지시로 귀속되고 관찰된 사건·등장인물 지식·도구 권한으로 자동 승격되지 않아요.
- **협업**: 질문이나 명시적으로 전달한 문맥이 달라진 후속 상담을 허용하고, 같은 협업자·질문·전달 문맥은 이전 성공·실패 결과를 재사용해요. 메인이 완료 의견·조회 근거·미확정 초안을 골라 전달하며 협업자별·전체 예산을 누적해요. 최종 판단은 메인이 맡고 의견은 선택 가능한 창작 제안으로 기존 사실과 구분해요.
- **지시 전달**: 번역 referencePolicy와 협업 sharedInstructions를 참고 JSON에서 명시 계약으로 옮겼어요. 선택 프롬프트를 중복하거나 하네스 기본 문체로 덮지 않아요.
- **요약·도우미**: 반복 금지문을 줄이고 현재 요청 완료, 필요한 근거 조회, 정확한 귀속과 영수증, 충돌 보존을 중심으로 정리했어요. 기존 기억을 장면별 요약으로 누적하지 않고 현재 상황·관계·미해결 약속에 필요한 내용으로 재작성해요.
- **출력 표면**: 표시 보조 결과의 바깥 JSON 코드 펜스를 허용해요. 소스·anchor·revision/hash 검증이나 잘못된 결과를 잘라 저장하는 정책은 바꾸지 않았어요. 표시 요약 600자·분위기 100자·이미지 최대 4개는 기존 표시 계약으로 유지하고 지시에 명시했어요.
- **Codex 내장 도구**: 일괄 금지를 제거하고 cached 웹 검색과 격리 JavaScript code mode를 허용해요. 진행·검색·계산·압축 이벤트를 본문에 섞지 않고 최종 결과를 채택해요. 파일·인증·셸·외부 변경 접근은 별도 실행 환경 설계가 필요한 경계예요. 정확한 허용 목록과 소스 근거는 [Codex 계약](CODEX.md)에 있어요.
- **이미지의 근거**: 이미지 이름·설명만 받은 경우 실제 픽셀을 보았다고 주장하지 않도록 해요. 실제 참조 이미지가 전달되는 삽화 경로의 이미지 관찰을 금지하는 의미가 아니에요.

## 유지한 검증 경계

원문/hash/revision·출처·범위·CAS·operation 영수증·취소·최종 제출은 데이터 보존에 필요한 계약이에요. 무결성 오류를 숨길 수 있는 `story.* RESOURCE_UNAVAILABLE`, 권한 없는 도구, 알 수 없는 외부 실행은 자동 수정·재전송으로 바꾸지 않았어요. 요약·사용자 정정이 원문 span을 요구하는 상태 증거 검증을 대신하지도 않아요.

자연어 도우미 허가는 직접 요청의 표현을 판별하므로 모든 문장의 의도를 이해한다는 보장은 없어요. 실제 허가 목록은 접수 때 snapshot에 고정하며 모델이 스스로 추가할 수 없어요. 판별되지 않은 요청은 저장 성공으로 보고하지 않아요.

## 근거와 검증

[GPT-6 Astra prompting best practices](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices)의 작업 완료 자율성, 명확한 지시 우선순위, 비례적인 검증, 구체적 위임 원리를 적용했어요. 이는 특정 프롬프트의 실제 창작 품질 향상을 입증하지 않아요. 참고 자료·비채택 이유는 [SOURCES](../project-plan/SOURCES.md)에 기록해요.

- 최초 `quality:full`은 **1,931 PASS / 1 FAIL / 선택 1 skip**이에요. `tests/comfyui-client.test.ts`의 `the total deadline includes stalled view response bodies`가 15초 timeout으로 실패했고, 다른 변경 영역 검사는 통과했어요. 로그는 `output/harness-prompts-quality-full-20260911.log`예요.
- 같은 ComfyUI 파일 단독 재실행도 **15 PASS / 1 FAIL**로 같은 실패를 재현했어요(`output/harness-prompts-comfyui-focused-20260911.log`). 당시 `server/comfyui-client.ts`는 이번 작업에서 바뀌지 않은 파일이었어요. 본문 읽기가 fetch의 취소 전파만 기다리고 cleanup의 cancel 완료까지 기다리는 기존 종료 경계 문제로 분리해요. 테스트 timeout을 늘리지 않고 기존 공급자 SSE와 같은 명시적 reader 취소를 적용해 검증해요.
- 첫 최소 앱 검사 F02·F03·F06은 **PASS**, 협업 설정·미리보기 브라우저는 **3 PASS**예요. 실행은 각각 `2026-09-11T08-15-09-032Z-5473238e`, `collaboration-2026-09-11T08-15-22-837Z-84f530e1`이며, 두 실행 모두 cleanup PASS예요. 이 증거는 ComfyUI 후속 수정 전 빌드의 결과예요.
- 도구별 집중 검사에는 초기에 Vite 자식 프로세스의 `spawn EPERM`으로 미실행된 시도가 있어요. 허용된 로컬 환경에서 다시 검사했어요. 기존 지시 문장의 완전 일치 기대 및 새 테스트 관찰 코드 오류를 고친 후 관련 집중 검사는 통과했어요. 이 사실을 전체 검사 실패의 대체 증거로 사용하지 않아요.

ComfyUI 후속 수정은 reader가 요청 signal을 직접 구독하고 취소 응답 완료를 기다리지 않게 했어요. fetch abort와 cancel ACK가 모두 지연되는 결정적 회귀에서도 `COMFYUI_TIMEOUT`, prompt ID 보존, 원격 취소·재제출 없음이 확인됐고 관련 **17 PASS**예요. 검토 문장에 포함된 저장 금지까지 보완한 최종 도우미 권한·초안 검사는 **87 PASS**예요.

### 최종 통합 결과

Node 24.14.0에서 최종 소스·테스트를 고정한 뒤 실행했어요. 전체 검사 후 변경은 이 결과 문서뿐이에요.

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| `npm run quality:full` | **PASS** — 서식·lint·타입·도구 검사·새 빌드, 180개 파일 / **1,936 PASS / 선택 1 skip** | `output/harness-prompts-quality-full-final-20260911.log` |
| `npm run verify:smoke` | **F02·F03·F06 PASS**, cleanup PASS | `output/playwright/2026-09-11T08-25-18-377Z-a28a80f1/summary.json` |
| `npm run verify:collaboration` | **3 PASS**, cleanup PASS | `output/playwright/collaboration-2026-09-11T08-25-32-697Z-56bf30b3/summary.json` |
| `npm run verify:illustration` | **3 PASS**, cleanup PASS | `output/playwright/illustration-ui-2026-09-11T08-25-54-280Z-ac53a06c/summary.json` |

평가 도구의 정의·정책은 수정하지 않았어요. 실제 공급자·설치 Codex의 내장 도구 실행·창작/번역 의미 품질·물리 기기는 검증하지 않았어요. 전체 `verify:redesign`은 이번 변경 게이트가 아니므로 실행하지 않았어요.
