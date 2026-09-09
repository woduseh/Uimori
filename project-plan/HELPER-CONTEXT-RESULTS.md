# 도우미·통합 문맥 구현 결과

2026-09-09 · 기준 HEAD `4ad43d8`와 보존한 병행 UI 변경 위의 미커밋 작업이에요. 제품 계약은 [확정 계획](HELPER-CONTEXT-PLAN.md), 사용법은 [USAGE](../docs/USAGE.md)에 있어요. **텍스트 기능·공개 응답 스트리밍 구현과 로컬 검증·인계를 마쳤어요.**

최종 품질 검사는 단위·통합 **1,562 PASS / 선택 1 skip**, 하네스 **27 PASS**예요. 최종 전체 브라우저는 **197 PASS / 1 FAIL**이고, 실패한 Escape 닫기 검사만 같은 소스에서 수정 없이 다시 실행한 결과는 **1 PASS**예요. 필수 case 74개는 모두 통과했고 재실행의 종료 소스 동일성·cleanup도 확인했어요. 전체 실행의 FAIL은 그대로 보존하며 간헐 닫기 실패의 원인은 미확정이에요. 390/1440px의 도우미·문맥·초안 화면은 같은 최종 앱 빌드로 검토했어요.

## 구현

- **fresh v15**: DB/archive를 v15로 올리고 매 턴 기억 추출 job·API·UI·프롬프트 슬롯·추출 평가 실행기를 제거했어요. 사용자 메모·정정, 원문 보존·조회, 공통 요약으로 대체했어요. 구버전 이관이나 운영 DB 초기화는 수행하지 않았어요.
- **공통 문맥**: 본문 Run과 독립된 checkpoint/revision, 활성 pointer CAS, 자동·수동 압축과 모델 호출 없는 직접 요약 편집·복구를 연결했어요. 원문/hash/viewHash·메모 의존성이 맞아야 재사용하며 늦은 결과는 후보로 보존해요. 새 `contextModel`은 실제 압축 때만 필요하고 임의 모델 fallback은 없어요. 직접 편집에도 전송 예산을 계산할 본문 모델 설정은 필요해요.
- **도우미 작업**: 별도 입력·대화·대기 요청·사용량·취소·중단 기록, 채팅/서재 작업별 이력, 공개 이벤트와 설정을 서버에 보관해요. 명시적인 사용자 변경 요청만 허가로 고정하고 모델·인용·원문·OOC의 권한 주장을 받아들이지 않아요. 기본 한도는 총 전송 24회·도우미 전송 12회·산출물 1개이며 자식 호출도 상위 사용량에 합산해요.
- **같은 초안**: 사람과 도우미가 자료·프롬프트의 서버 초안을 공유해요. 미적용 JSON·루트 revision·재사용하지 않는 초안 ID를 보존하며 요청/저장 전 flush해요. 최신 편집과 충돌하면 제안을 남기고 저장 영수증으로 재전송을 중복 적용하지 않아요. 수정하지 않은 초안만 서버 CAS로 최신 저장본에 연결하고, 조회·갱신 도중 입력은 보존해요. 공유 영향·저장 이력·되돌리기를 기존 편집기에서 검토하며, 첫 자료 저장·역할 사본 생성 때도 펼친 영역과 선택한 분야·필터를 유지해요.
- **앱 도구**: 자료/프롬프트 읽기·제작·편집·저장, 폴더 정리, 요약·메모 수정, 제목 변경·결정적 포크, 연결별 채팅 로어 변경, 채팅 고정/일회/위임 옵션을 기존 서비스에 연결했어요. 같은 패키지의 다른 역할과 공유 원본은 유지하고 위임은 실제 옵션 정의와 해제 상태로 확인해요.
- **가정 장면**: 접수 당시 최신 완료 본편과 현재 작문 설정을 고정한 자식 작업이에요. 필요한 authoritative 상태를 같은 원문에서 기다리며 실패·취소 때 과거 상태로 대체하지 않아요. 행동 도구는 요청 조립에서 제외하고 본편 head·상태·추첨·후속 요청을 저장하지 않아요. 결과는 정확한 산출물 ID/revision을 참조하며 질문·복사·직접 편집·원래 문맥으로 수정할 수 있어요.
- **실제 공개 답변 스트림**: decoder → runner → DB batch → cursor/offset → UI를 본문·도우미·가정 장면에 연결했어요. UI는 300ms 간격으로 새 배치를 한 요청씩 조회해 여러 탭에서 추가 영구 연결이 HTTP/1 연결 한도를 채우지 않게 해요. 서버 SSE API도 유지해요. reasoning·도구 인자·opaque·평가 내부 출력은 제외해요. 최종 검증이 필요한 제출 모드는 검증된 본문만 완료 때 제공하며 가짜 타이핑 효과를 사용하지 않아요.
- **긴 작업·복원**: 완료한 도구 교환 뒤 세그먼트를 바꾸고 공통 요약을 재사용해요. 새 요청에서 opaque/call ID를 종료해도 상위 작업·허가·operation 영수증·취소·실제 호출 수는 유지해요. v15 archive/SQLite backup에 초안·요약·메모·도우미·산출물·영수증을 포함하며 진행 중 작업은 복원 후 자동 재호출하지 않아요.

