# v0.1.0 표본 기준과 기능 대응표

작성일: 2026-09-12. **단계 A의 기준 목록이며 구현 완료·native 호환 PASS가 아니에요.** 기계가 읽는 원본은 [BETA-SAMPLES.json](BETA-SAMPLES.json)이에요. [베타 결정](../docs/DECISIONS-2026-09-12-BETA.md)을 따르며, 책임 영역은 후속 설계의 후보예요.

## 공개 조건과 읽는 방법

- 사용자가 지정한 **12개 파일의 해당 버전에서 필요한 모든 기능을 완성하고 검증**하는 것을 v0.1.0 공개 조건으로 유지해요. 미래 Risu/RisuAI-Next·추가 표본을 자동 추종하지 않아요.
- Uimori 자체 데이터와 확장 API를 기준으로 가져오기·표현 변환·선택형 호환 실행을 조합해요. 기술 구현·픽셀·원본 코드 무수정의 동일성은 일괄 요구하지 않아요. 특정 자료명 전용 본체 기능을 만들지 않아요.
- 원본 보존과 코드 실행 허가는 별개예요. 제작자 코드·확장 소유 화면을 지원할 공통 경계를 준비하되 주 앱 DOM 전체 접근은 범위에서 제외해요.
- 정상 준비·개입·건너뛰기를 구분하고 부가 기능 실패가 채팅을 막지 않게 해요. 사용자의 명시적 변경이 자동 변경보다 우선해요.
- 이 표는 **현재 발견한 212개 추적 항목**이에요. `coverage-gap`도 포함하며 완전한 세부 동작 전수표는 아직 아니에요. 같은 고정 표본에서 미조회 기능이 발견되면 기존 공개 조건의 누락을 보완해요.
- `현재 지원 기반`은 관련 Uimori 구현의 존재, `부분`은 일부 기반만 존재, `미구현`은 완성 경로 없음, `미확인`은 근거 부족이에요. **모든 항목의 표본 native 인수와 사용자 인수는 `not-run`**이에요.
- JSON의 `currentSupport`, `originalEvidence`, `requiredVerification`, `nativeAcceptance`를 별개로 유지해요. 정적 분석·hash·일반 회귀를 표본 인수로 바꾸지 않아요.

## 기준 소스와 파일 지문

Uimori 조사 기준은 `ed596791a2873d6bc45ed1556b94150aea08eff3`(`0.0.1`), 작업 브랜치는 `codex/beta-foundations`예요. 참고한 RisuAI는 `cad8595aa39620df4246f56918f0962c2aa0263a`, RisuToki는 `45048b1139361cd0fded462683dd30fd7df7ce98`예요.

이번 단계에서는 원본 파일을 **byte hash/크기로만 확인**했어요. 컨테이너 해제·원문 재추출·코드 실행은 하지 않았어요. 아래 현재 hash는 이전 구조화 읽기 결과와의 byte 단위 일치 검증이 아니며, 실제 이식/인수에 착수할 때 해당 hash와 세부 읽기 영수증을 연결해야 해요. 개인 절대경로·원문·코드·비밀은 공개 목록에 넣지 않아요. 파일명 철자도 원본대로 기록해요.

| Sample ID | 원본 파일명 | 자료 역할 / 컨테이너 | 버전·근거 | bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| `pheme-normal` | pheme-preset.risup | preset / risup | 4.0.6 · 이전 구조화 조회 | 72025 | `aa854086b444f604594dc9589619f7f1e39c7f07ea317b9d5ebbaf2140cb4cd2` |
| `pheme-tool` | pheme-tool-call-preset.risup | preset / risup | 4.0.6 · 이전 구조화 조회 | 72916 | `14f23f227a680877e6a8312afeb3a16a8be6afe59b439d6739fe1c038cf179c6` |
| `provider-manager` | provider-manager-v1.16.2.js | plugin / javascript | 1.16.2 · 앞선 header 정적 조회 | 1016732 | `fd5f599bd19bfe66837ea558fc717d907c890e6f4bcb5d16207059fa7b81b7a8` |
| `hinano` | Fujimiya Hinano_v2.4.3-test.charx | bot / charx | 2.4.3-test · 파일명 | 11728310 | `f887d86aa7da467b7c9be3137ebc97226a15fd2a81ca62830a762157a8dd0ce0` |
| `tvon` | The_Vail_of_Night_v2.1.0.charx | bot / charx | 2.1.0 · 파일명 | 8896903 | `524de7488ead57663856c87081a2fe9f2400cc00fbd4e6a4d5779213466dd60d` |
| `vela` | Project Vela — 7 Years Later.charx | bot / charx | 미확인 · 미확인 | 982841 | `ef0e7fe12aaee747651127cbd91610d467cc9c516cd6e91dccc3ab420027fcdb` |
| `hidden-story` | _🫦히든 스토리 3.43.risum | module / risum | 3.43 · 파일명 | 46657 | `0f96a867415b617e6560f7710871747d656c71817d507f0fd62e86cb9526a499` |
| `merry` | Merry Sisters! - Final.charx | bot / charx | Final · 파일명 | 140785373 | `af9e932fe110abf32cdeca255d91d24028e8b5c13e23b23438db61993d88e6ca` |
| `logplus` | LogPlus_1.4.0.js | plugin / javascript | 1.4.0 · 앞선 header 정적 조회 | 184881 | `ab6599410c28fe4cc283da91bf0a8102baa781d5699b63b502c44d46e6dd500a` |
| `lightboard` | 🔦라이트보드 - 4.3.1.charx | module / charx | 4.3.1 · 파일명 | 46688 | `a2f1d1aacd705188d80a932e642328f4e58caf9cc6fec50962ae52bf1f9ace6e` |
| `lightboard-mini` | 🔦라이트보드 ♦️미니보드 4.3.1.charx | module / charx | 4.3.1 · 파일명 | 37336 | `d868d19ce1fa5901960dba03971b42609cd366f4955951371fb8163a42c78806` |
| `lightboard-news` | 🔦라이트보드 📰뉴스 4.3.1.charx | module / charx | 4.3.1 · 파일명 | 29659 | `c62b7801ab80ec667b27ca5b453c5e2f4497c2fb3b04bc148fd35bc83b5698a7` |

`charx`가 봇만 뜻하지는 않아요. 라이트보드 세 파일은 모듈이에요. Phēmē의 4.0.6은 이전 구조화 조회 값이고 파일명에서 추정한 값이 아니에요. Vela의 선언 버전은 미확인으로 남겨요. 플러그인 header도 앞선 정적 조사에서 확인한 값이며 이 단계의 hash 확인과 구분해요.

## 예상 책임 영역

| ID | 책임 후보 |
| --- | --- |
| `import` | 자료 분석·가져오기 |
| `representation` | 프롬프트·표시·전송 표현 변환 |
| `runtime` | 공통 확장 API·선택형 호환 실행 |
| `provider` | 공급자·인증·모델·라우팅 |
| `jobs` | 공통 작업·취소·복구 |
| `state` | 상태·판정·공통 변경 명령 |
| `source` | 원문·수정본·귀속 |
| `ui` | 확장 소유 UI·공통 UI 확장 |
| `memory` | 자료·기억·출처 |
| `data` | 저장·의존성·이동·복원 |
| `diagnostics` | 진단·통계·진행 표시 |
| `share` | 공유용 문서·출력 |
| `images` | 이미지·에셋·이미지 작업 |
| `cache` | 공급자 캐시 정책·수명주기 |

아래 분담은 특정 runtime·프로세스·함수명이나 테이블을 확정하지 않아요. 공통 API를 사용하는 이식물/adapter로 동작을 보존하며, 본체의 역할·저장·작업 규칙을 Risu 내부 구조로 대체하지 않아요.

## 필요한 검증

