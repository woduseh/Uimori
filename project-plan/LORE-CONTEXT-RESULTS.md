# 로어 배치·턴 사이 유지 결과

2026-09-07, `5761bb2` 기반의 `codex/shared-package-authoring` 작업트리에서 앞선 공통 자료 구현 위에 [승인한 계획](LORE-CONTEXT-PLAN.md)을 구현했어요. 기존 미커밋 작업은 보존했고 별도 공급자·전체 문맥 압축 작업과 병합하지 않았어요. schema/archive v8의 JSON snapshot을 확장하며 DB 이관을 추가하지 않았어요.

## 구현된 동작

- 고정/자동 포함과 배경/장면 배치를 분리했어요. 패키지·부착 역할별 그룹과 그룹 안 순서를 제공하고 편집 폴더는 배치 순서에 관여하지 않아요. 기본 프롬프트는 고정 배경을 앞에, 기억·장면·변동 host 정보를 현재 입력 근처에 놓아요.
- 실제 실행된 프롬프트 슬롯이 제공한 자료를 자동 fallback에서 제외해요. 조건으로 건너뛴 슬롯은 제공한 것으로 세지 않으며, 사용자 PromptProgram의 역할·순서·cache anchor를 유지해요.
- 완료된 메인 Run의 성공한 `knowledge.read`를 당시 불변 자료와 대조해 실제 읽은 구간만 다음 Run에 유지해요. 처음 읽은 이력 위치에 참고 자료로 표시하고, 새로 읽은 미포함 구간을 추가해요. 기존 자료의 메시지 본문은 최근 사용 정보 때문에 바꾸지 않아요.
- 채팅별 문자·구간 상한, 오래 사용하지 않은 구간의 통째 정리, 다음 생성의 ‘새 장면 · 조회 로어 정리’를 연결했어요. 이미 제외한 자료는 과거 이력 재검색으로 복원하지 않아요. 고정 자료 상한 초과는 명시 오류로 알려요.
- 매 새 Run에서 자료 revision/hash·역할 권한·원문 ancestry/hash·retcon을 재검사해요. 응답 유실 재확인은 최초 reset 값을 포함한 같은 idempotency payload를 사용해요. 상태 대기 후 메인 재개에도 같은 선택 계약을 적용해요.
- 제작 화면·채팅 정책·저장 없는 미리보기·Run 진단을 제공해요. 포크는 실행 tool log 대신 검증한 읽기 증거를 옮기며, 보관 복원은 원본 채팅이 없는 독립 포크도 지원해요.

세부 기본값·사용법·API 경계는 [로어 문서](../docs/LORE-CONTEXT.md)에 있어요. 기본 조회 상한 48,000자·64구간과 고정 상한 200,000자는 UTF-16 기준이며 전체 모델 입력 토큰 예산이나 품질 최적값이 아니에요.

## 최종 검증

| 확인 | 결과·증거 |
| --- | --- |
| 타입 | `npm run check` PASS |
| 빌드 | `npm run build` PASS |
| 전체 단위·통합 | **1067 PASS·1 opt-in skip·0 FAIL**, [최종 JSON](../output/lore-context/vitest-final.json) |
| 전체 브라우저 | **73/73 PASS**, [최종 summary](../output/playwright/redesign-2026-09-07T14-52-05-015Z-842c51e3/summary.json) |
| source/build | `fd9c0e7cd90aa0d336e988a1095594b21cfed3b22b5f82bb222317cbad37a29a` 일치 |
| dist | `bcf333283aa3bdf9d911b966b7c02ab4bb07c7db8956d153c2005c7a6740dcb9` |
| 실행 후 정리 | PASS, 실행 소유 PID 0·runtime 제거·증거 DB 보존 |
| 산출물 검사 | PASS, 알려진 합성 canary에 한정해 97개 파일 검사 |
| 변경 형식 | `git diff --check` PASS |

새 로어 단위·통합 35개는 실제 읽은 범위, 중복·겹침, 문자·구간 정리, reset, 수정·retcon·개정·권한 변경, 무상태 미리보기, 독립 포크, 보관 위조 rollback, 상태 대기 후 재개와 UI 초안 계약을 확인해요. `tests/lore-placement.test.ts`는 Responses·Chat·Messages·Vertex의 실제 encoder 출력에서 자료가 한 번 제공되는지와 합성 두 턴의 고정 system/tools/이전 메시지 prefix가 같은지 비교해요. 이는 실제 공급자의 cache hit 측정이 아니에요.

새 브라우저 3개는 로어 배치·잘못된 숫자 초안, 정책 탭 이동·미저장 정책 미리보기, 응답 유실 후 reset 재확인·완료 Run 진단을 검사해요. 데스크톱과 390px의 편집·미리보기·Run 진단 화면을 직접 열어 확인했어요. 최종 Run 진단과 모바일 미리보기에서 상한·정리 이유·저장 상태가 읽히며 가로 잘림 없이 표시돼요. 스크롤된 viewport 증거를 전체 페이지나 실제 휴대폰 검증으로 보지는 않아요.

