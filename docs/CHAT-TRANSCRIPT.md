# 채팅 본문 추출과 가져오기

채팅 하나의 **본문 기록만** 담는 작은 JSON 형식과 그 추출·가져오기예요. 2026-09-10 [방향 결정 7](DECISIONS-2026-09-10.md)로 만들었어요. 목적은 정식 배포 전 스키마가 바뀌어 DB를 리셋해도 작품 본문을 살리는 것이에요. 전체 archive(`narrative-archive`, v15)는 스키마와 함께 바뀌지만 이 형식은 스키마와 독립이에요.

## 형식 · `uimori-chat-transcript` v1

정의는 `core/chat-transcript.ts`, 검증은 `validateChatTranscript`예요.

| 필드 | 내용 |
| --- | --- |
| `format` · `version` | `uimori-chat-transcript` · `1`. 다른 값은 거절해요. |
| `exportedAt` | ISO 시각. |
| `title` | 채팅 제목(200자). |
| `attachments` | 채팅 프로필의 자료 참조 `{id, revision}` 목록. |
| `packageAttachments` | 장착 패키지 참조 `{id, revision, role}` 목록. `role`은 `bot`·`persona`·`module`. |
| `notes` | 사용자 메모 `{text, author, atIndex}`. `atIndex`는 메모가 붙은 항목 번호이고 `null`은 첫 항목 이전이에요. |
| `entries` | 순서대로 `{request, text, translation}`. `request`는 그 원문을 만든 요청(빈 문자열 가능), `text`는 최신 수정을 반영한 원문, `translation`은 원문 hash가 일치하는 최신 번역 또는 `null`. |

담지 않는 것: Run·snapshot·attempt·사용량·패키지 상태·추첨·삽화·이미지 배치·구성(outline)·도우미 대화·로어 변경·옵션 위임·읽기 위치·폴더. 이 형식은 언어 정보를 갖지 않아요. 번역은 한 벌만 담아요.

한도: 항목 5,000개, 원문 1,000,000자, 요청 20,000자, 번역 2,000,000자, 메모 500개(32,000자), 참조 300개. 알 수 없는 필드는 거절해요.

## 추출

`GET /api/chats/:id/transcript`가 기본 분기의 머리 원문부터 조상을 따라 위 형식을 만들어요(`server/chat-transcript.ts`의 `exportChatTranscript`). 화면에서는 채팅 메뉴(⋯)의 **본문 JSON 내보내기**로 받고 파일 이름은 `<채팅 제목>.transcript.json`이에요. 다른 분기를 담으려면 그 분기를 포크해 새 채팅으로 만든 뒤 내보내요.

## 가져오기

`POST /api/chats/import-transcript` 본문은 `{ transcript, title?, idempotencyKey }`예요. 응답은 `{ chat, created, skippedAttachments }`. 화면에서는 설정 → 데이터 관리 → **채팅 본문 가져오기**에서 파일을 고르면 바로 새 채팅을 만들어요.

- 새 채팅을 만들어요. 기존 채팅에 합치지 않아요.
- 항목마다 완료된 Run 하나와 원문 하나를 일반 실행과 같은 경로(`createRunInTransaction` → `completeRunInTransaction`)로 기록해요. Run은 사용량 0이고 snapshot에 `transcriptImport: { index }`가 있어요. 작성된 도입문과 같이 모델 준비·상태 예약·표시 상태·이미지·삽화 작업은 만들지 않아요.
- 번역은 사용자 직접 편집과 같은 완료 job(`manual: true`, revision 1)으로 넣어요.
- 메모는 `atIndex`에 해당하는 원문이 머리일 때 기록해서 원래 위치에 붙어요.
- 봇 패키지는 이 서재에 있어야 해요. 없으면 `CHAT_TRANSCRIPT_BOT_REQUIRED`로 거절해요. 다른 자료·패키지 참조는 같은 ID의 **현재 저장본**으로 장착하고, 서재에 없는 것은 `skippedAttachments`로 돌려주며 채팅은 만들어요.
- 같은 `idempotencyKey`의 재요청은 이미 만든 채팅을 `created: false`로 돌려줘요. 기록은 `events`의 `chat.transcript-imported`예요.
- 검증 실패는 아무것도 쓰지 않고 400으로 끝나요. 오류 코드는 `CHAT_TRANSCRIPT_*`예요.

가져온 채팅은 리더·포크·전체 archive·다음 실행에서 일반 채팅과 같아요. 검사는 `tests/chat-transcript.test.ts`예요.

## 개발 단계의 사용 순서

1. 스키마를 바꾸는 작업 전에 보존할 채팅마다 본문 JSON을 내보내요.
2. 새 DB를 초기화하고 서재 자료(봇·페르소나·모듈)를 먼저 다시 등록해요. 패키지 JSON은 기존 편집기의 가져오기를 써요.
3. 데이터 관리에서 본문 JSON을 가져와요. 서재에 없는 자료는 응답으로 알려주므로 필요하면 채팅 설정에서 다시 장착해요.

결정 2의 장기 세션 실검증 작품은 이 절차로 보존해요.
