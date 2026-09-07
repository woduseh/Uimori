# 번역 문맥 자율 조회 보강 결과

기준: 2026-09-07, main `51e5196`. 작업 경로는 `C:/Users/wodus/.codex/worktrees/7520/uimori`예요. 원래 루트의 `NATIVE-PORTING.md`는 읽기 전용으로 참고했어요. 개인 자료 열람/외부 전송, 유료 호출, 원격 push, 배포는 하지 않았어요.

## 구현 결과

번역 모델이 기존 `knowledge.search/read`, `skills.list/load`에 더해 `story.search/read`, `memory.search/read`, `translation.search/read`를 선택할 수 있어요. 강제 planner나 전체 대화/로어의 추가 주입은 없어요. 도구를 사용하지 않는 기존 번역도 그대로 가능해요.

- `knowledge`는 번역에 한해 frozen profile의 봇·페르소나·작가 사실·용어집도 검색/읽을 수 있어요. 기존 bot/persona/canon/glossary 기본 문맥은 유지해요. 자료 읽기는 revision/hash/sourceKind와 범위를 반환해요.
- `story`는 원래 Run snapshot의 전체 ancestry 원문을 검색/읽어요. 마지막 두 원문 밖의 자료도 조회하며, 인덱싱이 꺼져 있어도 원문 검색이 가능해요. 기억이 없으면 `memory.search`는 빈 결과를 반환해요.
- `memory`는 snapshot의 검증된 기억만 사용해요. 작가 선언·관측·추론·인물 믿음의 kind 및 actor, 근거 source/hash/range를 기존 조회 구조로 유지해요. 현재 DB의 나중 기억을 가져오지 않아요.
- `translation`은 작업 실행 시작 시 원래 ancestry의 source/hash에 일치하며 현재도 유효한 최신 완료 번역을 검증해 분리된 표현 참고로 고정해요. 검색은 과거 원문과 번역 양쪽에 적용하므로 영어 인명으로 한국어 번역을 찾을 수 있어요. 검색에는 본문을 넣지 않고 ID/번역 revision/hash/원문 revision/hash/수동 여부/길이를 반환해요. 읽기는 `wording-reference-only`와 범위를 반환해요.
- 미래 원문, ancestry에 없는 분기, 다른 채팅, 원문 수정 후 hash가 달라진 번역, 실패/부분/손상 번역은 참조 대상이 아니에요. 수정 전 Run의 원문/기억은 그 Run에 고정된 과거 버전으로 읽어요.
- `referencePolicy`는 현재 원문·작가 사실·용어집 우선, 과거 번역의 호칭/문체 참고 용도, 시점별 지식 구분, 빈 검색 처리와 조회 예산을 별도 필드로 전달해요. 사용자가 지정한 전체 프롬프트는 빈 문자열/공백을 포함해 원문 그대로 유지해요.

## 예산과 기존 실행 계약

과거 번역 검색은 페이지당 최대 50개, 읽기는 최대 4,096 UTF-16 code unit이에요. 기존 원문/기억 조회는 최대 24,000바이트 응답 한도를 유지해요. 번역 작업의 한 실행에서 도구 이벤트 누적 96,000 UTF-8 바이트를 넘으면 다음 모델 요청 전에 `TOOL_CONTEXT_BUDGET_EXHAUSTED`로 종료해요. 이는 고유 조회 이벤트의 누적 한도이며 반복 전송까지 합산한 실제 토큰/비용 한도는 아니에요. 모델 호출은 기존 작업의 `maxCalls` 한도를 공유해요.

권한 밖 읽기는 기존과 같이 실패로 종료하고 자동 재시도하지 않아요. 빈 검색은 정상 결과로 다음 번역 요청에 전달해요. 연결 권한은 매 provider 요청 재검사해요. 요청 전 attempt 기록, 완료 chunk 유지, owner/generation, 원문/hash, CAS와 최신 번역 한 슬롯은 기존 경로를 사용해요. 번역 보기 요청 전 예약하지 않으며 직접 저장은 모델을 부르지 않아요. 거절/정상 종료된 빈 응답/검증된 구조 실패만 기존 제한 안에서 재시도하고 불확실 실행은 자동 재생하지 않아요.

## 검증 및 측정

새 임시 SQLite와 OS가 배정한 loopback 포트를 사용했어요. 사용자 DB는 사용하지 않았어요. UI 변경이 없어 브라우저/profile 검증은 실행하지 않았어요.