| ID | 확인할 결과 |
| --- | --- |
| `IMPORT` | 고정 원본의 필드·옵션·코드·에셋·의존성 전수표와 가져오기 결과를 대조하고 미지원/불확실/손실을 확인해요. 지원 표본을 에이전트 없이 일상 사용하며 반복 가져오기와 충돌도 확인해요. |
| `WIRE` | 역할·순서·조건·기본값·옵션 조합·명령·정규식 단계·포함/제외 범위를 고정 입력의 원본/대상 결과로 대조해요. 저장 원문과 전송/표시 표현을 구분해요. |
| `RUNTIME` | 선언한 코드/hook·의존 모듈을 실제 격리 환경에서 실행해 호출 순서·권한 위임·취소·오류를 대조해요. 주 DOM·비밀·다른 자료에 대한 비허가 접근과 자원 소진을 막는지 확인해요. |
| `PROVIDER` | 고정 공급자/프로토콜·인증·옵션·라우팅 matrix에서 요청과 응답 fixture를 대조해요. 필요한 실제 모델·계정·비용 검증은 실행 계획과 승인 후 별도 수행해요. |
| `JOBS` | 정상 대기·개입·건너뛰기·실패·부분 응답·재시도·재접속·재시작을 시험해요. 부가 기능 실패의 비차단, 중복 방지와 실제 시도·사용량·결과 귀속을 확인해요. |
| `STATE` | 고정 이전 상태/입력으로 계산·순차 효과·추첨·중복 제출·상태 patch·사용자 수정 우선·지연 결과를 대조해요. 과거 원문 변경과 실패/건너뛰기 뒤의 유효성을 확인해요. |
| `SOURCE` | 원문/수정본/실행 입력/표시 결과의 분리를 검사하고 source/hash·branch·revision이 다른 결과를 잘못 게시하지 않는지 확인해요. |
| `UI` | 주 앱 DOM 접근 없이 확장 화면의 핵심 행동·상태·접힘·입력·오류·취소·초안 보존을 모바일/데스크톱에서 확인해요. 픽셀 동일 대신 기능과 사용자 경험을 인수해요. |
| `MEMORY` | 작성 배경·실제 진행 기록·사용자 지시·자동 해석의 출처를 대조해요. 실제 모델의 자료 선택·회수·정리와 인물/관계/지식 귀속 품질은 별도로 평가해요. |
| `LIFECYCLE` | 정의/설정/상태/의존성의 저장·재시작·수정·삭제·포크·재가져오기·백업·복원·지원 업그레이드에서 값과 소유권을 확인해요. |
| `DIAGNOSTICS` | 진행/오류/시도/토큰/비용을 대조하고 기본 진단의 비밀·본문 제외와 상세 추적 opt-in·검토·공유·보관/삭제를 확인해요. |
| `SHARE` | 선택 범위·원문/번역·공유본 수정·이름/metadata·숨김/이미지·스타일의 text/html 결과를 대조해요. 원본 불변, 실제 붙여넣기와 모바일 동작을 별도 확인해요. |
| `IMAGES` | 참조/byte/MIME/누락 자산과 source anchor를 대조해요. 생성·재사용·교체·공유 이미지의 실제 표시, 취소/중복/복원과 외부 URL 의존을 확인해요. |
| `CACHE` | 캐시 경계·prefix·모델/키/프로젝트 scope·관찰·TTL·생성/교체/연장/삭제/복원·비용을 검증해요. 실제 hit는 공급자 usage로만 판정해요. |
| `SAMPLE` | 기능별 세부 사례와 예상 결과를 작성하고 모든 미확인 표면을 해소해요. 표본 단독과 지정 조합을 실행하고 기능/경험에 대한 사용자 인수를 받아요. |

검증 ID는 앞으로 작성할 사례의 관점이며 실행된 테스트 이름이나 영수증이 아니에요. 각 기능의 원본 위치·입력·조건·예상 결과를 세분화한 뒤 재현 가능한 검사와 연결해야 해요.

## 표본별 기능 대응

표의 근거는 원본의 정적 위치예요. 현재 Uimori 지원 판단의 파일 근거는 JSON의 `currentSupport.evidenceRefs`와 아래 근거 목록에 있어요. `구조화 조회 요약`은 이 대화의 기존 RisuToki 읽기 요약이며 세부 section/필드 locator가 미확정인 상태예요. 개인 원문 영수증을 공개 문서에 복제하지 않아요.

Provider Manager는 8줄 압축 파일이므로 `8행 · offset N`을 사용해요. offset은 **파일 시작 기준 0-based UTF-16 코드 단위**예요. LogPlus는 일반 행 번호를 사용해요.

### Phēmē 일반 · `pheme-normal`

구조화 조회 요약: V4.0.6, prompt 45항목, toggle 45개, regex 5개.

- 미완: 각 prompt/toggle/regex의 안정 식별자·원본 위치·분기별 기대값은 이 문서에 아직 전수 등록하지 않았어요.
- 미완: 원본 코드/컨테이너를 다시 열어 완독하거나 native 실행을 검증하지 않았어요.
- 범위 구분: 원본 프리셋의 모델·프로바이더 설정 복제는 이 표본의 핵심 이식 조건에서 제외해요.

**PN · 프롬프트 일반형**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PN.ORDER` | 45개 프롬프트 항목의 역할·순서·삽입 위치 | 부분 | representation, import | WIRE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `PN.TOGGLES` | 45개 토글의 기본값·값 타입·조건별 지침 | 부분 | representation, import | WIRE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `PN.COMMANDS` | 명령 처리와 5개 정규식의 실제 적용 단계 | 부분 | representation, runtime | WIRE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `PN.TEXT` | 작성 지침·옵션 의도와 현재 입력/이력 조립 | 부분 | representation, memory | WIRE, MEMORY, SAMPLE | 구조화 조회 요약 |
| `PN.VARIANT` | 일반형의 최종 본문 생성 흐름 | 부분 | representation, provider | WIRE, PROVIDER, SAMPLE | 구조화 조회 요약 |
| `PN.COVERAGE` | 45개 토글와 5개 규칙의 개별 원본 위치·세부 기대값 확정 **(조사 공백)** | 미확인 | import, representation | IMPORT, WIRE, SAMPLE | 구조화 조회 요약 |

### Phēmē Tool Call · `pheme-tool`

구조화 조회 요약: V4.0.6, prompt 46항목, toggle 45개, regex 5개.

- 미완: 각 prompt/toggle/regex의 안정 식별자·원본 위치·분기별 기대값과 일반형 차이를 더 세분화해야 해요.
- 미완: tool 제출과 실제 provider 실행은 미검증이에요.
- 범위 구분: 원본 프리셋의 모델·프로바이더 설정 복제는 이 표본의 핵심 이식 조건에서 제외해요.

**PT · 프롬프트 Tool Call형**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PT.ORDER` | 46개 프롬프트 항목의 역할·순서·삽입 위치 | 부분 | representation, import | WIRE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `PT.TOGGLES` | 45개 토글의 기본값·값 타입·조건별 지침 | 부분 | representation, import | WIRE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `PT.COMMANDS` | 명령 처리와 5개 정규식의 실제 적용 단계 | 부분 | representation, runtime | WIRE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `PT.TEXT` | 작성 지침·옵션 의도와 현재 입력/이력 조립 | 부분 | representation, memory | WIRE, MEMORY, SAMPLE | 구조화 조회 요약 |
| `PT.SUBMISSION` | 도구를 통한 최종 이야기 제출과 일반형과의 차이 | 부분 | representation, provider, runtime | WIRE, PROVIDER, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `PT.COVERAGE` | 46개 항목·45개 토글·5개 규칙의 개별 대응과 제출 기대값 확정 **(조사 공백)** | 미확인 | import, representation | IMPORT, WIRE, SAMPLE | 구조화 조회 요약 |

### Provider Manager · `provider-manager`

1,016,732 bytes/8줄 JS를 정적으로 파싱하고 설정 구조·UI 문구·관련 실행 분기를 조사했어요. 12기능군을 개별 추적 항목으로 나눴어요.

- 미완: 원격 레지스트리·가격표·개별 제공자 정의의 배포 시점 내용을 아직 고정하지 않았어요. JS hash는 원격 입력의 hash가 아니에요.
- 미완: 모든 함수 분기와 공급자·인증·도구·hook 조합의 기능 동등성은 검증하지 않았어요.
- 미완: 기능별 parameter/모드/오류 기대값과 실제 계정/서비스 matrix를 더 세분화해야 해요.

**PM01 · 공급자·모델 등록**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM01.REGISTRY` | 공급자 정의·레지스트리 갱신과 활성 제공자 관리 | 미구현 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 15184 |
| `PM01.CATALOG` | 모델 목록 조회·검색·필터·목록 캐시 | 부분 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 786541 |
| `PM01.MANUAL` | 수동 공급자·모델 ID 등록 | 부분 | provider, ui | PROVIDER, UI, SAMPLE | 8행 · offset 783815 |
| `PM01.QUICK` | 빠른 시작에서 여러 모델 한 번에 등록 | 미구현 | provider, ui | PROVIDER, UI, SAMPLE | 8행 · offset 816322 |
| `PM01.CLONE` | 모델 복제와 이름·설정 편집 | 현재 지원 기반 | provider, ui | PROVIDER, UI, SAMPLE | 8행 · offset 872228 |
| `PM01.GROUPS` | 모델 분류 그룹과 재등록 | 부분 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 799714 |
| `PM01.METADATA` | 모델 context/output·vision/tools·단가 metadata | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 14245 |
| `PM01.TOKENIZER` | 모델별 토크나이저 선택과 GLM 토크나이저 캐시 | 미구현 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 870167 |
| `PM01.FORMATS` | Anthropic·Gemini·Interactions·Chat·Responses·NovelAI 형식 | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 137163 |
| `PM01.REMOTEDEFS` | 고정 표본이 내려받는 제공자별 정의·customFields·목록/가격 계약 확인 **(조사 공백)** | 미확인 | provider, import | PROVIDER, IMPORT, SAMPLE | 8행 · offset 15184 |

**PM02 · 인증·키 관리**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM02.API` | 일반 API 키의 등록·이름·수정·삭제 | 부분 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 759769 |
| `PM02.VERTEX` | Vertex 서비스 계정과 직접 토큰 | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 757672 |
| `PM02.BEDROCK` | Bedrock IAM 서명과 Bearer API 키 | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 758344 |
| `PM02.COPILOT` | GitHub Copilot OAuth·토큰·client profile·신원 관리 | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 751089 |
| `PM02.USAGEKEY` | 잔액 조회용 별도 자격정보 | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 757263 |
| `PM02.KEYGROUP` | 키 그룹·선택·정리와 유형 검토 | 미구현 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 761948 |
| `PM02.ROTATION` | 키 수동·순차·오류 시 회전 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 761430 |

