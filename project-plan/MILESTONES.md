# 구현 순서와 범위 v0.6.1

> 2026-09-07 읽는 기준: 아래는 단계별 인수 요구와 당시 구현 순서이며 현재의 할 일 목록이 아니다. 실제 완료/미완료는 [CURRENT](CURRENT.md), [M1-RESULTS](M1-RESULTS.md), [M2-RESULTS](M2-RESULTS.md)를 따른다. 현재 DB/archive v8은 새 DB만 초기화하고 구형 DB migration을 제공하지 않는다. 개인 self-host는 별도 후속 구현으로 추가됐고 실제 Linux/Docker/휴대폰 검증은 남아 있다([SELF-HOST-RESULTS](SELF-HOST-RESULTS.md)). 자료별 전용 변환기 대신 [범용 이식 가이드](../docs/RISU-PORTING.md)를 사용한다.

이 파일의 M0/M1/M2/M3는 과거 A0/A1/A2 및 A01 같은 acceptance ID와 혼동하지 않기 위한 새 milestone 이름이다. 이전 검증 목적은 ACCEPTANCE의 `legacy_ids`로 추적한다. 테스트 숫자나 파일 수를 강제하지 않는다.

## M0 — 첫 착수 작업: 작은 제품과 검증 루프

**결과:** API 키 없이 두 브라우저에서 작은 앱을 열어 각자 요청하고, 한쪽을 닫았다 돌아와 같은 원고와 파생 결과를 본다. 지연된 보조 결과/명시적 실패/서버 재시작을 실제로 재현하고 검증 명령이 이를 정확히 판정한다.

구현할 것:

- Windows 실제 환경 확인, 짧은 설치/실행/검사/정리 명령, 파일 SQLite+migration, 작은 mobile-width React UI, 서버 소유 Run.
- chat별 minimal preset snapshot, parent/source revision, idempotency/expected revision, 출력·오류·usage 구분.
- 최소 역할별 context 구성(고정 계약/목록/도구 결과)을 갖추고, 실제 지식 search/read/skill-load 경로를 쓰는 scripted MockProvider와 도구 없이 완료하는 mock 경로. 인물/지식 fixture는 작고 합성된 것을 사용한다.
- 원문에 연결된 **모의 번역과 표시용 상태 annotation**의 독립 후속 job을 각각 최소 하나 연결. 원문과 다른 field/table에 저장하고 지연/실패를 표시한다. 원문 확정과 적격한 후속 job 예약은 같은 짧은 DB 트랜잭션에 기록하며, 커밋 직후 재시작해도 예약이 유실되지 않는지 확인한다. 실제 번역·의미 추출 능력이나 게임 상태 계산은 범위 밖이다. 후속 사용자 지시에 따라 번역은 원문 완료가 아닌 번역 보기 요청에서 예약하며, 원문 완료와의 원자적 예약은 상태·이미지에 적용한다.
- 두 chat과 원문 revision에 결과를 붙이는 검증. 화면을 바꿔도 결과는 원래 source에 붙어야 한다. 다른 분기 UI 전체를 만들 필요는 없지만 parent/source id는 지금부터 보존한다.
- 현재 코드와 다른 서버/검사0개/고의 실패/report 누락을 성공으로 숨기지 않는 작은 verify. 기본 reporter를 재사용한다.
- 실제 생성물/화면/SQLite를 확인하고 새 작업트리 또는 근거가 있는 깨끗한 checkout에서 반복한다. 모든 향후 테스트의 stub을 만들지 않는다.

M0 required: **F01–F06**. 합성 번역/상태 결과에는 mock 표시를 해 혼동시키지 않는다. 기본 dependency download 이외 제품/provider egress는 꺼둔다.

M0에서 하지 않을 것: 완전한 페메 이식, 유미 전체 복제, 실모델 유료 호출, 장기기억 extractor, 실모델 이미지 선택·수천 에셋 UI, 범용 플러그인, 로그인/공개배포, 트리 그래프, 대규모 검증 플랫폼. 보안이 갖춰지지 않은 M0을 외부에 열지 않는다.

## M1 — 실제 개인 사용의 첫 경로

한 작업에 몰아넣지 않고, 아래 사용자 흐름 단위로 같은 M1 내 작업을 나눌 수 있다.

