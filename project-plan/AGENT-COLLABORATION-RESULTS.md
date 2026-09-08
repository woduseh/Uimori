# 커스텀 에이전트 협업 · 2026-09-08

작문 프롬프트에 편집 가능한 협업 에이전트를 연결했어요. 인물의 개성·동기·관계와 설정·기억의 근거를 검토하는 템플릿, 직접 작성하는 지침, 모델 선택, 작성 전 자문과 메인의 필요 시 호출을 제공해요. 기본은 OFF이며 메인이 최종 문장을 작성해요. [사용법과 실행 계약](../docs/AGENT-COLLABORATION.md)

## 구현과 통합 기준

- 전용 작업트리: `C:/Users/wodus/.codex/visualizations/2026/09/08/01a07e98-511d-7443-9909-33e4f85db0a8/uimori-agent-collaboration`, 브랜치 `codex/main-agent-collaboration`.
- 시작 commit은 `598f3ca9149efd5189f140b91a02d3eafc6eba84`예요. 완료된 be9e의 v13 자료·프롬프트·공유 모듈 최신 설정과 번역 구간·전체 재시도 변경을 `96b049b`로 고정했어요.
- UI 작업의 `output/uiux-improvements-2026-09-08/workspace-source`와 `snapshot-manifest.json`에서 526개 파일의 SHA-256을 확인해 별도 기준 `1a26ebe`로 고정했어요. 이 기준에는 기존 정리·보조 작업 복구·UI 개편이 들어 있어요. 원본에서 삭제된 두 파일(`scripts/ui-evidence.mjs`, `web/ProviderSettings.tsx`)은 삭제를 반영하고 사본 수집 대상이 아닌 기존 tracked 파일은 보존했어요.
- 협업 기능은 `069d7dc`, v13·UI 통합은 `dbd0a45`에 있어요. 원래 main 작업공간과 be9e의 파일·미커밋 작업·사용자 DB를 수정하지 않았어요. 외부 push와 유료 모델 호출은 없어요.
- 충돌은 최신 설정·과거 snapshot 보존·현재 설정으로 전체 번역 재시도와 상태 작업 복구·새 채팅 status 기본 OFF·lazy panels·모바일 진입을 함께 유지하도록 해소했어요. 화면 5파일과 브라우저 10파일은 각각 담당을 나누고 최종 통합은 여기서 검증했어요.

## 구현 범위

`PromptProgram.collaboration`에 최대 6개 정의와 명시적 공유 지침·선택 옵션을 저장해요. 프롬프트의 저장·복제·JSON 왕복·CAS·최신 설정 계약을 재사용하며 Run 예약에는 각 에이전트의 모델·연결 snapshot을 고정해요. 특정 작품이나 Phēmē의 옵션 ID에 의존하지 않아요.

추가 조회는 기존 메인의 source projection과 선택한 자료·지침·기억·이야기 읽기 권한 안에서 실행해요. 보조가 다른 에이전트·상태 변경·추첨·최종 원문 제출·평가 도구를 호출할 수 없어요. 보조 결과는 의견·근거·질문·출처가 붙은 tool event이며, 메인의 최종 응답만 source가 돼요. 자동 후처리·재작성은 없어요.

보조 전체·개별·Run 전체 호출 한도를 동시에 적용하고 요약 호출도 전체에 포함해요. 전송 전 durable attempt, 매 호출 최신 연결 권한 확인, 취소와 늦은 결과 차단, 불확실 실행 자동 재생 금지, usage와 실제 비용 미제공 `null`을 유지해요. 한 Run에서 같은 에이전트를 다시 부르면 첫 상담 결과를 재사용해요.

## 검증

| 검사 | 결과와 범위 |
|---|---|
| `npm run quality:full` | **1,331 PASS · 1 opt-in skip**, 서식·lint·타입·빌드 PASS. `output/agent-collaboration-quality-full.log`, 88.55초 Vitest. |
| 협업 config/store/runtime | 위 전체 검사에 포함한 **39 PASS**. 실제 loopback Responses HTTP와 새 SQLite로 호출 전 attempt·순서·중복·조회 권한·동결 설정·취소·usage·완료 archive 복원과 귀속 위조 rollback을 검사했어요. |
| `npm run verify:collaboration` | **2/2 PASS**, AGENTUI01/02. `output/playwright/collaboration-2026-09-08T03-01-50-055Z-2d32087f/summary.json`, source/build `22d818b70087f2920c03557cc0648565b92ea81dd56d918a7dfa5fe6e93bc783`, cleanup PASS. |
| 최종 `npm run quality`·`npm run build` | 협업 체크박스 정렬·캡처와 통합 브라우저 진입·문구 보정 후 PASS. source/build `244b36200b7753993f68dd8da855c8bb3b40bbfb2b377a0275ad2c172564b9a6`, 실행 산출물 `6edd50068fd8f14879a3fdeb88c5874342b34c39d4d1bea2a92b0002a304683e`. |
| 최종 `npm run verify:redesign` | **137/137 PASS · 0 skip**, 209.9초. `output/playwright/redesign-2026-09-08T03-09-07-645Z-e35b4391/summary.json`. 협업 AGENTUI01/02 포함, source/build·실행 산출물 일치, 등록 fixture 오류 0개, cleanup PASS예요. |