**PM03 · 연결·요청 설정**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM03.ENDPOINT` | 커스텀 endpoint와 공급자별 platform/region | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 844056 |
| `PM03.NETWORK` | native·Risu/Yumi·사용자 proxy와 proxy 경유 | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 802811 |
| `PM03.OVERRIDE` | 모델별 network 및 설정 override | 부분 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 847105 |
| `PM03.HEADERS` | 사용자 JSON header | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 868502 |
| `PM03.BODY` | 사용자 JSON body 깊은 병합 | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 868728 |
| `PM03.OPTIONS` | sampling·thinking/effort·verbosity·service tier·output 한도 | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 863354 |
| `PM03.NATIVEFIELDS` | instructions·store·max completion 필드 등 protocol 선택 | 부분 | provider | PROVIDER, SAMPLE | 8행 · offset 864896 |
| `PM03.SESSION` | session affinity와 자동/수동 session ID | 미구현 | provider | PROVIDER, SAMPLE | 8행 · offset 868004 |
| `PM03.STREAM` | stream 요청과 실시간/완료 후 일괄 반환 | 부분 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 846774 |

**PM04 · 모델 그룹·조건부 라우팅**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM04.SELECTION` | 그룹의 수동 활성 모델 선택 | 미구현 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 800778 |
| `PM04.ROTATION` | 요청별 순차·오류 후 다음 요청의 모델 전진 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 800573 |
| `PM04.FAILOVER` | 동일 요청 실패 후 다른 모델 시도 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 800879 |
| `PM04.PARTIALFAILOVER` | 출력 중 실패 뒤 다음 모델 시도와 결과 처리 | 미구현 | provider, jobs, source | PROVIDER, JOBS, SOURCE, SAMPLE | 8행 · offset 801121 |
| `PM04.LENGTH` | 문자/추정 토큰 수와 이상/이하 조건 | 미구현 | provider, representation | PROVIDER, WIRE, SAMPLE | 8행 · offset 891416 |
| `PM04.PATTERN` | 포함/NOT·대소문자·system/user/all 문자열 조건 | 미구현 | provider, representation | PROVIDER, WIRE, SAMPLE | 8행 · offset 890294 |
| `PM04.PRIORITY` | 조건별 대상과 단일 default 조건 | 미구현 | provider, data | PROVIDER, LIFECYCLE, SAMPLE | 8행 · offset 890997 |
| `PM04.REMOVE` | 매칭용 식별 패턴을 실제 요청에서 제거 | 미구현 | provider, representation | PROVIDER, WIRE, SAMPLE | 8행 · offset 892219 |
| `PM04.DISCOVER` | 저장 로그에서 라우터 식별 문구 찾기 | 미구현 | provider, diagnostics | PROVIDER, DIAGNOSTICS, SAMPLE | 8행 · offset 885135 |

**PM05 · 재시도·스트림·복구**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM05.HTTPRETRY` | HTTP 종류별 retry와 횟수·총시간·최소간격 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 807728 |
| `PM05.RETRYHINT` | Retry-After·rate-limit reset·Google RetryInfo | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 502852 |
| `PM05.IPCOVERRIDE` | IPC retry 적용 및 모델별 정책 override | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 808033 |
| `PM05.ATTEMPTLOG` | 재시도 중 각 오류/요청 기록 | 부분 | jobs, diagnostics | JOBS, DIAGNOSTICS, SAMPLE | 8행 · offset 808084 |
| `PM05.REPETITION` | 동일 문자·문자열 패턴 반복 guard | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 808836 |
| `PM05.THROTTLE` | 실시간 출력 갱신 간격과 완료 flush | 부분 | ui, jobs | UI, JOBS, SAMPLE | 8행 · offset 809864 |
| `PM05.PARTIAL` | 이미 받은 텍스트를 남기는 오류 처리 | 부분 | jobs, source | JOBS, SOURCE, SAMPLE | 8행 · offset 847571 |
| `PM05.RECONNECT` | background 생성 스트림 재접속·상태 표시 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 594879 |

**PM06 · 비동기·배치 요청**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM06.BATCHMODEL` | Anthropic Batch 모델·연결·옵션·배치 단가 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 717193 |
| `PM06.CREATE` | Batch 생성 후 대기 또는 생성 통지·대기 종료 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 719031 |
| `PM06.POLL` | 원격 작업 상태 조회·결과 수신·재시작 후 확인 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 358308 |
| `PM06.CANCEL` | 원격 취소와 취소 완료 대기 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 363561 |
| `PM06.DELETE` | 원격 삭제·완료 후 자동 정리와 로컬 삭제 구분 | 미구현 | provider, jobs, data | PROVIDER, JOBS, LIFECYCLE, SAMPLE | 8행 · offset 719697 |
| `PM06.RETENTION` | 배치 결과 보관 기간·기기/동기화 저장 위치 | 미구현 | data, jobs | LIFECYCLE, JOBS, SAMPLE | 8행 · offset 719550 |
| `PM06.DEDUP` | 동일 입력 hash/유사도·생성 직후 재요청 안정화 | 미구현 | jobs, provider | JOBS, PROVIDER, SAMPLE | 8행 · offset 719860 |
| `PM06.DRYRUN` | 실제 생성 없는 동일 입력 판정 시험 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 720271 |
| `PM06.VIEW` | 상태별 목록·요청/결과 보기·리턴 예정/완료 | 미구현 | ui, jobs | UI, JOBS, SAMPLE | 8행 · offset 727443 |
| `PM06.RESPBG` | Responses background/store 생성·재개 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 864996 |
| `PM06.INTERACTBG` | Gemini Interactions store/background 생성·재개 | 미구현 | provider, jobs | PROVIDER, JOBS, SAMPLE | 8행 · offset 866009 |

