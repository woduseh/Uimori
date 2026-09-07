# 장기기억 평가 하네스 · 2026-09-07

로컬 평가 하네스 구현과 관련 검증을 완료했어요. **Q04 실제 모델의 장기 의미·요약 품질·비용 평가는 실행하지 않았으며 BLOCKED를 유지해요.** 제품 코드·DB schema·상시 요약 정책은 변경하지 않았어요.

작업 경로는 `C:/Users/wodus/.codex/worktrees/384e/uimori`, 기준 HEAD는 `51e51967503dd9de9f765c0702210a360adde674`예요. 원래 루트의 `project-plan/NATIVE-PORTING.md`는 읽기만 했어요. native 담당에게 파일 범위와 인물별 지식 경계의 현재 한계를 전달했어요.

## 기존 M2가 입증한 범위

[기존 M2 결과](M2-RESULTS.md)의 S07은 활성 source **6개** 중 단일 오래된 원고를 **10,000 → 200,000자**로 늘리고 페이지 회수·문맥 준비 등을 확인했어요. 장기간 분산된 사실을 모델이 이해·추출·회수하는 20만 **토큰** 의미 평가가 아니에요. 기존 문서도 Q04를 BLOCKED로 표시하고 있어요.

이번 하네스는 [production memory](../core/memory.ts)와 [story context 도구](../core/story-context.ts)를 직접 사용해요. DB persistence·retcon·archive/fork 계약은 기존 [기억 저장 회귀](../tests/story-memory.test.ts)와 [archive 회귀](../tests/story-archive.test.ts)를 별도로 실행했어요. 긴 corpus runner 자체는 순수 core 경로이며 DB·HTTP·브라우저·provider를 실행하지 않아요.

## 자료와 정답

[생성기·채점·preflight](../scripts/memory-evaluation-data.mjs), [CLI](../scripts/memory-evaluation.mjs), [채점 실패 탐지 검사](../scripts/memory-evaluation.test.mjs)를 추가했어요. 버전 1 자료는 영어 합성 기록이며 개인 작품을 포함하지 않아요.

최종 corpus hash: `34718275a56ecff302cbbeed42faa77e1d884619b4478f382f3c2e09d950b097`.

| 규모 | 이번 실행 |
| --- | ---: |
| main source 수 | 277 |
| source 본문 UTF-16 code units | 722,339 |
| source 본문 Unicode code points | 722,339 |
| source 본문 UTF-8 bytes | 722,339 |
| 토큰 추정: code units ÷ 4 올림 | 180,585 |
| 실제 모델 tokenizer 토큰 | **null / 미측정** |
| 작가 선언 | 2개: 과거 선언과 retcon |
| main에서 제외할 sibling source | 1개 |
| 분산된 중요 근거 / 질문 | 10개 / 10개 |

규모는 main 본문만 세며 metadata·정답·작가 선언·다른 분기를 포함하지 않아요. CLI의 `--target 150000..200000`도 **추정 목표**이며 마지막 source 단위로 초과할 수 있어요. 실제 15만~20만 토큰이라는 주장은 tokenizer 확인 전에는 할 수 없어요.

각 source에는 서로 다른 번호·수량·지역·사물·행위·증인·예정일을 가진 8개 기록이 있어요. 8명(유사 이름 3명 포함), 8개 장소/사물/행위를 조합하고 중요한 근거를 scene 1~199에 분산했어요. 단일 문서 반복은 아니지만 문장 틀이 있는 합성 스트레스 자료이므로 실제 한국어 장편 창작의 다양성이나 난도를 대표하지는 않아요. transcript 순서, 현재 story day, 회상 속 사건 날짜를 구분해요. source의 참가자 목록이 모든 사실의 지식 소유권을 뜻하지 않으며 각 사건의 증인·비공개 예외를 본문에 명시해요.

| 평가 항목 | 자료·판정 방식 |
| --- | --- |
| 오래된 사실 | 초기 key 보관 장소와 원문 좌표를 후반에서 회수 |
| 여러 인물·유사 이름 | Mira Vale/Vail의 서로 다른 도구를 이름과 결합해 채점 |
| 사건 순서 | 서로 떨어진 두 근거에 있는 day 12/19/23 사건 순서 |
| 변경된 사실 | 과거 access code와 현재 code를 분리, 현재 답의 옛 code를 오염으로 집계 |
| 작가가 선언한 과거·retcon | 원문 없는 declaration ID를 인용, retcon 전/후 별도 질문 |
| 다른 분기 | sibling 비밀의 검색 0건·직접 읽기 거부, main 질문은 unknown |
| source 수정 | scene-121 내용을 수정하고 hash 변경; 기존 기억 제외·watermark 후퇴·tail 차단 |
| 인물별 비공개 지식 | Neri만 아는 invoice를 Mira 관점에서 unknown으로 답해야 함 |
| 충돌·불확실성 | Tavi의 north 믿음과 Sera의 south 믿음을 함께 보존하고 unresolved 명시 |
| 근거 정확성 | revision/hash/start/end/quote 또는 declaration ID를 정답과 정확히 비교 |