## 인수 근거 지도

아래는 각 계약을 확인하는 현재 검사 위치예요. 실행 결과는 다음 절에 따로 기록해요. HTTP/브라우저 fixture와 실제 외부 공급자·실기기 증거를 구분해요.

| 인수 | 주된 검사 |
| --- | --- |
| HC01–05 원문/요약/메모·예산·분기 | `context-integration`, `context-compaction`, `context-checkpoint-storage`, `context-authored-integration`, `context-lore-integration`, `source-context`, `source-segments-integration`, `story-archive`, `auxiliary-model-selection` |
| HC06–08 같은 초안·권한·연결별 로어 | `edit-drafts`, `edit-draft-session`, `helper-draft-runtime`, `chat-overrides`, `helper-workspace` |
| HC09–11 독립 산출물·상태 대기·한도·멱등성 | `helper-workspace`, `helper-draft-runtime`, `chat-options`, `chat-fork` |
| HC12–13 스트리밍·취소·비공개 출력 | `response-progress`, `response-stream`, `native-wire`, `transport`, `codex-protocol`, `evaluation-*` |
| HC14 화면·초안·뒤로가기·기존 기능 | 전체 `verify:redesign`; 새 `HELPUI01–04`, `CTXUI01–03`, `ED01–02`, `PWS03`, 옵션 범위 2건과 기존 관련 회귀 |
| HC15 v15 복원·소유권·중단 | `helper-workspace`, `edit-drafts`, `response-stream`, `context-integration`, `chat-options`, `story-archive`, `schema-baseline-reset`, `product` |

`helper-browser`는 도우미 작업·이벤트의 UI projection을 사용해요. 실제 작업·도구·SQLite 쓰기와 모델 전송 횟수는 별도 `helper-workspace`/`helper-draft-runtime` 통합 검사로 확인하고, 실제 로컬 SSE 전송·재접속은 `native-wire`/`response-stream`에서 확인해요. 브라우저 projection을 실제 모델 실행 증거로 해석하지 않아요.

## 실제 검사