**PM07 · 캐시 정책·명시적 캐시**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM07.MODES` | off·기존 캐시 포인트·auto·manual 모드 | 부분 | cache, provider | CACHE, PROVIDER, SAMPLE | 8행 · offset 705560 |
| `PM07.BOUNDS` | system·마지막 턴·처음 N·끝 N 제외·사다리 경계 | 부분 | cache, representation | CACHE, WIRE, SAMPLE | 8행 · offset 706745 |
| `PM07.TTL` | TTL·최소 토큰 override·extended retention | 부분 | cache, provider | CACHE, PROVIDER, SAMPLE | 8행 · offset 708533 |
| `PM07.ADVISOR` | 요청 관찰·반복 횟수·안정 prefix·예측/검증 전진 | 미구현 | cache, data | CACHE, LIFECYCLE, SAMPLE | 8행 · offset 710501 |
| `PM07.CREATE` | Google AI Studio/Vertex 명시적 캐시 생성과 승격 | 미구현 | cache, provider, jobs | CACHE, PROVIDER, JOBS, SAMPLE | 8행 · offset 740171 |
| `PM07.BACKGROUND` | 백그라운드 생성·공격적 생성/갱신 선택 | 미구현 | cache, jobs | CACHE, JOBS, SAMPLE | 8행 · offset 741431 |
| `PM07.SCOPE` | 모델/키별 scope·활성 캐시/후보 한도 | 미구현 | cache, data | CACHE, LIFECYCLE, SAMPLE | 8행 · offset 741999 |
| `PM07.RENEW` | 교체·TTL 자동 연장·오류 캐시 해제 | 미구현 | cache, provider, jobs | CACHE, PROVIDER, JOBS, SAMPLE | 8행 · offset 405313 |
| `PM07.REMOVE` | 서버 동기화·누락 검사·명시적 삭제 | 미구현 | cache, provider | CACHE, PROVIDER, SAMPLE | 8행 · offset 735411 |
| `PM07.OBSERVE` | 캐시 상태·학습·통계·저장 위치·초기화 | 미구현 | cache, data, diagnostics | CACHE, LIFECYCLE, DIAGNOSTICS, SAMPLE | 8행 · offset 739190 |

**PM08 · 도구·MCP·가상 도구**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM08.BUILTIN` | 정수 추첨·주사위 표현식 | 부분 | state, runtime | STATE, RUNTIME, SAMPLE | 8행 · offset 558934 |
| `PM08.WEB` | provider-hosted 웹 검색과 결과 상세 표시 | 미구현 | provider, runtime, ui | PROVIDER, RUNTIME, UI, SAMPLE | 8행 · offset 559703 |
| `PM08.EXTERNAL` | 외부 IPC 도구 등록·동기화·온라인 상태 | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 8행 · offset 560359 |
| `PM08.MCP` | MCP 자동/Streamable HTTP/SSE·서버·인증·timeout | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 8행 · offset 453887 |
| `PM08.FUNCTIONS` | 도구/함수별 전역·모델 선택과 설정 | 부분 | runtime, provider, ui | RUNTIME, PROVIDER, UI, SAMPLE | 8행 · offset 851549 |
| `PM08.AUTH` | 확인 필요 도구와 승인 없는 호출의 명시 설정 | 미구현 | runtime, ui | RUNTIME, UI, SAMPLE | 8행 · offset 929807 |
| `PM08.SCHEMA` | 함수 입력 schema·실행 결과·오류 검증 | 부분 | runtime, jobs | RUNTIME, JOBS, SAMPLE | 8행 · offset 455607 |
| `PM08.LIMIT` | 도구 턴 반복 한도와 취소 | 부분 | runtime, jobs | RUNTIME, JOBS, SAMPLE | 8행 · offset 852446 |
| `PM08.TOOLBLOCK` | pm-tool 블록을 도구 이력으로 복원·제거/유지 | 미구현 | representation, runtime | WIRE, RUNTIME, SAMPLE | 8행 · offset 933063 |
| `PM08.TOOLSET` | pm-toolset 저장/프롬프트 가상 도구 세트 | 미구현 | representation, runtime | WIRE, RUNTIME, SAMPLE | 8행 · offset 933209 |
| `PM08.VIRTUAL` | 입력/고정값/시각/무작위 선택·정수 반환 가상 함수 | 부분 | runtime, state | RUNTIME, STATE, SAMPLE | 8행 · offset 469047 |

**PM09 · 외부 훅·모델 서비스**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM09.MODELSERVICE` | 다른 플러그인에 등록 모델 목록/chat 서비스 제공 | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 8행 · offset 811315 |
| `PM09.REQUEST` | IPC 메시지/도구 JSON·stream/minimal 모드 | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 8행 · offset 573603 |
| `PM09.CONCURRENCY` | 동시 요청 상한·중복 ID·timeout·취소 | 부분 | runtime, jobs | RUNTIME, JOBS, SAMPLE | 8행 · offset 576072 |
| `PM09.REGISTER` | 외부 hook 등록·해제·상태·설정 | 미구현 | runtime, data | RUNTIME, LIFECYCLE, SAMPLE | 8행 · offset 496593 |
| `PM09.PRE` | 요청 전 pre-hook 변환 | 미구현 | runtime, representation | RUNTIME, WIRE, SAMPLE | 8행 · offset 501370 |
| `PM09.POST` | 응답 후 post-hook batch/stream 변환 | 미구현 | runtime, source | RUNTIME, SOURCE, SAMPLE | 8행 · offset 502519 |
| `PM09.SELECT` | 모델별 hook 선택·설정·연계 | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 8행 · offset 862115 |
| `PM09.TRACE` | hook 지연·실패단계·변환 입력/출력 로그 | 미구현 | runtime, diagnostics | RUNTIME, DIAGNOSTICS, SAMPLE | 8행 · offset 485080 |

**PM10 · Agent Skills**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM10.IMPORT` | SKILL.md 파일/폴더·references 가져오기와 미리보기 | 미구현 | import, memory | IMPORT, MEMORY, SAMPLE | 8행 · offset 903937 |
| `PM10.UPDATE` | 기존 skill 업데이트와 활성 상태 유지 | 미구현 | data, memory | LIFECYCLE, MEMORY, SAMPLE | 8행 · offset 903228 |
| `PM10.SELECT` | 전역/모델별 skill 선택 | 미구현 | provider, memory | PROVIDER, MEMORY, SAMPLE | 8행 · offset 860094 |
| `PM10.ALWAYS` | 모든 요청에 skill 본문 삽입 | 부분 | representation, memory | WIRE, MEMORY, SAMPLE | 8행 · offset 861786 |
| `PM10.ONDEMAND` | activate_skill 및 read_skill_resource | 미구현 | runtime, memory | RUNTIME, MEMORY, SAMPLE | 8행 · offset 461355 |
| `PM10.BUDGET` | skill/resource 크기·요청별 컨텍스트/조회 예산 | 부분 | runtime, memory | RUNTIME, MEMORY, SAMPLE | 8행 · offset 913359 |
| `PM10.STORAGE` | skill 저장 위치·이동 검증·삭제·복구 | 미구현 | data, memory | LIFECYCLE, MEMORY, SAMPLE | 8행 · offset 556197 |