정답은 사람이 작성한 fixture이며 source에서 정확한 좌표와 hash를 산출해요. `sources.jsonl`, `questions.json`, 선택한 `declarations.json`만 모델 입력에 사용하고 **정답 포함 `corpus.json` 및 `oracle-answers.json`은 보내지 않아요.**

## 실행한 결과

최종 [로컬 summary](../output/memory-evaluation/2026-09-07T04-18-23.355Z-local/summary.json), [corpus](../output/memory-evaluation/2026-09-07T04-18-23.355Z-local/corpus.json), [채점 CLI self-check](../output/memory-evaluation/2026-09-07T04-18-41.760Z-score/summary.json)를 남겼어요. `output/`은 Git 제외이므로 다른 checkout에서는 다시 생성해야 해요.

| 검사 | 결과와 해석 |
| --- | --- |
| 10개 중요 근거의 production search/read | 10/10 회수, 정확한 본문·hash 확인. 정답에서 만든 정확 검색어를 사용한 기계적 회수예요. |
| 문맥에서 생략된 초기 기억 검색 | 1건 회수. 모델이 자율적으로 검색어를 선택했다는 증거는 아니에요. |
| sibling source | 검색 0건, 직접 읽기 거부 |
| source edit | 해당 기억 무효화; checkpoint 121까지 후퇴; 필수 tail이 24,000자 제한을 초과해 ready=false |
| checkpoint 중간 누락 | scene-28 receipt 제거 시 28개까지만 연속 완료로 인정 |
| 위조 quote | validation 거부 |
| 로컬 도구 결과 크기 | 24개 호출 모두 24,000bytes 이하 |
| 채점기 oracle self-check | 답 atom 회수 1.0, 금지 atom 오염 0, 근거 precision/recall 1.0, 10/10. **의미 품질 수치가 아니에요.** |
| 하네스의 실패 탐지 | 4/4 PASS: 누락·잘못된 이름 결합·순서·비밀 오염·위조/중복 근거·승인/토큰/예산 불충족 |
| 기존 memory/story-memory/story-context/story-archive 회귀 | 31/31 PASS, 실패·skip 0. [reporter](../output/memory-evaluation-regressions.json) |
| TypeScript / build | `npm run check`, `npm run build` PASS |
| 외부 모델 | 0회. local runner의 fetch 시도 0; provider/auth 모듈·자격 증명·네트워크 클라이언트를 사용하지 않아요. |
| usage / 비용 | inputTokens=null, outputTokens=null, costUsd=null, pricingBasis=null |

기본 샌드박스에서 Node test와 build가 `spawn EPERM`으로 차단됐어요. Node test는 `--test-isolation=none`, build와 Vitest는 승인된 로컬 실행으로 통과했어요. 첫 실행 차단을 제품 실패로 판정하지 않았어요. 기존 DB 회귀는 자체 임시 파일 SQLite를 사용했고 사용자 DB·포트·profile은 사용하지 않았어요.

### 문맥과 지연 측정

oracle 중요 기억 10개, source마다 첫 기록에서 만든 결정적 derived-summary 277개, 현재 작가 선언 1개를 넣었어요. 이 **288개 기억은 모델 추출/요약 결과가 아니에요.** 실제 요약의 정보 손실·허위 정보는 아직 평가하지 않았어요.

| 측정 | 결과 |
| --- | ---: |
| 입력 packet | 23,742자 / bytes, 추정 5,936토큰 |
| 최근 원문 | 2개 |
| packet에서 생략된 기억 | 268개 (검색으로 접근 가능) |
| 순수 core context 계획 warmup | 1회 |
| 측정 5회 ms | 182.3201, 180.1556, 177.0377, 173.6696, 172.2015 |
| median / nearest-rank p95 | 177.0377 / 182.3201 ms |
| memory.search 1회 / memory.read 1회 | 171.95 / 171.74 ms |
| story.search 11회 / story.read 11회 합계 | 7.18 / 6.06 ms |

Node v24.14.0, Windows 10.0.26200, Ryzen 7 7800X3D에서 실행했어요. 5개 표본의 p95는 최대값이며 다른 프로세스 부하를 통제하지 않았어요. DB 이력 읽기·메인 프롬프트 전체 조립·모델·UI 지연을 포함하지 않아요. 회귀 기준은 정확성이고 시간의 상대 개선을 주장하지 않아요. 기억마다 ancestry 검증을 하는 현재 경로가 이 규모에서 비용을 가질 수 있지만 이번에는 엔진 최적화를 범위 확장하지 않았어요.

### 인물별 지식 경계

`character-belief.actor`는 `Neri Moss`로 보존됐지만 narrator의 `memory.read`에서는 해당 private 기억이 반환돼요. 현재 scope는 **chat와 source ancestry 경계**이며 actor별 ACL이 아니에요. narrator가 다른 시점의 사건을 다룰 수 있다는 계약과 맞을 수 있으므로 이를 임의로 접근 차단하도록 수정하지 않았어요. Mira가 이 정보를 알고 행동하지 않는지는 실제 모델의 의미 평가가 필요해요. native hidden-story 구현 담당에게 이 경계를 전달했어요.

## 재현 명령

