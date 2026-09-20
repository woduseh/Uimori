# 채팅 본문 추출과 가져오기

한 분기의 **요청·원문·최신 번역·사용자 메모**를 담는 작은 JSON 형식이에요. 외부에서 작성한 본문을 새 채팅으로 읽거나 글만 교환할 때 사용해요. 모든 분기·자료 본문·이미지·상태·실행 기록까지 보존하려면 [채팅 전체 백업](CHAT-BACKUP.md)을 사용해요. 파일 형식의 버전은 SQLite schema와 독립이며, 지원하지 않는 파일 버전은 거절해요.

## 형식 · `uimori-chat-transcript` v2

가져온 본문은 `source-only-v1` 스냅샷으로 보관하며 모델 호출용 JEV 판정 설정을 주입하지 않아요. 일반 생성의 판정 설정과 가져오기 전용 필드 검증은 별도로 유지해요.

봇 메뉴의 **채팅 가져오기 → 본문만 가져오기**에서는 해당 봇을 대상으로 미리 선택하고 파일 제목·본문 수·메모 수를 확인한 뒤 실행해요. 가져올 사본의 봇 참조만 교체하며 파일 원문과 다른 역할의 자료 참조는 유지해요. 선택한 봇이 이미 다른 역할로 들어 있는 파일은 역할을 몰래 제거하지 않고 거절해요. 이 경우 데이터 관리의 **개별 채팅 가져오기**에서 파일의 소속과 역할을 그대로 사용할 수 있어요. 응답이 불명확하면 같은 요청을 확인하기 전까지 입력 변경과 창 닫기를 막아요.

정의는 `core/chat-transcript.ts`, 검증은 `validateChatTranscript`예요.

| 필드 | 내용 |
| --- | --- |
| `format` · `version` | `uimori-chat-transcript` · `2`. 가져오기는 기존 `1`도 읽어요. |
| `exportedAt` | ISO 시각. |
| `title` | 채팅 제목(200자). |
| `packageAttachments` | 장착 패키지 참조 `{id, revision, role}` 목록. `role`은 `bot`·`persona`·`module`. |
| `notes` | 메모 `{text, author, atIndex, kind, origin?}`. `kind`는 `author-note` 또는 `imported-memory`이며 후자는 `{fileHash, entryId, title}` 출처가 필수예요. `atIndex`는 메모가 붙은 항목 번호이고 `null`은 첫 항목 이전이에요. |
| `entries` | 순서대로 `{request, text, translation}`. `request`는 그 원문을 만든 요청(빈 문자열 가능), `text`는 최신 수정을 반영한 원문, `translation`은 원문 hash가 일치하는 최신 번역 또는 `null`. |

담지 않는 것: Run·snapshot·attempt·사용량·패키지 상태·추첨·삽화·이미지 배치·구성(outline)·도우미 대화·로어 변경·옵션 위임·읽기 위치·폴더. 이 형식은 언어 정보를 갖지 않아요. 번역은 한 벌만 담아요.

v2는 기존 외부 기억을 사용자 지시로 승격시키지 않고 종류와 출처를 그대로 왕복해요. v1은 `kind`와 `origin`이 없는 사용자 메모 형식이므로 종전과 같이 `author-note`로 읽어요. 이미 v1 파일에서 손실된 외부 기억의 분류·출처는 복구할 수 없어요. 그 구분이 필요한 기존 채팅은 v2로 다시 추출하거나 전체 백업을 사용해요. v2에서 종류를 생략하거나 사용자 메모에 외부 출처를 붙이면 거절해요.

한도: 항목 5,000개, 항목마다 원문 2,000,000자·요청 20,000자·번역 2,000,000자, 메모 500개(본문 32,000자·작성자 200자), 각 참조 목록 300개, 채팅 제목 200자예요. 글자 수는 JavaScript 문자열 길이인 UTF-16 단위로 계산해요. 일반 원문 저장·수정과 본문 가져오기는 `core/content-limits.ts`의 같은 원문·번역·제목 한도를 사용하며 내용을 잘라 맞추지 않아요. HTTP 가져오기 본문 한도는 64MiB여서 개별 항목 한도와 별도로 적용돼요. 알 수 없는 필드도 거절해요.

## 추출

`GET /api/chats/:id/transcript`가 기본 분기의 머리 원문부터 조상을 따라 위 형식을 만들어요(`server/chat-transcript.ts`의 `exportChatTranscript`). 내부 함수는 명시한 분기도 추출할 수 있어요. 현재 채팅 메뉴의 다운로드는 **채팅 백업 내보내기**이며 모든 분기를 포함하는 백업 파일을 받아요. 이 메뉴를 본문 JSON 추출로 설명하거나 두 형식을 같은 파일로 다루지 않아요.