**PM11 · 이력·문맥·출력 변환**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM11.OPAQUE` | provider thinking/signature의 다음 요청 복원 | 부분 | provider, jobs, data | PROVIDER, JOBS, LIFECYCLE, SAMPLE | 8행 · offset 862945 |
| `PM11.TOOLCHAIN` | 도구 호출 이력·응답 체인 보존/복원 | 부분 | provider, jobs, data | PROVIDER, JOBS, LIFECYCLE, SAMPLE | 8행 · offset 812680 |
| `PM11.RETENTION` | 본문/별도 저장소 선택·복원/보관 개수 | 미구현 | data, provider | LIFECYCLE, PROVIDER, SAMPLE | 8행 · offset 812803 |
| `PM11.VISIBILITY` | 생각·중간 생각·도구 활동 숨김과 이력 유지 | 부분 | ui, provider | UI, PROVIDER, SAMPLE | 8행 · offset 848610 |
| `PM11.THOUGHTBODY` | reasoning-only 또는 종료 구분자 이후를 본문으로 표시 | 미구현 | provider, source | PROVIDER, SOURCE, SAMPLE | 8행 · offset 848987 |
| `PM11.PDF` | 컨텍스트 텍스트를 PDF 입력으로 변환 | 미구현 | representation, provider | WIRE, PROVIDER, SAMPLE | 8행 · offset 869039 |
| `PM11.TEMPLATES` | PDF role별 template·system 보존·prefill·추가 유저 지침 | 미구현 | representation, provider | WIRE, PROVIDER, SAMPLE | 8행 · offset 743653 |
| `PM11.MEDIA` | PDF 해상도·글자 크기·끝 블록 제외·줄바꿈 치환 | 미구현 | representation, provider | WIRE, PROVIDER, SAMPLE | 8행 · offset 743039 |

**PM12 · 로그·통계·관리**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `PM12.RAWLOG` | 원시 요청/응답·headers·body 압축 저장·오류 기록 | 부분 | diagnostics, data | DIAGNOSTICS, LIFECYCLE, SAMPLE | 8행 · offset 340260 |
| `PM12.LOGVIEW` | 로그 파싱·상세 보기·다운로드·보관/삭제 | 부분 | diagnostics, ui, data | DIAGNOSTICS, UI, LIFECYCLE, SAMPLE | 8행 · offset 775666 |
| `PM12.STATS` | 모델/날짜별 요청·오류율·토큰·비용·캐시·지연·속도 | 부분 | diagnostics, data | DIAGNOSTICS, LIFECYCLE, SAMPLE | 8행 · offset 917045 |
| `PM12.BALANCE` | 키 잔액·구독 사용량/프리미엄 상호작용 조회 | 미구현 | provider, diagnostics | PROVIDER, DIAGNOSTICS, SAMPLE | 8행 · offset 810813 |
| `PM12.PRICES` | 자동/수동 가격·출처·구독 환산·실제/추정 구분 | 부분 | provider, diagnostics | PROVIDER, DIAGNOSTICS, SAMPLE | 8행 · offset 712883 |
| `PM12.PROGRESS` | 모델·stream/thinking/tool/retry/batch·속도 진행 UI | 부분 | ui, jobs, diagnostics | UI, JOBS, DIAGNOSTICS, SAMPLE | 8행 · offset 810516 |
| `PM12.TRANSFER` | PM 설정 데이터 내보내기/가져오기·초기화 | 미구현 | import, data | IMPORT, LIFECYCLE, SAMPLE | 8행 · offset 938574 |
| `PM12.LOCATIONS` | 기능별 local/save 저장 위치·용량·이동·복구/정리 | 미구현 | data, ui | LIFECYCLE, UI, SAMPLE | 8행 · offset 814277 |
| `PM12.UPDATE` | 새 버전 확인·변경내역·알림 | 미구현 | provider, ui | PROVIDER, UI, SAMPLE | 8행 · offset 806392 |

대응 시 지킬 점:

- `PM04.FAILOVER`: 전송 여부가 불확실한 실행을 조용히 재생하지 않으면서 다음 모델 시도라는 사용자 목적을 보존해요.
- `PM04.PARTIALFAILOVER`: 부분 결과와 후속 모델의 결과·비용·귀속을 구분해요. 부분 응답을 무조건 완료로 처리하는 원래 선택을 그대로 채택하지 않아요.
- `PM05.HTTPRETRY`: 재시도 가능한 확실한 실패와 불확실 실행을 구분하고 실제 attempt를 기록해요.
- `PM05.PARTIAL`: 받은 글을 보존하되 완료/부분/실패 상태를 정확하게 표시해요.
- `PM08.LIMIT`: 원본의 0=무제한 선택을 고정 무제한 계약으로 채택하지 않아요. 작업 예산과 사용자 통제를 함께 보존해요.
- `PM11.THOUGHTBODY`: 사용자에게 공개 가능한 텍스트와 provider opaque reasoning/signature를 구분하며 비공개 continuation을 본문으로 노출하지 않아요.
- `PM12.RAWLOG`: 기본 진단은 최소 기록이에요. 상세 추적/공유 범위는 사용자가 통제하고 비밀은 보호해요.
- `PM12.PRICES`: 실제·추정·구독 환산·미확인 금액을 섞지 않아요.

### Fujimiya Hinano · `hinano`

구조화 조사에서 복합 상태·변수, 시작 선택, 상태별 지침·표시를 확인했어요.

- 미완: 상태 축·계산식·선택·지침·표시 규칙의 개별 원본 식별자/기대값은 이 문서에서 미확인이에요.
- 미완: 전체 에셋·실제 실행·의미 품질은 미검증이에요.

**HI · 상태·시작·지침**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `HI.STATE` | 복합 상태와 변수 계산 | 부분 | state, runtime | STATE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `HI.START` | 사용자 시작 선택과 초기 조건 반영 | 부분 | state, ui, import | STATE, UI, IMPORT, SAMPLE | 구조화 조회 요약 |
| `HI.INSTRUCTIONS` | 현재 상태에 따른 요청 지시 변경 | 부분 | representation, state | WIRE, STATE, SAMPLE | 구조화 조회 요약 |
| `HI.DISPLAY` | 상태창과 표시 가공 | 부분 | ui, representation | UI, WIRE, SAMPLE | 구조화 조회 요약 |
| `HI.COVERAGE` | 상태 축·계산·선택·지침·표시의 세부 분기 전수 확인 **(조사 공백)** | 미확인 | import, state, ui | IMPORT, STATE, UI, SAMPLE | 구조화 조회 요약 |

### The Veil of Night · `tvon`

구조화 조사에서 다단 선택기, STATUS/LEDGER, 상태 지시와 regex를 확인했어요.

- 미완: 전체 선택 경로·ledger 필드·regex 단계별 개별 위치/기대값을 더 확인해야 해요.
- 미완: 전체 자산과 실제 UI/상태 실행은 미검증이에요.

**TV · 다단 선택과 상태 기록**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `TV.START` | 다단계 시작 선택과 이전 선택 의존성 | 부분 | ui, state, import | UI, STATE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `TV.LEDGER` | STATUS/LEDGER 추출·기록·후속 반영 | 부분 | state, representation | STATE, WIRE, SAMPLE | 구조화 조회 요약 |
| `TV.INSTRUCTIONS` | 상태와 지시 연결 | 부분 | state, representation | STATE, WIRE, SAMPLE | 구조화 조회 요약 |
| `TV.REGEX` | 표시·모델 요청 정규식의 적용 시점 | 부분 | representation, runtime | WIRE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `TV.COVERAGE` | 선택 경로·ledger 필드·규칙별 위치와 기대값 전수 확인 **(조사 공백)** | 미확인 | import, state, representation | IMPORT, STATE, WIRE, SAMPLE | 구조화 조회 요약 |

### Project Vela — 7 Years Later · `vela`

구조화 조사에서 기본 봇 자료와 작성 배경/실제 진행 기록 혼재를 확인했고 Lua가 없는 것으로 조사했어요.

- 미완: 개별 기억의 출처·사용 의도는 아직 전수 판정하지 않았어요. 모호한 내용은 원문과 출처를 보존한 초안으로 확인해야 해요.
- 미완: metadata 선언 버전, 전체 실행·자료 회수/정리의 의미 품질은 미확인이에요.

**VE · 봇·배경·진행 기억**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `VE.BOT` | 기본 봇 정체성과 지침·자료 | 부분 | import, representation | IMPORT, WIRE, SAMPLE | 구조화 조회 요약 |
| `VE.MEMORY` | 작성 배경과 실제 진행 기록이 섞인 기억의 의미·출처 보존 | 미확인 | memory, import | MEMORY, IMPORT, SAMPLE | 구조화 조회 요약 |
| `VE.RECALL` | 이식한 기억의 자율 조회·활용과 잘못된 사실 승격 방지 | 부분 | memory, representation | MEMORY, WIRE, SAMPLE | 구조화 조회 요약 |
| `VE.COVERAGE` | 개별 기억의 원래 출처와 모호한 항목 확인 **(조사 공백)** | 미확인 | memory, import | MEMORY, IMPORT, SAMPLE | 구조화 조회 요약 |

### 히든 스토리 · `hidden-story`

구조화 조사에서 조건 지침·서사 분리·표시/요청 제외·패널 상호작용을 확인했어요.

- 미완: 조건/마커/패널의 개별 식별자와 상태·이미지 세부 동작은 이 문서에서 전수 확정하지 않았어요.
- 미완: 전체 자산·실제 renderer·조합 실행은 미검증이에요.

**HS · 조건·서사 구간·표시**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `HS.CONDITION` | 조건부 지시와 옵션별 활성화 | 부분 | representation, import | WIRE, IMPORT, SAMPLE | 구조화 조회 요약 |
| `HS.SEGMENTS` | 서사 구간의 경계·표시·메인 서사와의 분리 | 부분 | representation, source | WIRE, SOURCE, SAMPLE | 구조화 조회 요약 |
| `HS.CONTEXT` | 후속 요청에 포함/제외할 구간 선택 | 부분 | representation, source | WIRE, SOURCE, SAMPLE | 구조화 조회 요약 |
| `HS.PANEL` | 상태·이미지·펼침과 사용자 상호작용 | 부분 | ui, images, state | UI, IMAGES, STATE, SAMPLE | 구조화 조회 요약 |
| `HS.COVERAGE` | 상태·이미지 세부 동작과 패널/구간 규칙 전수 확인 **(조사 공백)** | 미확인 | import, ui, images | IMPORT, UI, IMAGES, SAMPLE | 구조화 조회 요약 |

### Merry Sisters! · `merry`

이번 정적 조회 요약: lore 91개, regex 64개, Lua 40 section/전체 필드 363,897 UTF-16 중 핵심 8 section 완독. 이전 2026-09-10 정적 보고는 참고 근거로 구분해요.

- 미완: 이번 8 section 조회와 이전 보고의 더 넓은 읽기 범위를 합쳐 이번 전체 검증으로 표시하지 않아요.
- 미완: 나머지 Lua 의미, 대형 패널, 전체 에셋 목록/byte/renderer와 실제 보조 모델/상태 흐름은 미완이에요.
- 미완: 오늘 전체 파일 hash 확인은 이전 구조화 추출물과의 byte 단위 일치 검증이 아니에요.

**MS · 복합 상태와 사후 실행**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `MS.STATE` | 인벤토리·자원·관계·퀘스트·성장 상태와 순차 계산 | 부분 | state, runtime | STATE, RUNTIME, SAMPLE | 이전 정적 보고:51 |
| `MS.DRAWS` | 판정·추첨·보너스·명시 재굴림 | 부분 | state, jobs | STATE, JOBS, SAMPLE | 이전 정적 보고:51 |
| `MS.CHOICE` | 사용자 선택·행동과 다음 요청 연결 | 부분 | state, ui | STATE, UI, SAMPLE | 이전 정적 보고:51 |
| `MS.INSTRUCTIONS` | 옵션·상태·언어 등에 따른 지침/로어 배치 | 부분 | representation, memory | WIRE, MEMORY, SAMPLE | 이전 정적 보고:51 |
| `MS.POSTJOBS` | 원문 이후 여러 보조 모델 호출·응답 해석·후속 계산 | 미구현 | jobs, runtime, state | JOBS, RUNTIME, STATE, SAMPLE | 이전 정적 보고:51 |
| `MS.PERIODIC` | 주기적 NPC 상태와 장기 요약 | 미구현 | jobs, memory, state | JOBS, MEMORY, STATE, SAMPLE | 이전 정적 보고:51 |
| `MS.EVENTS` | 출력 사건·보상·레벨을 순서대로 계산하여 게시 | 부분 | state, runtime | STATE, RUNTIME, SAMPLE | 이전 정적 보고:51 |
| `MS.MESSAGE` | 기존 메시지 수정·재생성·표시 결과 갱신 | 미구현 | source, jobs, runtime | SOURCE, JOBS, RUNTIME, SAMPLE | 이전 정적 보고:51 |
| `MS.RESTORE` | 이력/seed와 상태 복원·재생성 귀속 | 부분 | state, data, source | STATE, LIFECYCLE, SOURCE, SAMPLE | 이전 정적 보고:51 |
| `MS.REGEX` | 입력·저장 전 출력·요청·번역·표시의 규칙별 가공 | 부분 | representation, runtime | WIRE, RUNTIME, SAMPLE | 이전 정적 보고:51 |
| `MS.IMAGES` | 등록 이미지 해석·검증·문단 배치 | 부분 | images, representation | IMAGES, WIRE, SAMPLE | 이전 정적 보고:51 |
| `MS.UI` | 전투/퀘스트/선택·게이지·버튼·툴팁 등 전용 화면 | 미구현 | ui, state, images | UI, STATE, IMAGES, SAMPLE | 이전 정적 보고:51 |
| `MS.COVERAGE` | 40 Lua section·91 lore·64 regex·대형 패널·전체 에셋의 잔여 조사 **(조사 공백)** | 미확인 | import, runtime, ui, images | IMPORT, RUNTIME, UI, IMAGES, SAMPLE | 이전 정적 보고:51 |

대응 시 지킬 점:

- `MS.POSTJOBS`: 기존 authoritative 실패 차단을 그대로 목표로 삼지 않아요. 정상 준비·개입·건너뛰기와 부가 기능 실패의 비차단을 검증해요.
- `MS.EVENTS`: 현재 behavior effects의 동시 읽기와 원본 순차 계산을 대조하며 결과가 다른 대입으로 축약하지 않아요.

### LogPlus · `logplus`

184,881 bytes/3,913줄 JS의 함수·host API 목록과 추출/변환/공유 구현을 정적으로 조사했어요. 8개 테마와 9기능군을 확인했어요.

- 미완: 모바일 clipboard·실제 게시판 편집기 붙여넣기·외부 이미지 접근·압축 후 결과는 미검증이에요.
- 미완: 에셋 추정/번역 fuzzy matching은 전체 Risu 동등성이나 올바른 번역 매칭의 증거가 아니에요.
- 미완: HTML 초안 편집과 plain text 복사의 원본 구현 차이는 같은 공유 초안 계약으로 대조해야 해요.
- 범위 구분: 원본에 없는 PDF/PNG/Markdown/JSON 파일 출력, 전체 DB/분기 백업, 진단 로그, 일반 개인정보 자동 탐지, 설정 파일 import/export를 이 표본의 기존 기능이라고 추가하지 않아요.

**LP01 · 대화 선택과 범위**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP01.CURRENT` | 현재 캐릭터/채팅의 메시지 추출 | 부분 | share, source | SHARE, SOURCE, SAMPLE | 2533행 |
| `LP01.GREETING` | 선택한 fmIndex 첫 인사 포함 | 부분 | share, source | SHARE, SOURCE, SAMPLE | 2873행 |
| `LP01.RANGE` | 시작/끝 번호·개별 체크·전체/해제 | 미구현 | share, ui | SHARE, UI, SAMPLE | 3753행 |
| `LP01.USERFILTER` | 선택 범위에서 유저 메시지만 제외 | 미구현 | share, ui | SHARE, UI, SAMPLE | 3793행 |
| `LP01.ROLES` | user/character/system 구분·선택 개수 | 부분 | share, ui | SHARE, UI, SAMPLE | 3052행 |