- 최초 `quality:full`: 서식·lint·타입과 하네스 27건 PASS. 기본 샌드박스 빌드는 `spawn EPERM`으로 BLOCKED였고 이전 dist는 보존됐어요. 로컬 실행 권한으로 재실행한 빌드는 PASS예요.
- 최초 전체 Vitest: **1,519 PASS / 26 FAIL / 선택 1 skip**. 실패 로그는 `output/helper-quality-full-initial.txt`에 보존했어요. v14 고정 기대값, 제거된 memory fixture/도구, 이전 ancestor Run 요약 선택 계약을 새 계약에 맞게 보완했어요. 최초 실행을 PASS로 바꾸지 않아요.
- 첫 품질 재검증 **PASS**: 서식·lint·전체 타입, 하네스 **27 PASS**, 새 빌드, 전체 단위·통합 **1,554 PASS / 선택 1 skip**예요. `output/helper-quality-full-final.txt`, `output/tooling/2026-09-09T04-18-19-650Z-d3c63960/summary.json`을 보존했어요. 최초 실패 파일들을 수정한 뒤 전체를 다시 실행한 결과예요.
- 최초 전체 브라우저 `redesign-2026-09-09T04-20-41-001Z-606f2a77`은 **FAIL**이에요. 기존 저장 API 응답을 기다리던 검사들이 누적돼 600초 timeout과 reporter 누락으로 끝났어요. 리포터가 없어 PASS 수를 산정하지 않아요. 공통 초안 저장 관측 경로·라벨을 정리하고, 3개 탭의 영구 SSE 6개가 새 자산 요청을 막는 회귀와 본문 모델 미지정 요약의 500 응답을 보완했어요. 최초 실행·cleanup 증거는 보존했어요.
- 화면 회귀 수정 후 `quality:full` **PASS**: 전체 단위·통합 **1,555 PASS / 선택 1 skip**, 하네스 **27 PASS**, 서식·lint·전체 타입·새 빌드 PASS예요. `output/helper-quality-release.txt`, `output/tooling/2026-09-09T04-43-23-590Z-dc03dbb5/summary.json`에 있어요. 집중 브라우저 `helper-followup-2026-09-09T04-46-25-140Z-b28bdd0f`은 **19 PASS / 2 FAIL**이며 첫 자료 저장·사본 생성 때 폼이 다시 마운트되는 회귀 두 건을 확인했어요. 이 실패 실행의 소스 동일성은 종료 시 확정되지 않았어요.
- 편집 폼 보존 후 `output/helper-quality-final.txt`는 **1,555 PASS / 선택 1 skip**, 하네스 **27 PASS**예요. 다음 전체 브라우저 `redesign-2026-09-09T04-58-13-720Z-25bef2f7`은 **FAIL**: 600초 timeout과 reporter 누락으로 PASS 수를 산정하지 않아요. 남아 있던 서버 프롬프트 초안과 테스트의 전역 설정 복원 사이 충돌로 14건이 실패했어요. 변경 없는 초안의 안전한 최신화·늦은 입력 보호를 구현하고, 합성 테스트의 공통 초안 격리와 `PWS03`을 추가했어요.
- 변경 없는 초안 보호 후 `quality:full` **PASS**: 전체 단위·통합 **1,562 PASS / 선택 1 skip**, 하네스 **27 PASS**, 서식·lint·전체 타입·빌드 PASS예요. `output/helper-quality-acceptance.txt`, `output/tooling/2026-09-09T05-25-34-379Z-c9126df3/summary.json`에 있어요.
- 해당 빌드 source/build ID는 `e180f0db25d5e3c8249dda6b89fe54755da97d76c11aae48dd7c6d77bdc9cc4f`, dist hash는 `4e3939dd08b344eb397f6dea0e765a3d454740012dbd72afa937c6bd05bfe584`예요. 전체 브라우저 `redesign-2026-09-09T05-27-40-443Z-25a0af28`은 **193 PASS / 5 FAIL**로 완료했어요. 초기 필드의 동일값 기록 때문에 변경 없는 초안이 최신화되지 않던 회귀, 명시적 폐기에서 서버 초안을 남기던 연결 누락을 수정했어요. 접힌 블록·응답 메뉴·모델 역할에 대한 기존 화면 기대값도 맞췄어요. 실패 실행은 최종 PASS 근거로 사용하지 않아요.
- 최종 수정 후 `quality:full` **PASS**: 전체 단위·통합 **1,562 PASS / 선택 1 skip**, 하네스 **27 PASS**, 서식·lint·전체 타입·빌드 PASS예요. 로그는 `output/helper-quality-complete.txt`, 하네스 결과는 `output/tooling/2026-09-09T05-43-12-721Z-551b56b0/summary.json`에 있어요. 최종 source/build ID는 `0a60c7c39dc7ad8c004a84d3b1f76433752335871de8408a792b6648b878f37c`, dist hash는 `32d4dd00d957b731e85827eb71e19262944413f2dff53ac0ff8b129b357d888f`예요.
- 집중 브라우저 `helper-acceptance-2026-09-09T05-45-12-917Z-dfc68c90`은 선택한 화면 **9 PASS / 0 FAIL**이지만 실행기 상태는 **FAIL**이에요. `UI17`이 두 검사를 선택하는데 임시 실행기에 예상 8건으로 적은 오류이며, `Expected 8 browser tests, received 9`와 cleanup PASS를 보존했어요. 실행기 예상값을 9로 바로잡았고, 종료 동일성을 확정하지 못한 이 실행을 최종 통합 PASS 근거로 쓰지 않아요.
- 전체 브라우저 `redesign-2026-09-09T05-46-47-716Z-f410c5e3`의 화면 검사는 **198 PASS / 0 FAIL / 0 skip**이지만 실행기 상태는 **FAIL**이에요. 현행 테스트에서 제거된 `PMUI05/06`을 필수 목록이 계속 요구해 `Missing PMUI05 evidence`로 끝났어요. cleanup·합성 canary 검사·provider fixture는 PASS이며 종료 동일성은 확정하지 못했어요. 필수 목록을 현행 연결·모델 편집·응답 검사로 교체한 뒤 Biome와 하네스 **27 PASS**를 확인했어요(`output/helper-tooling-final.txt`, `output/tooling/2026-09-09T05-55-08-183Z-2f017853/summary.json`). 앱 소스와 브라우저 테스트는 이 실행 뒤 바꾸지 않았어요.
- 다음 `redesign-2026-09-09T05-55-32-476Z-70970cc2`도 화면 **198 PASS / 0 FAIL / 0 skip**, 실행기 **FAIL**이에요. 남아 있던 폐기 항목 `PCUI03`에서 멈췄고 cleanup·합성 canary·fixture 검사는 PASS예요. 필수 목록 전체를 실제 리포트의 case token과 대조해 해당 항목을 제거했으며, 남은 **74개 모두 실제 실행된 검사에 대응**함을 확인했어요. 이 수정도 앱 소스·브라우저 테스트를 바꾸지 않았어요.
- 최종 실행기 수정 뒤 하네스 **27 PASS**예요. `output/helper-tooling-complete.txt`, `output/tooling/2026-09-09T06-05-26-895Z-ebdda589/summary.json`에 있어요.
- 최종 전체 `redesign-2026-09-09T06-04-07-932Z-e84c56b6`은 **197 PASS / 1 FAIL / 0 skip**이에요. 필수 case **74개는 모두 PASS**이며, 실패는 `tests/ui-browser.spec.ts:1879`의 데스크톱 채팅 설정 Escape 닫기 한 건이에요. 화면과 trace는 해당 실행에 보존했어요. 앞선 같은 앱 빌드 두 실행에서는 통과했고, 이번 실패의 구체적인 원인은 확정하지 못했어요.
- **코드·테스트 수정 없는 집중 재실행 PASS**: `dialog-close-2026-09-09T06-12-18-458Z-c23781b9`의 같은 닫기 검사가 모바일/데스크톱에서 **1 PASS**예요. 두 실행의 전체 검증 지문은 `de027e503aba30027651a65d62c3193007b88a1340eea7348ab56250736db778`로 같고, 집중 실행에서 종료 동일성을 `2026-09-09T06:12:21.728Z`에 확인했어요. 두 실행 모두 cleanup PASS·live PID 없음·runtime 제거를 확인했어요. 최종 전체 실행 자체를 PASS로 바꾸지 않아요.

