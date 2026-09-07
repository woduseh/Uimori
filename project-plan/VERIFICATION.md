# Agent DX와 완료 계약 v0.6.1

## 1. 원칙

완료 주장 → 재현 입력 → 독립 기대값 → 실제 검사 → 해당 코드/환경의 증거 → 남은 한계를 연결한다. 문서 개수·test count·agent 자신감이 완료 근거가 아니다. ACCEPTANCE는 요구 명세이며 실제 충족 여부는 [CURRENT](CURRENT.md)와 연결된 실행 결과에서 확인한다. 로컬 PASS와 남은 live/품질/실제 휴대폰 BLOCKED를 구분한다.

빠른 반복에서는 가까운 검사, milestone 완료에서는 필수 통합·브라우저·빌드 검사를 수행한다. 이미 충족한 검사를 이유 없이 되풀이하거나 새 불변 조건 없이 테스트를 양산하지 않는다. 검증기 자체는 기존 Vitest/Playwright reporter와 작은 Node 수명주기 스크립트로 시작한다. 별도 검증 프레임워크를 만들지 않는다.

## 2. 네 층의 주장

1. scripted MockProvider: 앱의 저장/실행/도구/파생 작업 경계 검증. 모델의 자발적 선택을 증명하지 못한다.
2. loopback fake provider: 실제 HTTP/SSE bytes→fetch/decoder/adapter를 통과. live 서비스 지원 증거는 아니다.
3. live provider smoke: 승인된 endpoint/model/adapter revision의 실제 왕복. 모든 모델/요금/소설 품질 증거는 아니다.
4. live quality와 사용자 평가: 로어 선택·번역 의미·상태 추출·문체를 반복 비교한다. 저장·권한의 정확성은 LLM judge에게 맡기지 않는다.

브라우저 emulator, Windows native 실행, 실제 휴대폰 잠금은 각각 결과를 기록한다. 한 검사가 다른 환경을 보장한다고 말하지 않는다.

## 3. 실행 계약

현재 명령은 npm 기준이다: `npm run doctor`, `npm run dev`, `npm run check`, `npm run build`, `npm run verify -- --milestone M0`, `npm run verify:selftest`. 선택 검사는 `npm run verify -- --milestone M0 --case F01,F02`처럼 milestone에 속한 case만 지정한다. 지원 milestone은 `M0`, `M1-local`, `M1`, `M2-local`, `M2`다. 추가 UI/provider/native/self-host 검사는 [개발 안내](../docs/DEVELOPMENT.md)와 `package.json`을 따른다. setup/install 단계와 daily dev를 분리하고 dev 때 전체 재설치를 강제하지 않는다.

Doctor는 버전 문자열 외에도 임시 SQLite transaction, 쓰기 경로, localhost bind, Playwright 실제 launch와 페이지 접근을 확인한다. 기본 paid provider 호출은 없다. node_modules가 있어도 native driver/browser가 동작한다는 보장은 없으므로 기능 시험을 한다.

준비 → 서버 시작/ready 확인 → 검사 → 실패 원인/증거 → 종료/정리를 연결한다. 멈춰 있는 서버/다른 worktree를 재사용해 잘못된 버전을 검증하지 않는다. 포트는 실제 bind 결과를 전달하고 필요한 충돌 재시도를 한다. 경합은 임의 sleep만으로 시험하지 않고 barrier로 재현한다.

각 실행의 writable DB, assets, mock state, browser profile, 로그·temp를 분리한다. 자신이 시작한 process/path만 정리한다. `killall`, 광범위 포트 종료, 사용자 디렉터리의 `git clean -fdx`는 사용하지 않는다. 정상·실패·timeout·취소·다음 실행의 orphan 진단도 확인한다.

Git worktree는 repo와 기준 commit이 준비된 뒤 사용한다. 한글/공백 경로와 Windows process 종료를 포함하고 line ending 정규화 정책을 정해 source fingerprint가 자기 출력/줄바꿈 변환으로 계속 바뀌지 않게 한다. 새 프로젝트의 의존성/비공개 파일이 자동으로 worktree에 복사된다고 가정하지 않는다. 소스가 없는 빈 구조이면 로컬에서 먼저 만든다. 사용자 git identity를 발명하거나 전역 설정을 바꾸지 않는다.

## 4. 의미 있는 검사

모델 출력 fixture를 쓰더라도 실제 제품 UI→HTTP→파일 SQLite→다음 모델 입력을 관통한다. Inspector에 표시되는 것과 실제 전송한 request가 일치해야 한다. 저장 성공 로그가 아니라 재시작 후 DB 읽기를 확인한다.

프롬프트의 기대값을 같은 production compiler로 다시 만들지 않는다. 작은 독립 golden과 field/role/order invariants를 둔다. 역할·범위·캐시 변환의 미지원을 조용히 무시하지 않는다.