**LP02 · 기존 번역 활용**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP02.LOOKUP` | 새 모델 호출 없이 기존 번역 읽기 | 현재 지원 기반 | share, source | SHARE, SOURCE, SAMPLE | 49행 |
| `LP02.MATCH` | 완전/유사 cache 조회 후 미번역 원문 유지 | 부분 | share, source | SHARE, SOURCE, SAMPLE | 55행 |
| `LP02.REFRESH` | 번역 선택 변경 시 공유 메시지 갱신 | 미구현 | share, ui | SHARE, UI, SAMPLE | 1566행 |

**LP03 · 읽기용 정리와 구간**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP03.CLEAN` | HTML·일부 상태창/annotation·숨김 표식 정리 | 부분 | share, representation | SHARE, WIRE, SAMPLE | 2509행 |
| `LP03.LINES` | br/p·인용 블록·details summary의 텍스트 정리 | 부분 | share, representation | SHARE, WIRE, SAMPLE | 2517행 |
| `LP03.HIDDEN` | HiddenStory v1/v2 제목·프로필·상태·본문 접힘 표시 | 부분 | share, representation, images | SHARE, WIRE, IMAGES, SAMPLE | 3313행 |

**LP04 · 이미지와 에셋**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP04.PROFILES` | 봇·페르소나 프로필 선택·표시 | 부분 | share, images | SHARE, IMAGES, SAMPLE | 2542행 |
| `LP04.ASSETS` | 캐릭터/모듈 에셋 참조와 이미지 마커 해석 | 부분 | import, representation, images | IMPORT, WIRE, IMAGES, SAMPLE | 2571행 |
| `LP04.REGEX` | 활성/연결 모듈 editdisplay 규칙에서 에셋 후보 추론 | 미구현 | import, representation, images | IMPORT, WIRE, IMAGES, SAMPLE | 2628행 |
| `LP04.TOGGLES` | 본문 이미지/프로필 이미지의 개별 포함 선택 | 미구현 | share, ui, images | SHARE, UI, IMAGES, SAMPLE | 951행 |
| `LP04.PORTABILITY` | 이미지 내장/외부 URL과 모바일 크기 축소 | 미구현 | share, images | SHARE, IMAGES, SAMPLE | 2212행 |

**LP05 · 이름과 공유 metadata**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP05.PERSONA` | 페르소나 선택 또는 직접 입력 | 부분 | share, ui | SHARE, UI, SAMPLE | 1503행 |
| `LP05.REPLACE` | 이름/변형 이름을 user 표기로 치환 | 미구현 | share, representation | SHARE, WIRE, SAMPLE | 3072행 |
| `LP05.HIDE` | 본문 화자 이름 표시 숨김 | 미구현 | share, ui | SHARE, UI, SAMPLE | 3284행 |
| `LP05.METADATA` | 공유 제목·모델명·프롬프트명 직접 지정 | 미구현 | share, ui | SHARE, UI, SAMPLE | 1536행 |

**LP06 · 테마와 스타일**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP06.THEMES` | 8개 테마에 대응하는 공유 레이아웃 선택 | 미구현 | share, ui | SHARE, UI, SAMPLE | 101행 |
| `LP06.STYLES` | 대사/생각/효과음/지문/나레이션/화자별 색·배경·크기·굵기 | 부분 | share, ui | SHARE, UI, SAMPLE | 3134행 |
| `LP06.HIGHLIGHT` | 대사/효과음 하이라이트와 항목별 초기화 | 부분 | share, ui | SHARE, UI, SAMPLE | 1358행 |
| `LP06.LAYOUT` | 표지·프로필 카드·metadata 태그·접히는 본문 | 미구현 | share, ui, images | SHARE, UI, IMAGES, SAMPLE | 3529행 |

**LP07 · 미리보기와 공유본 편집**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP07.PREVIEW` | 목록/미리보기와 확대·축소·맞춤 | 미구현 | share, ui | SHARE, UI, SAMPLE | 3703행 |
| `LP07.EDIT` | 원문을 바꾸지 않는 공유 HTML 글자수정 | 미구현 | share, ui, source | SHARE, UI, SOURCE, SAMPLE | 3735행 |
| `LP07.COPYEDIT` | 편집한 공유 초안의 HTML 복사 | 미구현 | share, ui | SHARE, UI, SAMPLE | 1092행 |