## 가져오기

`POST /api/chats/import-transcript` 본문은 `{ transcript, title?, idempotencyKey }`예요. 응답은 `{ chat, created, skippedAttachments }`. 화면에서는 설정 → 데이터 관리 → **채팅 본문 가져오기**에서 외부의 `uimori-chat-transcript` 파일을 고르면 바로 새 채팅을 만들어요. 전체 백업 파일은 같은 화면의 별도 **채팅 백업 가져오기**에서 내용을 확인한 뒤 복원해요.

- 새 채팅을 만들어요. 기존 채팅에 합치지 않아요.
- 항목마다 완료된 Run 하나와 원문 하나를 일반 저장 경로(`createRunInTransaction` → `completeRunInTransaction`)로 기록해요. 모델 호출 수는 0이며 입력·출력 토큰·비용은 `null`이에요. snapshot의 `transcriptImport`는 `{ index, storage: 'source-only-v1' }`이고 `history`는 빈 배열이에요. 작성된 도입문과 같이 모델 준비·상태 예약·표시 상태·이미지·삽화 작업은 만들지 않아요.
- ancestry는 원문의 부모 연결로 관리하므로 이전 본문 전체를 뒤따르는 모든 snapshot에 반복 저장하지 않아요. 본문 저장량은 누적 본문량에 비례해 늘어요. 리더·다음 요청 예약·원문 수정·포크·archive는 이 부모 연결을 읽으며, `source-only-v1` 검증은 snapshot에 가짜 실행 이력이나 모델·상태 실행 필드를 넣는 것을 거절해요.
- 번역은 사용자 직접 편집과 같은 완료 job(`manual: true`, revision 1)으로 넣어요.
- 메모는 `atIndex`에 해당하는 원문이 머리일 때 기록해서 원래 위치에 붙어요.
- 봇 패키지는 이 서재에 있어야 해요. 없으면 `CHAT_TRANSCRIPT_BOT_REQUIRED`로 거절해요. 다른 자료·패키지 참조는 같은 ID의 **현재 저장본**으로 장착하고, 서재에 없는 것은 `skippedAttachments`로 돌려주며 채팅은 만들어요.
- 같은 `idempotencyKey`와 같은 유효 요청의 재요청은 이미 만든 채팅을 `created: false`로 돌려주며 최초 `skippedAttachments`도 유지해요. 검증된 본문·번역·메모·자료 참조와 실제 적용 제목을 비교하고, JSON 속성 순서·내보낸 시각·명시 제목으로 덮인 파일 제목은 비교에서 제외해요. 같은 키의 내용이나 적용 제목이 다르면 `409 CHAT_TRANSCRIPT_IMPORT_CONFLICT`예요. 현재 서재나 가져온 채팅을 나중에 편집해도 최초 요청의 비교 기준은 변하지 않아요.
- 새 키의 같은 파일은 새 채팅이에요. 기존 `events`의 `chat.transcript-imported` 키 기록을 보존하고, 같은 transaction의 `chat.transcript-import-receipt`에 요청 SHA-256과 누락 자료 결과를 저장해요. DB 스키마는 바꾸지 않아요. 과거 키만 있는 기록은 요청이 같았는지 증명할 수 없어 `409 CHAT_TRANSCRIPT_IMPORT_UNVERIFIABLE`로 재사용을 거절해요. 기존 채팅을 확인하고 실제 새 복사본이 필요할 때만 새 키로 가져와요.
- 전체 JSON archive 복원은 영수증을 그대로 보존해요. 새 ID로 만드는 채팅 백업 복원은 두 transcript 이벤트를 `.history`로 보존하며 목적지의 가져오기 키로 사용하지 않아요.
- 검증 실패는 아무것도 쓰지 않고 400으로 끝나요. 오류 코드는 `CHAT_TRANSCRIPT_*`예요.

모든 항목은 하나의 transaction으로 저장해요. 검사는 `tests/chat-transcript.test.ts`에서 최대 원문·제목, 저장 증가 구조, 수정 뒤 ancestry, 포크·archive·다음 예약, HTTP 경로를 확인해요. 반복 측정 스크립트는 `scripts/measure-transcript-import.mjs`예요. 실제 공급자 호출이나 작품 의미 품질은 이 가져오기 검사의 범위가 아니에요.

## 개발 단계의 사용 순서

채팅을 계속 사용할 목적이면 먼저 채팅 전체 백업을 받아요. 본문 JSON만 남기는 경우에는 필요한 봇·페르소나·모듈을 새 서재에 먼저 등록해야 하며, 상태·추첨·다른 분기·실행 기록을 본문 파일에서 복원할 수는 없어요. 정식 배포 전 DB 초기화는 사용자가 보존 범위를 확인한 뒤 별도로 실행해요.