Codex 설치 환경 사전 검사 1개는 `NR_CODEX_PREFLIGHT` opt-in이 없어 skip했어요. 유료 호출은 없었어요. 샌드박스의 Vite 자식 프로세스 `spawn EPERM`은 승인된 로컬 실행으로 구분했고, 빌드에 Vite의 500 kB 번들 크기 안내가 남아 있어요.

## 수정 과정과 보존한 실패

1. [첫 전체 단위 검사](../output/lore-context/vitest-initial.json)는 1062 PASS·1 FAIL·1 skip였어요. `tests/transport.test.ts`가 예전 기본 `references` 블록 위치를 가정했어요. 새 배경 자료 슬롯에서 원래 provenance 검사를 유지하고 wire에 한 번 제공되는지도 확인하도록 기대값을 수정했어요.
2. [첫 전체 브라우저](../output/playwright/redesign-2026-09-07T14-44-23-884Z-17af3811/summary.json)는 71 PASS·2 FAIL였어요. 기존 native 검사는 host 정보가 이전 대화 앞에 있던 역할 순서를 기대했고, 새 응답 유실 검사는 저장된 payload가 JSON 문자열인데 객체로 읽었어요. 실제 변경된 배치와 저장 형식에 맞게 검사를 수정했어요. 첫 실행에서는 해당 실패 뒤의 Run 진단 assertions가 실행되지 않았으며, 최종 실행에서 전체 흐름을 통과했어요.
3. 보관 검토에서 오래된 ancestor의 읽기 증거만 맞으면 바로 이전 Run이 reset·예산 정리로 제외한 항목도 복원할 수 있는 허점을 확인했어요. runtime과 archive가 같은 선택 함수를 사용하고, 바로 이전 Run의 유지 항목과 새 성공 읽기로 가능한 전이인지 검사하도록 보강했어요. reset 후 복원·예산 정리 후 용량 확대·순서/최근 사용 위조를 거부하고 import 전체를 rollback하는 검사를 추가했어요. 최종 보관 10개와 전체 회귀가 통과했어요. 수정 전 별도 red 실행을 남긴 것은 아니므로 재현 실패 산출물이 있다고 주장하지 않아요.

첫 실패 산출물은 최종 PASS로 덮어쓰지 않았어요.

## 전체 문맥 압축 작업과 연결

사용자 요청으로 `프로바이더 파라미터 지원 개편` 작업과 직접 논의했어요. 연결 순서는 `자료·상태 고정 → 로어 선택 → 전체 문맥 계획 → projectedLogicalHistory → loreHistory → PromptProgram 조립`이에요. 원문과 과거 Run은 유지하고 compiler의 전체 이력 포함 검사는 최종 전송 대상으로 확정한 이력 안에서 유지해요.

전체 planner는 현재 로어 후보에서 순서를 유지한 통째 항목 subset을 더 줄여 새 Run에 고정할 수 있어요. archive도 이 전이는 허용하되 이미 제외된 ancestor 읽기를 되살리지 못하게 해요. 원래 읽기 위치가 압축되면 유지 로어를 `context-summary` 또는 지정한 메시지 뒤·최근 이력 앞에 두는 연결부를 구현하고 검사했어요.

전체 요약 입력에는 로어가 주입되기 전의 실제 user/assistant 원문과 검증된 이전 요약을 사용하도록 전달했어요. 삭제·개정한 로어가 summary 안에 남는 경로를 막기 위한 경계예요. 실행 중 도구 쌍·opaque prefix의 중간 절단이나 불확실한 실행 자동 재생도 하지 않도록 조율했어요. 전체 입력 추정치에는 최종 wire의 system/tools/messages가 포함되어야 하고 공급자별 실제 tokenizer와의 차이를 표시해야 한다는 점을 전달했어요.

**전체 토큰 예산·자동 요약 본체와 두 작업을 합친 실행 검증은 별도 작업 범위로 남아 있어요.** 이 작업 결과는 그 통합 완료를 뜻하지 않아요.

## 한계

합성 자료·로컬 SQLite·실제 브라우저 검증이에요. 실제 외부 모델의 설정 준수율, lost-in-the-middle 완화, cached input 사용량·청구액, 개인 작품, 물리 휴대폰·IME와 배포는 검증하지 않았어요. cache hit를 위해 변경·권한 해제된 자료를 유지하지 않으며 장면 reset·예산 정리·기억 경계 이동은 prefix를 바꿀 수 있어요.

커밋·병합·푸시는 하지 않았어요. 다른 공급자 작업의 schema·전체 압축 구현과 합친 회귀 결과는 이 소스의 결과와 구분해요.