**LP08 · 복사와 모바일**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP08.TEXT` | 일반 텍스트 클립보드 복사 | 부분 | share, ui | SHARE, UI, SAMPLE | 3115행 |
| `LP08.HTML` | 서식 HTML 클립보드 복사와 fallback | 미구현 | share, ui | SHARE, UI, SAMPLE | 2355행 |
| `LP08.MOBILE` | 모바일 설정/하단 액션·iOS/Android 붙여넣기 | 미구현 | share, ui | SHARE, UI, SAMPLE | 2328행 |

**LP09 · 설정 프리셋과 진입**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LP09.PRESETS` | 스타일 조합 저장·불러오기·삭제 | 미구현 | share, data, ui | SHARE, LIFECYCLE, UI, SAMPLE | 1377행 |
| `LP09.ENTRY` | 채팅에서 공유 편집기 열기·닫기 | 미구현 | share, ui | SHARE, UI, SAMPLE | 3864행 |

대응 시 지킬 점:

- `LP04.PORTABILITY`: 자체 서버/외부 URL 의존과 내장 이미지의 차이를 보여주고 공유를 위해 임의 업로드하지 않아요.
- `LP05.REPLACE`: 이름 치환은 공유본에만 적용하고 일반 개인정보 익명화 완료로 표시하지 않아요.
- `LP07.EDIT`: 공유본 편집은 원문·Run·저장 번역을 수정하지 않아요.

### 라이트보드 · `lightboard`

전체 Lua 62,161 UTF-16과 선택 핵심 lore code를 구조화 조회했어요. CSS 12,127 UTF-16, lore 7개, regex 21개라는 목록을 확인했어요.

- 미완: lore code의 전체 항목별 hook/권한 기대값과 비핵심 lore 의미는 더 세분화해야 해요.
- 미완: 에셋 API 미지원으로 전체 자산과 실제 renderer를 확인하지 못했어요.
- 미완: 정적 LLA flag만으로 base/하위 모듈의 실제 권한을 판정하지 않아요.

**LB · 기본 실행기와 의존성**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LB.MANIFEST` | manifest.lb와 의존 자료의 선언/해석 | 미구현 | import, runtime, data | IMPORT, RUNTIME, LIFECYCLE, SAMPLE | 구조화 조회 요약 |
| `LB.CODE` | lore 안의 실행 코드와 일반 지침을 구분하여 로딩 | 미구현 | import, runtime, memory | IMPORT, RUNTIME, MEMORY, SAMPLE | 구조화 조회 요약 |
| `LB.ONINPUT` | onInput hook | 미구현 | runtime, representation | RUNTIME, WIRE, SAMPLE | 구조화 조회 요약 |
| `LB.ONINSTRUCTIONS` | onInstructions hook | 미구현 | runtime, representation | RUNTIME, WIRE, SAMPLE | 구조화 조회 요약 |
| `LB.ONOUTPUT` | onOutput hook | 미구현 | runtime, jobs | RUNTIME, JOBS, SAMPLE | 구조화 조회 요약 |
| `LB.ONMUTATION` | onMutation hook | 미구현 | runtime, state, source | RUNTIME, STATE, SOURCE, SAMPLE | 구조화 조회 요약 |
| `LB.ONVALIDATE` | onValidate hook | 미구현 | runtime, jobs | RUNTIME, JOBS, SAMPLE | 구조화 조회 요약 |
| `LB.LLM` | LLM/axLLM 추가 모델 요청 | 부분 | provider, jobs, runtime | PROVIDER, JOBS, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.PARALLEL` | 병렬 요청과 공통 동시 실행 관리 | 부분 | jobs, runtime | JOBS, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.VALIDATION` | 결과 검증·수정 요청·재시도 | 부분 | jobs, runtime, state | JOBS, RUNTIME, STATE, SAMPLE | 구조화 조회 요약 |
| `LB.LAZYGEN` | 지연 생성과 사용 시 생성 | 미구현 | jobs, ui, runtime | JOBS, UI, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.REROLL` | 결과 재생성과 기존 결과의 귀속 | 부분 | jobs, source, runtime | JOBS, SOURCE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.PATCH` | 상태 patch와 사용자 변경 우선 | 부분 | state, runtime | STATE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.MESSAGE` | 메시지 수정과 결과 렌더링 | 미구현 | source, ui, runtime | SOURCE, UI, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LB.UPDATE` | 네트워크를 통한 자료 업데이트 조회 | 미구현 | runtime, provider | RUNTIME, PROVIDER, SAMPLE | 구조화 조회 요약 |
| `LB.DELEGATION` | base와 하위 모듈 간 의존성·권한 위임 | 미구현 | runtime, import | RUNTIME, IMPORT, SAMPLE | 구조화 조회 요약 |
| `LB.COVERAGE` | 전체 에셋·실제 renderer·핵심 lore 외 동작 잔여 조사 **(조사 공백)** | 미확인 | images, ui, import | IMAGES, UI, IMPORT, SAMPLE | 구조화 조회 요약 |

대응 시 지킬 점:

- `LB.DELEGATION`: 하위 모듈의 LLA=false만으로 저권한 실행이라고 판정하지 않아요. base의 capability와 위임 경계를 확인해요.

### 라이트보드 미니보드 · `lightboard-mini`

전체 Lua 6,965 UTF-16과 선택 핵심 lore를 구조화 조회했어요. lore 12개, regex 4개를 확인했어요.

의존 표본: `lightboard`. 실제 조합·권한 위임은 미검증이에요.

- 미완: base 의존 실행·권한 위임, 전체 자산·renderer, 나머지 lore/세부 조작의 실제 동작은 미검증이에요.

**LM · 미니보드**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LM.POST` | 게시판 글 작성·삭제 | 미구현 | runtime, state, ui | RUNTIME, STATE, UI, SAMPLE | 구조화 조회 요약 |
| `LM.COMMENT` | 댓글 작성·삭제 | 미구현 | runtime, state, ui | RUNTIME, STATE, UI, SAMPLE | 구조화 조회 요약 |
| `LM.SWITCH` | 보드 교체 | 미구현 | runtime, state, ui | RUNTIME, STATE, UI, SAMPLE | 구조화 조회 요약 |
| `LM.IDENTITY` | 인물 정보 유지 | 부분 | memory, state, runtime | MEMORY, STATE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LM.RENDER` | 내용 검증과 게시판 renderer | 미구현 | runtime, ui | RUNTIME, UI, SAMPLE | 구조화 조회 요약 |
| `LM.DEPENDENCY` | 저권한 선언과 고권한 base 의존의 실제 실행 권한 | 미구현 | runtime, import | RUNTIME, IMPORT, SAMPLE | 구조화 조회 요약 |
| `LM.COVERAGE` | 에셋·실제 조합 실행/renderer와 남은 lore 의미 확인 **(조사 공백)** | 미확인 | import, ui, images | IMPORT, UI, IMAGES, SAMPLE | 구조화 조회 요약 |

대응 시 지킬 점:

- `LM.DEPENDENCY`: base가 제공하는 권한까지 의존성 그래프로 대조해요.

### 라이트보드 뉴스 · `lightboard-news`

전체 Lua 7,674 UTF-16과 선택 핵심 lore를 구조화 조회했어요. lore 9개, regex 5개를 확인했어요.

의존 표본: `lightboard`. 실제 조합·권한 위임은 미검증이에요.

- 미완: base 의존 실행·권한 위임, 생성 이미지/캐시와 전체 자산·renderer의 실제 동작은 미검증이에요.

**LN · 뉴스**

| 기능 ID | 보존/확인할 기능 | 현재 기반 | 책임 후보 | 필요 검증 | 정적 근거 |
| --- | --- | --- | --- | --- | --- |
| `LN.LAYOUT` | 신문 구성·스타일·광고 | 미구현 | ui, runtime, representation | UI, RUNTIME, WIRE, SAMPLE | 구조화 조회 요약 |
| `LN.SWITCH` | 보드 교체와 기사 갱신 | 미구현 | ui, state, runtime | UI, STATE, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LN.IMAGES` | 기사 관련 이미지 생성·저장·캐시·표시 | 부분 | images, jobs, runtime | IMAGES, JOBS, RUNTIME, SAMPLE | 구조화 조회 요약 |
| `LN.DEPENDENCY` | base 의존성과 실행 권한 | 미구현 | runtime, import | RUNTIME, IMPORT, SAMPLE | 구조화 조회 요약 |
| `LN.COVERAGE` | 전체 자산·실제 renderer·생성 이미지/캐시와 조합 검증 **(조사 공백)** | 미확인 | images, ui, runtime | IMAGES, UI, RUNTIME, SAMPLE | 구조화 조회 요약 |

대응 시 지킬 점:

- `LN.DEPENDENCY`: base가 제공하는 권한까지 의존성 그래프로 대조해요.

## 공통 기반의 근거