같은 최종 빌드의 화면 증거는 `redesign-2026-09-09T05-46-47-716Z-f410c5e3/browser/`의 `helper-panel-{390,1440}.png`, `context-summary-{390,1440}.png`, `edit-drafts-{390,1440}.png` 6장을 직접 검토했어요. 그 뒤 변경은 실행기의 필수 목록뿐이며 앱·테스트 소스는 같아요. 화면 넘침·입력창 배치·요약 복구·저장 이력 표시를 확인했으며 실제 휴대폰 검증을 대신하지 않아요.

## 제한과 인계

실제 공급자 호출·장문 의미 품질·청구액 대조·휴대폰/IME·운영 배포는 수행하지 않았어요. 현재 검증은 fresh DB/loopback의 합성 자료로 실행 계약을 확인해요. 모델이 자연어 지시를 원하는 도구로 해석하는 품질은 승인된 실모델 평가로 확인해야 해요. 권한 분석은 보수적이므로 명확한 변경 지시로 인식되지 않은 요청은 도구 실행 오류를 반환하고 재확인 없는 권한 확장을 하지 않아요.

이미지 이해는 [계획 11절](HELPER-CONTEXT-PLAN.md#이미지-이해를-후속으로-시작할-때)의 후속 범위예요. 현재 이미지 설명 텍스트를 읽는 것과 실제 이미지 입력을 이해하는 것을 구분해요. 운영 v14 DB에는 이 빌드를 바로 교체하지 않으며 기존 Oracle v14 배포 스크립트는 v15 데이터 전환 절차를 대신하지 않아요. 구버전 DB·자료·설정을 자동 이관하거나 초기화하지 않았어요.

### 별도 실모델 평가를 시작할 때

실행 전에 도우미·작문·문맥 모델의 정확한 프리셋, 합성 자료, 시나리오 수·전송 한도·중단 기준을 정하고 승인받아요. 현재 모델을 읽는 것만으로 새 외부 호출을 승인받은 것으로 해석하지 않아요. 동일 작문 프롬프트와 전송 한도로 압축 전/후를 비교하고 각 요청의 checkpoint ID/revision, 전송 원문 범위, 실제 호출·token usage, 공급자 보고 비용과 추정치를 기록해요.

| 시나리오 | 결과를 보기 전에 고정할 관찰 기준 |
| --- | --- |
| 오래된 약속·관계 변화 | 평가용 정답 사실을 유지하고 이후 사건과 혼동하지 않는지 |
| 비공개 지식·인물의 믿음 | 누가 알 수 있는지 구분하고 요약의 추측을 사실로 바꾸지 않는지 |
| 사용자 정정·반복 압축 | 명시적 정정이 이전 요약보다 우선하며 중요한 사건을 누락하지 않는지 |
| 원문 재조회·작문 품질 | 필요한 원문을 조회할 수 있고 같은 작문 설정의 시점·문체가 유지되는지 |
| 설명/제안/저장 요청 | 설명·제안이 변경을 만들지 않고 명확한 저장은 같은 초안에 한 번만 반영되는지 |
| 긴 도우미 작업·가정 장면 | 세그먼트 뒤 미완료 작업과 영수증을 이어가고 원래 산출물 문맥·본편 불변이 유지되는지 |

모델의 자연어 해석·요약 의미·문체 평가는 사람이 원문·정답표와 함께 판정해요. 로컬 계약 검사 PASS를 이 평가 결과로 대신하지 않아요.