전체 단위 검사 뒤에는 브라우저 진입 절차와 협업 체크박스 CSS·화면 캡처만 바뀌었어요. 최종 품질·빌드와 전체 브라우저로 해당 변경을 확인했으며 단위 검사를 반복하지 않았어요. 검증에는 사용자 DB·개인 작품·실제 공급자를 사용하지 않았어요.

협업 화면은 390px와 1440px 캡처를 직접 검토했어요. [모바일 설정](../output/playwright/redesign-2026-09-08T03-09-07-645Z-e35b4391/browser/agent-collaboration-browse-e8e13-d-JSON-round-trips-at-390px/agent-collaboration-mobile-overview.png) · [데스크톱 개별 에이전트](../output/playwright/redesign-2026-09-08T03-09-07-645Z-e35b4391/browser/agent-collaboration-browse-c1d79-n-stays-separate-on-desktop/agent-collaboration-desktop.png). 가로 넘침·초안 보존·저장과 다시 열기는 브라우저 단언으로 확인했어요.

## 발견과 수정 이력

- Windows의 기본 제한 환경에서 Vitest/Vite 자식 프로세스가 `EPERM`으로 실행되지 않았어요. 격리 작업트리·새 합성 DB·loopback 범위로 승인된 실행에서 실제 결과를 확인했어요. 환경 실패를 제품 PASS로 바꾸지 않았어요.
- 최초 저장 테스트의 공유 옵션 검사는 예약 직후 아직 만들어지지 않은 prompt compilation을 전제로 했어요. 실행 때와 같은 명시적 compilation 단계로 fixture를 보정했어요.
- 최초 runtime 검사 **8 PASS / 1 FAIL**에서 자문 근거의 reference가 비어 있었어요. 실제 읽기 결과의 `source.reference` 경로를 사용하도록 제품을 고쳤고 기존 단언으로 통과했어요. 이야기 범위·기억 출처 메타데이터도 해당 읽기 결과에서 보존해요.
- 최초 협업 브라우저 `collaboration-2026-09-08T02-43-28-751Z-a65f715e`는 **0 PASS / 2 FAIL**이었어요. 템플릿 버튼의 실제 접근성 이름과 달랐던 테스트 선택자를 수정했어요.
- 통합 후 `collaboration-2026-09-08T02-59-58-628Z-b55ac370`는 **1 PASS / 1 FAIL**이었어요. 기존 프롬프트의 고정된 역할 선택을 변경하려던 테스트를 새 번역 초안 진입으로 고쳤고, 역할 고정 단언도 유지했어요. 실패한 실행의 summary·trace·화면은 그대로 보존해요.
- 모바일·데스크톱 PNG를 직접 검토하며 전역 `label`의 column 방향이 협업 체크박스에 상속된 것을 확인했어요. 협업 체크박스만 row 방향으로 명시했어요.
- 첫 전체 통합 브라우저 `redesign-2026-09-08T03-03-42-864Z-b7d0fca6`는 **134 PASS / 3 FAIL**, cleanup PASS예요. CURRENTUI01에는 UI 개편의 입력창 더보기·새 채팅 추가 설정 진입을 추가하고, LUSE01/02에는 v13의 개정 번호 없는 저장 안내를 반영했어요. 선택값·새 채팅 저장·과거 기록·가로 넘침 단언은 유지했어요. 이 보정은 테스트 두 파일에만 있고 실행 산출물 지문은 최종 빌드와 동일해요. 원래 실패 증거를 보존했어요.

## 남은 범위

합성 통과는 창작 품질 향상이나 실제 공급자 비용·응답 시간의 증거가 아니에요. 인물성·재미·설정 충실도는 같은 요청·프롬프트·모델에서 협업 OFF와 선택한 보조만 켠 구성을 실제로 비교해야 해요. 유료/live 평가는 사용자가 수행하는 별도 범위예요.

협업 정의는 각 작문 프롬프트 안에 저장해요. 독립 전역 에이전트 등록부, 보조끼리의 재귀 호출, 한 Run 안에서 같은 보조에 새 질문을 계속 보내는 대화, 자동 후처리는 구현 범위에 포함하지 않아요. 원래 main 작업공간으로의 반영과 원격 push는 수행하지 않았어요.