현재 기반의 범위와 한계를 설명하는 소스예요. 미래 결정 문서의 허용이 구현 완료를 뜻하지는 않아요.

| 근거 ID | 위치 | 의미와 한계 |
| --- | --- | --- |
| `U-IMPORT` | [docs/RISU-IMPORT.md:3](../docs/RISU-IMPORT.md#L3), [docs/RISU-PORTING.md:35](../docs/RISU-PORTING.md#L35) | 현재 native JSON 가져오기와 외부 이식 경계. 원본 Risu 직접 가져오기/실행 완료 증거가 아님. |
| `U-PROMPT` | [core/prompt-program.ts:1429](../core/prompt-program.ts#L1429), [docs/PROMPT-RUNTIME.md:77](../docs/PROMPT-RUNTIME.md#L77) | 역할·순서·옵션·계산 AST의 현재 기반. |
| `U-SEGMENT` | [core/source-segments.ts](../core/source-segments.ts), [docs/SOURCE-SEGMENTS.md](../docs/SOURCE-SEGMENTS.md) | 표시·요청 projection 구간 기반. 자료별 의미나 전용 패널을 보장하지 않음. |
| `U-RUNTIME` | [docs/DECISIONS-2026-09-10.md:60](../docs/DECISIONS-2026-09-10.md#L60), [core/package-behavior.ts:23](../core/package-behavior.ts#L23), [core/content-package.ts:48](../core/content-package.ts#L48) | 선언형 기반만 구현된 조사 시점. 새 베타 결정은 코드 실행을 허용하지만 구현 완료를 의미하지 않음. |
| `U-PROVIDER` | [core/provider-definitions.ts:52](../core/provider-definitions.ts#L52), [web/ProviderManagement.tsx:318](../web/ProviderManagement.tsx#L318), [docs/GLOBAL-MODELS.md:17](../docs/GLOBAL-MODELS.md#L17) | 고정 adapter 정의, 모델·연결 편집, 역할 모델. 모든 PM 옵션/플랫폼/라우터를 뜻하지 않음. |
| `U-JOBS` | [server/model-runner.ts:82](../server/model-runner.ts#L82), [server/model-runner.ts:123](../server/model-runner.ts#L123), [server/provider-connection-test.ts](../server/provider-connection-test.ts) | 시도·작업·불확실 실행 보호와 Run 내부 continuation. 외부 Batch/background 재개와 다른 범위. |
| `U-BEHAVIOR` | [core/package-behavior.ts:23](../core/package-behavior.ts#L23), [core/package-behavior.ts:40](../core/package-behavior.ts#L40), [docs/PACKAGE-BEHAVIOR.md:48](../docs/PACKAGE-BEHAVIOR.md#L48) | 구조화 상태·기록된 추첨·사용자/자동/모델 행동. 동일 실행 시점과 순차 효과는 별도 대조 필요. |
| `U-SOURCE` | [server/source-editing.ts](../server/source-editing.ts), [docs/CHAT-BACKUP.md:25](../docs/CHAT-BACKUP.md#L25) | 원문·명시 수정본·분기와 보존 기반. 확장의 메시지 수정 API는 미완. |
| `U-MEMORY` | [docs/LORE-CONTEXT.md](../docs/LORE-CONTEXT.md), [docs/CONTEXT-LIMITS.md](../docs/CONTEXT-LIMITS.md), [server/story-notes.ts](../server/story-notes.ts) | 자료 조회·원문·사용자 메모·문맥 기반. 표본의 기억 출처 판단과 의미 품질은 별도. |
| `U-BACKUP` | [docs/CHAT-BACKUP.md:15](../docs/CHAT-BACKUP.md#L15), [docs/RISU-IMPORT.md:11](../docs/RISU-IMPORT.md#L11) | 현재 채팅 백업과 자료 참조. 새 확장 상태/의존 자료의 이동을 보증하지 않음. |
| `U-READING` | [docs/READING.md:5](../docs/READING.md#L5), [docs/READING.md:29](../docs/READING.md#L29) | 브라우저 표시용 읽기 스타일이며 공유 문서 스타일이 아님. |
| `U-COPY` | [web/SourceReader.tsx:438](../web/SourceReader.tsx#L438) | 원문 또는 유효 번역 한 항목의 저장 텍스트 복사. |
| `U-TRANSCRIPT` | [docs/CHAT-TRANSCRIPT.md:3](../docs/CHAT-TRANSCRIPT.md#L3), [docs/CHAT-TRANSCRIPT.md:23](../docs/CHAT-TRANSCRIPT.md#L23) | 한 분기 본문 JSON 교환. 공유 HTML·전체 백업과 구분. |
| `U-IMAGES` | [docs/ILLUSTRATIONS.md](../docs/ILLUSTRATIONS.md), [docs/PACKAGES.md:77](../docs/PACKAGES.md#L77), [core/package-images.ts:3](../core/package-images.ts#L3) | 이미지 catalog·source anchor·삽화 작업 기반. 외부 자산 전체/표본 renderer 인수가 아님. |
| `U-CACHE` | [docs/MODEL-PARAMETERS.md:55](../docs/MODEL-PARAMETERS.md#L55), [core/provider-cache.ts:19](../core/provider-cache.ts#L19) | 요청 캐시 경계/TTL. Gemini cachedContents lifecycle과 Advisor는 없음. |
| `U-PRICING` | [docs/MODEL-PRICING.md:28](../docs/MODEL-PRICING.md#L28) | 실제/추정/미확인 비용을 분리한 호출별 기록. |

## 조합과 공개 완료 판단

아래는 후속 검증 설계의 시작점이며 원본에서 실제 함께 사용했다고 확인한 조합 목록은 아니에요.

| ID | 표본 | 필요한 검증 |
| --- | --- | --- |
| `COMBO.PHEME.PM` | `pheme-normal`, `pheme-tool`, `provider-manager` | 각 프리셋의 옵션·명령·최종 제출을 PM 대응 provider/도구·cache와 함께 확인해요. |
| `COMBO.LIGHTBOARD` | `lightboard`, `lightboard-mini`, `lightboard-news` | base 의존성과 권한 위임, 게시판·뉴스 생성/수정/재생성·이미지·복원을 함께 확인해요. |
| `COMBO.SHARE` | `logplus`, `hidden-story`, `merry` | 같은 native 표시/구간/에셋 구조로 공유본이 원문과 독립적으로 생성되는지 확인해요. 정확한 조합 fixture는 다음 단계에서 정해요. |
| `COMBO.ALL` | `pheme-normal`, `pheme-tool`, `provider-manager`, `hinano`, `tvon`, `vela`, `hidden-story`, `merry`, `logplus`, `lightboard`, `lightboard-mini`, `lightboard-news` | 사용자가 실제 함께 사용할 조합과 기능별 필수 조합을 확인해 matrix를 완성해요. 앞의 예시 조합만 통과해 전체 인수를 선언하지 않아요. |

공개 gate는 **open**이에요.

1. 각 표본의 미조회 표면·원본 필드/section·기능을 보완하고 `coverage-gap`을 해소해요.
2. 발견한 모든 필수 기능의 구현/adapter와 세부 기대값·실행 영수증을 연결해요. 기존 기능군 아래 새 항목을 추가해도 원본 기능을 누락한 채 닫지 않아요.
3. 단독/필수 조합, 실패·개입·건너뛰기·취소·중복·재시작, 저장·삭제·포크·백업·복원·지원 업그레이드를 확인해요.
4. 실제 provider·이미지·외부 도구·지원 설치 환경에서 필요한 검증을 별도로 준비하고 수행해요. 새로운 유료 호출이나 자료 전송 승인은 이 목록 작성에 포함하지 않아요.
5. 대체 구현의 기능·사용 경험을 사용자가 인수한 뒤 전체 공개 조건을 판단해요. static/hash/합성 PASS만으로 사용자 인수를 대신하지 않아요.

## 목록 유지 규칙

- JSON을 기능 상태의 기준으로 갱신하고 이 문서의 대응표·설명도 함께 맞춰요. 기존 ID는 재사용·재번호화하지 않고 세부 기능은 새 ID로 추가해요.
- `unknown`은 실패도 지원도 아니에요. 근거 없이 더 낙관적인 상태로 바꾸지 않아요. 비어 있는 실제 검증 영수증을 정적 근거로 채우지 않아요.
- 새 소스 hash나 새 버전은 기존 기준을 덮지 말고 사용자 공개 범위와 별도로 평가해요. 파일명이 같아도 hash가 달라지면 같은 표본 검증으로 계산하지 않아요.
- 원본 함수/토글/regex의 세부 locator와 실제 case를 보완하는 작업이 남아 있어요. 이 초안의 기능군·212개 ID가 임의 제작자 코드의 모든 동작을 자동 판별했다고 주장하지 않아요.