스트림은 UTF-8 중간 바이트, tool 인수 조각, 여러 call ID, refusal, summary, usage 부재, terminal 없는 EOF, 취소, partial 이후 실패를 포함한다. 비공개 추론 원문을 증거로 요구하지 않는다. 공개 summary와 실제 tool event만 충분하다.

이번 보조 상태 처리의 결정적 시험은 지연/중복/순서 뒤집기/실패, source 수정, 분기 전환, stale parent state, 다음 턴 barrier, 표시-only 실패시 읽기 유지다. source/span ID가 실제 존재하는지와 계산 규칙은 코드로 검증한다. span이 해석을 뒷받침하는지는 별도 의미 평가다. M0의 F05에는 원문·job 예약 트랜잭션의 중간 실패와 커밋 직후 worker 실행/알림 전 프로세스 종료를 포함한다. 재시작 후 예약이 남고 원문 생성은 다시 호출되지 않으며, 중복 완료를 보내도 같은 결과가 중복 반영되지 않아야 한다. 모의 공급자만으로 이 경계를 시험한다.

## 5. 상태와 최소 증거

`PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, `SKIPPED`, `FLAKY`를 구분한다. required 여부는 별도 속성이다. 필수 검사에서 PASS 외 상태가 있으면 그 완료 주장은 미입증이다. 범위 밖 미래 시나리오는 실패나 합격으로 세지 않는다. 기존 실패는 기준 재현과 이번 영향 여부를 보고하며 숨기지 않는다.

최소 `summary.json`: 완료 범위, source/build identity, OS/runtime/browser, 명령/종료코드, 실제 발견/실행/skip/실패 건수, 시나리오 결과, 증거 경로, 공백. test reporter 결과와 연결한다. 에이전트가 손으로 PASS를 작성하는 장부로 대체하지 않는다.

실행 입력의 source/config/lock/fixture fingerprint를 기록하고 실행 중·이후 변경이 있으면 필요한 검사를 다시 한다. hash는 입력 식별이지 진실의 보증서가 아니다. 모든 byte/event를 매번 dump하지 말고 실패에 필요한 좁은 trace와 최초 오류를 제공한다.

## 6. 실패를 감지하는 검증기

격리 child suite에서 assertion failure/exit1, zero matching tests, required skip 또는 report 누락, stale server/report, timeout/cleanup failure를 재현한다. 내부 verify는 nonzero/FAIL 또는 BLOCKED여야 한다. 외부 selftest PASS는 ‘실패를 감지했다’는 뜻이며 제품 PASS에 합치지 않는다.

알 수 없는 case/milestone은 오류다. 미구현 check를 echo/placeholder/자동 skip으로 통과시키지 않는다. 필수 검사를 삭제·완화해 성공으로 만들지 않는다. 기대값/범위/CI 계약의 정당한 변경은 변경 이유와 실제 영향을 남긴다.

초기 핵심 E2E retry0을 기본 후보로 삼고, 진단 재시도시 첫 실패를 보존한다. flaky는 해결 또는 명시적 blocker이며 결과에서 지우지 않는다. 광범위 mutation testing은 선행 조건이 아니다.

## 7. 모델·품질 평가

정답 lore ID를 모델에게 주지 않는 작은 고정 코퍼스를 사용한다. mandatory/prefetch로 이미 전달한 사실은 재검색하지 않아도 맞출 수 있어야 한다. substring 부정, 한국어 조사·별칭, 다른 분기, 오래된 사실, 적법한 새 창작을 분리한다.

translation은 의미/주체/불확실성/호칭/한국어 문체와 protected syntax를 따로 본다. 상태 추출은 추출 누락, 무근거 신규 사실, invalid enum, 잘못된 증가, 거절/단절 원고, 허용된 annotation 구분을 평가한다. 적은 양으로 먼저 확인하고 장문·장기 평가로 확장한다.

일상 장면, 평범한 관계 발전, 행동·능력 규칙, 복잡한 세계관을 분리해 균형을 맞춘다. 기존 만족 사례 한 편으로 스타일을 고정하지 않는다. 새 Léman 파일의 본문에 이미지 참조와 끝 상태 토큰이 함께 들어 있음을 확인했다. Nakamura 파일은 .crdownload 확장자이지만 JSON 파싱/risuChat 구조가 확인됐다. 이것을 두 원문 전체의 문학적 품질 분석이나 원래 대화 전체의 완전성 검증으로 확대하지 않는다. 철회된 불만 파일은 사용하지 않는다. 공개 fixture는 비노골적 합성 자료다.

동일 조건 paired 비교, 반복 n, 전 실패, 비용·지연·문체를 보고한다. 문장 완전 일치나 도구 호출량을 품질 대리 지표로 삼지 않는다. 모델 judge도 틀릴 수 있으므로 사용자 취향 수용은 별도다. 새 코드·실패·공백이 없는 상황에서 반복 채점 루프를 무한 수행하지 않는다.

### 모델 주도 선택과 보조 표현의 추가 판정

순수 모델주도/작은prefetch+자율탐색/전체참조 또는 기존키워드 baseline을 조건이 허용하는 범위에서 비교한다. 다른 모델/컨텍스트/출력 길이를 섞어 조회 전략의 효과로 단정하지 않는다. 정해진 tool 순서와 호출 수가 아니라 필요한 사실 준수, 불필요 자료/조회, 선택·작성 품질, 비용·시간을 평가한다. 새로운 모델도 동일한 결과 계약으로 비교하며 자동 자율성 상향이나 효과를 보장하지 않는다.

검색 결과 밖의 관련 자료를 후속검색/목록/연관ref로 발견하는지, prefetch를 끄거나 miss시켜도 길이 열려 있는지, 불필요한 검색 없이도 완료하는지 확인한다. pinned facts는 포함되며 lazy facts도 같은 사실 의미를 가진다. loading mode를 instruction authority나 DB 접근권한으로 오해하면 실패다.

메인 요청에 이미지 전체 catalog·상태 HTML/format·번역 절차가 누출되지 않는지 실제 request를 검사한다. 보조 역할에는 해당 schema·기존 state·허용 asset 정보가 있어야 한다. 이미지 annotation의 잘못된 ID/anchor/source는 프로그램이 거절하고 적합성은 live-quality에서 따로 판단한다. 원문 hash가 이미지선택/재번역 뒤에도 그대로인지, 번역 블록에 연결된 표시가 원문 사건으로 재주입되지 않는지 시험한다. 직렬화한 명세가 유효한 것과 실제 scene에 맞는 선택은 다르다.

## 8. 승인과 개인정보

기본 추가 앱/API 유료 시험 예산은0이다. Codex 자체 사용과 제품 API 평가 비용을 구분한다. live 시험은 사용자가 지정/승인한 provider/모델/합성 또는 허용 데이터/전체금액·요청수/유효 작업범위에서 진행한다. 한 번 승인된 동일 범위의 매 호출마다 중복 확인하지 않는다. 필요한 예산이 없으면 local/fixture 구현은 계속하고 live claims만 BLOCKED로 남긴다.

실제 사용자 파일·prompt·secret은 CI에 넣지 않는다. 기록 전에 허용 필드만 직렬화하고 auth/cookie/error echo를 제한한다. dummy canary로 누출을 검사해도 모든 임의 비밀 마스킹을 보증하지 않는다. 테스트 control endpoint를 production에 노출하지 않는다. network 접근이 막히면 권한을 우회하지 않고 필요한 최소 허용과 남은 검증을 구분한다.

## 9. agent 협업과 작업 종료

### M2 로컬 실행

`npm run verify -- --milestone M2-local`은 S01–S07의 실제 Vitest reporter, 브라우저 원문/상태/예약/에셋 검사, S07 네 가지 크기 축 측정을 새 포트·SQLite에서 실행한다. 결과는 `output/playwright/m2-<run-id>/summary.json`, `story-performance.json`, reporter/화면/DB에 기록한다. source/build 변화, 필수 skip·0개·실패·근거 누락·cleanup 실패는 성공이 아니다. 환경 doctor 실패는 BLOCKED로 구분한다.

`--milestone M2`는 같은 로컬 범위를 실행한 뒤 Q04의 실제 장기 의미 품질·비용 및 지정된 봇의 승인된 native 포팅이 남아 있으면 BLOCKED로 종료한다. M1의 기존 유료 시험 예산은 새로운 M2 평가의 승인을 대신하지 않는다. 현재 합성 모듈은 Lua/CBS 실행 호환이나 실제 사용자 봇 대체의 근거가 아니다.

기본 한 lead와 별도 검토 pass. 병렬화가 실제 대기를 줄이거나 오류 탐지에 도움이 될 때 한정된 경계를 나눈다. contracts/lockfile/migrations/전역 test config는 한 담당자가 통합한다. 검토자는 안심 문구보다 요구 누락·false oracle·race·secret·test weakening 반례를 찾는다. 독립 reviewer 부재면 그 한계를 알린다.

통합한 최종 revision에서 필요한 검사만 다시 실행한다. merge 권한/브랜치 보호/CI 정책을 편의상 낮추지 않는다. 실제 코드 검증과 무관한 대규모 slop audit/refactor는 별도 범위로 남긴다.

CURRENT에는 코드 기준, 완료/막힌 주장, 명령·증거, 다음 한 단계, 승인 대기를 남긴다. 긴 사고 기록은 저장하지 않는다. 안전한 범위 내 계획·코딩·테스트·수정은 실행하고 일반 선택마다 질문하지 않는다. 완료한 milestone 다음의 유료/배포/새 제품 범위까지 자동 확장하지 않는다.