| 검사 | 결과 |
| --- | --- |
| `npm run check` | PASS |
| `npm run build` | PASS, build identity `9515046a1772274aa2050e89d959a82a59ea4df7fee859a58097e3dc297519e6` |
| 관련 Vitest 9개 파일 | 74/74 PASS, 실패/skip 0 |
| 신규 번역 문맥 검사 | 7/7 PASS (위 74개에 포함) |
| `git diff --check` | PASS |

재현 명령:

```powershell
npm ci --offline --no-audit --no-fund
npm run check
npm run build
npx vitest run tests/translation-context.test.ts tests/translation-continuity.test.ts tests/translation-auto-retry.test.ts tests/product-auxiliary.test.ts tests/source-editing.test.ts tests/story-context.test.ts tests/custom-prompts.test.ts tests/sol-runtime.test.ts tests/context.test.ts --reporter=default --reporter=json --outputFile=output/playwright/translation-context-20260907/regression.json
```

최초 테스트 실행은 Windows `spawn EPERM`으로 시작하지 못했으며 승인된 로컬 재실행에서 실행됐어요. 초기 개발 검사에서 사용자 프롬프트에 조회 안내를 덧붙인 것이 기존 계약과 충돌해 2개가 실패했고, 안내를 별도 `referencePolicy`로 분리한 후 통과했어요.

합성 HTTP/tool/SQLite 사례는 세 차례 요청(검색 → 읽기 → 번역), 6개 도구 이벤트, 조회 이벤트 총 **3,206바이트**, 작업 실행 **30.85ms**였어요. 단일 로컬 fixture 관측값이며 성능 개선율이나 실제 provider 지연을 뜻하지 않아요. 과거 한국어 호칭을 읽은 사실 및 고정된 합성 응답 저장을 검사했으며 모델이 의미를 이해했는지 평가하지 않았어요.

로컬 증거:

- [회귀 JSON](../output/playwright/translation-context-20260907/regression.json)
- [측정 JSON](../output/playwright/translation-context-20260907/measurement.json)
- [도구 이벤트](../output/playwright/translation-context-20260907/tool-events.json)
- [합성 SQLite 백업](../output/playwright/translation-context-20260907/evidence.sqlite)

`output/`은 Git에 포함되지 않으며 이 작업트리에서 확인하거나 위 명령으로 다시 생성해요.

## 한계와 통합 주의점

실제 모델의 번역 품질, 문체/인명 일관성 개선, 다국어 의미 품질은 평가하지 않았어요. 추가 외부 호출은 0회예요. 기본 검색은 문자열 기반이므로 의미 검색이나 복잡한 별칭 추론은 보장하지 않아요. 전체 로어/대화 본문을 모델에 넣지는 않지만 현재 서버는 실행 시작 시 ancestry의 완료 번역을 검사해 메모리에 고정하므로 매우 긴 이력의 DB 조회 비용은 별도 측정 대상이에요.

과거 번역의 버전은 원문 생성 시점이 아니라 해당 번역 작업 실행 시작 시점에 선택돼요. 같은 실행에서는 고정되지만 사용자의 명시적 재시도에서는 그때 유효한 최신 표현 참고를 다시 선택할 수 있어요. 완료 chunk는 다시 쓰지 않아요. 과거 번역은 새 사건이나 작가 사실로 승격하지 않는다는 정책과 출처를 전달하며 모델의 의미적 준수를 호스트가 증명하지는 않아요.

히든 스토리는 원문 바이트를 보존해 조회하며, `referencePolicy`가 인물 지식으로 승격하지 않도록 안내해요. 구조화 시점/가시성 메타데이터와 role/prompt UI는 native 담당 범위로 남겼어요. 구조화 지식 경계를 구현한 것으로 주장하지 않아요.

통합 인터페이스는 `AuxiliaryBundle.translationReferences?`, `AuxiliaryInput.referencePolicy?`, `executeStoryRead(snapshot, action, allowWithoutMemory=false)`예요. 기존 두 인자 호출과 main의 memory-disabled 권한은 유지해요. 변경 파일은 `core/auxiliary.ts`, `core/provider.ts`, `core/story-context.ts`, 신규 `core/translation-context.ts`, `server/product-auxiliary.ts`, `server/auxiliary-bridge.ts`, 신규 `server/translation-context.ts`, 신규 `tests/translation-context.test.ts`예요. native 담당과 해당 공용 파일의 변경을 통합할 때 추가된 필드/도구 dispatch를 보존해야 해요. DB schema 변경은 없어요.