1. **M1a 연결과 콘텐츠:** 소형 bot/persona/lore 편집·등록, 기본 Phēmē-native 제어, CreativePreset 저장/교체, 수동 author-canon 텍스트(자동 장기기억과 분리), 선택된 두 작업 경로의 provider adapter/카탈로그/ID 직접 등록/usage, 읽기 도구와 Inspector. 키가 없으면 fixture까지 만들고 live 부분만 남긴다.
2. **M1b 읽기와 보조 처리:** 실제 translation context/보호구문/분할·재시도, 번역 보기에서 시작하는 최신 번역과 원문·번역 직접 수정, 정상 종료된 번역 실패의 제한 자동 재시도, 원문·번역 전환, 표시용 보조 상태 추출/annotation, 기본 profile/inline asset 렌더와 소형 보조 이미지 catalog/search 및 본문 밖 anchor annotation, 원고/번역/표현/상태 각각의 진행·취소.
3. **M1c 보존과 접속:** 선택 장면까지 새 이야기로 복사하는 포크와 독립된 설정·후속 원고, 기존 분기의 읽기 보존, device별 읽기 위치/초안, export/restore, 단일사용자 인증/연결 보호, 승인된 배포 환경에서 실제 폰 재접속.

M1 기능은 P01–P13의 관련 범위를 만족해야 한다. 실제 provider 지원은 L01을 통과한 경로만 주장한다. 실제 모바일 사용은 L02를 따로 기록한다. M1 품질 평가는 Q01·Q02·Q03·Q05의 해당 범위다. Q04의 상태·장기기억 의미 평가는 M2에 속하며 M1 필수 gate로 당겨오지 않는다. M1a/b/c는 선택된 사용자 흐름의 로컬 구현과 관련 live/device 주장을 각각 기록한다. 키·예산·실제 폰 등 외부 전제만 부족하면 해당 주장은 BLOCKED로 남기고, 사용자가 이어가기를 요청한 범위에서 그 전제에 의존하지 않는 다음 로컬 흐름을 진행할 수 있다. 이 경우에도 M1 전체 완료나 실사용 준비 완료로 표시하지 않는다.

M1에서 단순 일상·장면·짧은 연속 작품을 읽는 사용은 가능해야 한다. 자동 장기기억/모든 자작 봇 동작을 대체했다고 말하지 않는다. 실제 두 provider/protocol은 사용자 설정을 먼저 확인해 고르며 특정 미확인 모델 ID를 발명하지 않는다.

## M2 — 긴 작품과 복잡한 봇의 대체

S01–S07을 중심으로 authoritative 상태, 후속 턴 barrier, 분기·retcon·원문 수정의 파생물 유효성, author canon·belief·memory 분리, checkpoint/원문 회수, 장면 command, 상태창·제한된 후처리·에셋 manifest를 연결한다. 복잡한 봇 기능은 승인된 일회성 native 포팅으로 검증하고 Lua/CBS 실행 호환을 약속하지 않는다.

RisuAI처럼 150k–200k마다 수동 요약·복제를 요구하지 않고 같은 작품에서 이어갈 수 있는지 실제 장기 평가를 한다. 상태 모델이 만든 근거 없는 정보가 다음 원고로 자기강화되는지도 검사한다. 보조 모델 비용·실패와 delayed commit으로 문제가 생기지 않아야 한다.

## M3 — 필요에 따라 확장

관리 에이전트, 추가 adapter, 선택적 MCP/외부 action, 이미지 생성 연계, 공개 배포 등은 요청이 생긴 범위에서 수행한다. E01–E03의 관련 권한/모호한 외부 부작용/라이선스·service 안전 요구를 연결한다. first-success fallback은 후보 여러 개 보존과 별도 기능이다.

## 바로 확정하지 않아도 되는 것

운영 호스트, 공개 서비스 범위, 최종 디자인 테마, 모든 지원 모델, 완전한 원본 프롬프트 포팅 자료, 실제 품질평가 표본은 M0의 장애물이 아니다. 다만 외부 접속 전 보안·백업, live 시험 전 endpoint/credential/허용예산, 공개 전 자료·코드 재사용 조건은 해당 단계에서 확정한다.

## 작업 종료

선택된 milestone 또는 그 안의 명시적 수직 슬라이스를 검증해 완료한다. 시간/권한/컨텍스트 한계로 중단되면 실행 증거와 좁은 다음 단계를 CURRENT에 남긴다. 모델의 작업 편의를 이유로 승인된 목표를 임의의 더 작은 산출물로 바꾸거나, 문서만 작성하고 구현을 대신했다고 하지 않는다.