배정된 checkout에서 실행해요. local/preflight/score는 실행마다 새 `output/memory-evaluation/<timestamp>-<mode>/`를 만들어요.

```powershell
npm ci --offline --no-audit --no-fund
npm run build
npm run check
node --test --test-isolation=none scripts/memory-evaluation.test.mjs
node scripts/memory-evaluation.mjs local --target 180000
npx vitest run tests/memory.test.ts tests/story-memory.test.ts tests/story-context.test.ts tests/story-archive.test.ts --reporter=json --outputFile=output/memory-evaluation-regressions.json
node scripts/memory-evaluation.mjs preflight --target 180000
node scripts/memory-evaluation.mjs score --target 180000 --answers output/memory-evaluation/<local-run>/oracle-answers.json
```

설정 없는 preflight는 의도한 **BLOCKED/nonzero**예요. `--execute`는 지원하지 않고 거부해요. 최신 [무과금 preflight 결과](../output/memory-evaluation/2026-09-07T04-18-41.511Z-preflight/summary.json)는 호출 0·비용 null·최소 기본 호출 297회로 기록했어요. 이 수치는 실행 허가가 아니며 실제 도구 왕복·retcon 재추출·재시도·실패는 추가예요.

## 미실행 실제 모델 평가와 후속 조건

생성된 `evaluation-protocol.json`에 main-only와 memory-assisted 입력, 질문별 선언/관점, 답변 schema, 수동 검토 항목을 담았어요. `approval-template.json`에 다음 조건을 채운 뒤 `preflight --config <file>`로 무과금 검사해요.

1. 중단된 품질 평가의 **명시적 재개 승인**과 승인 참조, 정확한 corpus hash, 합성 자료 한정.
2. provider·정확한 모델/버전. 해당 모델 tokenizer로 corpus 본문의 실제 150k~200k 토큰 및 측정 방법 확인. 현재 추정치만으로 이 조건을 통과하지 못해요. 가격/토큰 attestation은 입력 형식을 검사하며 이 하네스가 외부 출처의 진위를 검증하지는 않아요.
3. 총 maxCalls·maxUsd·호출별 최대 input/output token. main-only 10답 + 보조 추출 최소 277회 + memory-assisted 10답 = 기본 최소 297회이며, 실제 호스트 snapshot의 반복 이력·도구 왕복·실패까지 포함해 별도로 상한을 잡아요.
4. 날짜 있는 공식 단가 근거. 보수적 예약은 `maxCalls × (maxInputTokensPerCall × inputRate + maxOutputTokensPerCall × outputRate) / 1e6`이며 maxUsd 초과 시 차단해요. 실제 요청 조립 토큰은 별도로 세어 model/승인 한도에 맞춰야 해요. 할인·cache·Flex를 임의로 가정하지 않아요. 실제 청구 근거 없는 costUsd는 null을 유지해요.
5. 승인 후 실제 실행 연결은 기존 StoryStore/StoryRunner의 권한 재검사·attempt 선기록·누적 예약·취소·owner/generation 계약을 사용하는 후속 작업이에요. **이번 CLI에는 live 실행 adapter가 없어요.** preflight READY_FOR_REVIEW는 자동 실행이나 승인 획득을 뜻하지 않아요. 불확실/중단 attempt를 재실행하지 않고 새 승인/명시적 복구를 요구해요.
6. main-only는 선택한 원문 ancestry 전체를, memory-assisted는 실제 추출 후 production packet과 scoped tools를 사용해요. 과거 선언 질문은 original canon, retcon 질문은 replacement canon을 사용하고 필요하면 분리된 DB fixture에서 재구축해요. oracle 기억을 quality 실행에 주입하면 안 돼요.
7. 각 arm의 답을 schema에 맞춰 저장한 뒤 `score --answers <file>`로 독립 채점해요. 모델명·corpus hash·arm과 per-attempt usage를 보관하고 추출/답변/도구/재시도/불확실 호출 비용을 분리해요. 채점 CLI는 입력 usage를 검증된 provider 사용량으로 승격하지 않아요.

현재 자동 채점은 정해진 atom·금지 atom·순서·정확한 근거를 검사해요. 자유로운 바꿔쓰기에는 false negative가 있을 수 있고, 정답 atom에 추가한 임의 허위 문장 전체를 탐지하지 못해요. 따라서 summary의 누락/허위 사실, 이름-값 귀속, 갈등/불확실성 보존, private 지식을 사용한 행동과 근거의 의미적 타당성을 source와 대조해 수동 검토해야 해요. 자동 점수가 1.0이어도 Q04 PASS로 바꾸지 않아요.

## 통합 주의점

변경은 `scripts/memory-evaluation*.mjs` 3개와 이 결과 문서뿐이에요. package script·제품 코드·공용 계획 문서·원래 루트는 수정하지 않았어요. native 통합 후 memory API가 바뀌면 local runner의 production 함수 호출과 protocol만 맞추고 기준 corpus/hash를 보존하거나 명시적으로 version을 올려요. 제품 변경을 포함하지 않으므로 이 작업 때문에 새 상시 요약 호출이나 비용은 발생하지 않아요.
