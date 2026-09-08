# 서재와 프롬프트 관리

서재는 봇·페르소나·모듈을 정리하는 공간이고, 프롬프트 프리셋은 별도 관리 대상이에요. 봇·페르소나·모듈은 같은 `ContentPackage` 형식을 사용해요. 서재 분류, 자료의 내용 개정, 채팅에서 사용하는 역할을 각각 구분해요. 화면별 선택 후보 정책은 이 저장·실행 계약과 별도로 적용해요.

공유 타입과 조회 helper는 [library-organization.ts](../core/library-organization.ts), 저장·검증·API는 [server/library-organization.ts](../server/library-organization.ts)에 있어요. 패키지 내부 기능은 [PACKAGES.md](PACKAGES.md)를 봐요.

## 정리 정보와 내용 개정

`LibraryOrganization`은 `{revision, folders, items}`예요. 정리 전체의 `revision`은 현재 편집 충돌을 검사하는 CAS 값이며 자료의 내용 개정 번호가 아니에요.

| 값 | 계약 |
|---|---|
| `LibraryCategory` | `bot`, `persona`, `module`, `prompts` |
| `LibraryItemKey` | `{kind: "content" \| "prompt-preset", id}` |
| `LibraryFolder` | `{id, category, title, sortPosition}` |
| `LibraryPlacement` | 항목 키와 `{category, folderId: string \| null}` |

각 항목에는 하나의 분류와 최대 하나의 폴더가 있어요. `folderId: null`은 해당 분류의 미분류예요. 폴더는 분류별로 독립적인 한 단계 구조이며 중첩되지 않아요. 순서는 같은 분류 안에서 0부터 연속된 `sortPosition`으로 저장해요.

`content`는 봇·페르소나·모듈 분류 사이에서 이동할 수 있어요. `prompt-preset`은 `prompts` 분류에만 속하며 콘텐츠 분류로 이동할 수 없어요. 프롬프트의 `main`·`translation` 실행 역할은 프롬프트 자체의 계약으로 유지해요.

분류·폴더 이동은 정리 정보만 바꿔요. 저장된 `Content.kind`, `ContentRef {id, revision}`, `ContentPackage`, 채팅 프로필과 과거 Run snapshot은 다시 쓰지 않아요. 현재 서재 분류를 표시할 때는 `libraryCategory(library, content)`를 사용하고, 폴더 조회는 `libraryFolderOf(library, item)`를 사용해요. `Content.kind`는 새 항목의 최초 분류와 정리 정보가 없는 클라이언트 객체의 기본값으로 사용해요.

패키지를 채팅에 장착할 때는 `{id, revision, role}`로 실제 역할을 고정해요. 현재 서재 분류를 바꿔도 이미 연결된 봇·페르소나·모듈 역할은 바뀌지 않아요. 자료를 역할로 사용하는 동작은 자동 복제나 분류 이동을 수행하지 않아요. 텍스트만 있는 기존 `Content`의 장착 규칙은 공통 패키지의 명시적 역할 장착과 구분해요.

기존 [채팅 폴더](../server/chat-organization.ts)는 특정 봇의 채팅을 정리하는 별도 구조예요. 서재 폴더를 바꿔도 채팅의 봇 소속·채팅 폴더·기본 페르소나는 바뀌지 않아요.

## API와 동시 편집

`GET /api/library`와 `GET /api/library?view=summary`는 같은 `organization`을 포함해요. 정리 정보만 다시 조회할 때는 `GET /api/library/organization`을 사용해요. 아래 변경 API는 성공 시 전체 `LibraryOrganization`을 반환해요.

| API | 요청 |
|---|---|
| `POST /api/library/folders` | `{expectedRevision, category, title}` |
| `PATCH /api/library/folders/:id` | `{expectedRevision, title?, beforeFolderId?}` |
| `DELETE /api/library/folders/:id` | `{expectedRevision}` |
| `POST /api/library/organization/move` | `{expectedRevision, items, category, folderId}` |

모든 변경은 하나의 DB transaction에서 현재 정리 revision을 검사하고 성공한 변경마다 revision을 한 번 증가시켜요. 다른 화면의 변경으로 revision이 달라졌으면 409이며 일부만 적용하지 않아요. 존재하지 않는 항목·폴더, 다른 분류의 목적지 폴더, 잘못된 종류와 알 수 없는 요청 필드도 거부해요.

폴더 순서 변경은 `beforeFolderId`가 가리키는 같은 분류의 다른 폴더 바로 앞으로 이동해요. `null`이면 마지막으로 보내고, 필드를 생략하면 순서를 유지해요. 폴더 이름은 200자 이내의 비어 있지 않은 문자열이며 ID로 구분해요.

다중 이동은 1–1,000개의 중복 없는 항목을 받아요. 항목 전체와 목적지를 검증한 뒤 한 번에 반영하므로, 일부 ID가 사라졌거나 프롬프트와 콘텐츠를 잘못 섞으면 전체 요청이 실패해요. 이동은 항목의 내용 개정을 만들지 않아요.

폴더 삭제는 포함된 항목을 같은 분류의 미분류로 이동시키고 남은 폴더 순서를 정리해요. 자료 자체를 삭제하지 않아요. 자료·프롬프트의 최초 생성은 해당 분류의 미분류 배치를 만들며 정리 revision을 증가시켜요. 자료 삭제는 기존 참조 보호를 통과한 경우에만 배치를 함께 제거하고 revision을 증가시켜요. 배치 자체는 삭제를 막는 실행 참조로 취급하지 않아요.

자료 저장과 후속 폴더 이동은 별도 요청이에요. 저장이 성공한 뒤 이동에서 충돌이 나면 저장된 항목은 유지되므로, 정리 정보를 다시 조회하고 이동만 다시 시도해요. 이미 성공한 자료 생성 요청을 새 ID로 반복하지 않아요.

## 대표 이미지와 고정된 개정

대표 이미지는 기존 패키지의 `images`와 `portraitImageId`를 사용해요. 파일은 SHA-256으로 식별하는 불변 이미지 blob으로 저장하며, 별도의 프로필 파일 저장소를 만들지 않아요. PNG·JPEG·WebP를 파일당 2,000,000 bytes까지 허용해요.

대표 이미지 지정·변경·해제는 자료 내용의 새 개정으로 저장해요. 대표 지정을 해제해도 이미지 목록의 파일 참조는 유지할 수 있어요. 현재 개정에서 이미지 참조를 제거하더라도 과거 개정과 Run에서 참조하는 이미지는 보존해요. 대표 이미지 전용 파일은 `allowedUse: "profile"`로 관리하며 본문 사용 여부와 구분해요.

서재 summary는 최신 개정의 대표 이미지 URL·제목을 `coverImage`로 제공하고 본문·패키지 전체·이미지 bytes를 목록에 싣지 않아요. 이미 연결된 자료는 고정된 `{id, revision}`의 패키지 이미지를 표시해야 하며, 최신 서재 이미지를 과거 개정의 이미지로 대신 사용하지 않아요. 이미지가 없거나 로드에 실패한 경우의 표시와 대표 이미지 편집은 공통 화면 컴포넌트가 처리해요.

## 제거한 독립 자료 종류와 공통 참조

현재 `ContentKind`는 `bot | persona | module`뿐이에요. 독립 `lore`, `canon`, `skill`, `glossary` 종류와 기타 자료 분류는 생성·보관 복원에서 거부해요. 세계관은 패키지 내부 `lore`, 창작·번역 지침은 `instructions`와 대상 역할로 작성해요. 패키지 내부 로어, 공통 읽기 도구와 원문·상태·기억의 출처 검증은 유지해요.

보조 실행의 `SourceTimeContext`에는 구형 독립 glossary/canon 필드 대신 `references: {id, revision, text}[]`를 사용해요. 원문 Run의 `profile.contents`에서 `module`이며 `pinned`인 본문만 이 배열에 고정해요. 패키지의 대상별 지침·로어는 기존 `packages` 투영으로 제공하고, 조회 자료는 원문 시점에 허용된 자료와 읽기 도구 범위를 유지해요. 현재 서재의 편집 내용이 이미 생성한 원문의 번역·이미지·상태 문맥에 끼어들지 않아요. 이야기의 정사 선언·canon hash, source/hash 귀속과 불확실 실행의 자동 재생 금지 규칙은 그대로예요.

## 저장 형식과 검증 범위

현재 DB schema와 전체 `narrative-archive` 버전은 12예요. `library_organization_state`, `library_folders`, `library_placements`를 전체 보관에 포함하며 SQLite backup에도 저장해요. 복원은 폴더 순서, 분류 일치, 모든 항목의 배치, 존재하는 자료 참조와 전역 revision을 검증하고 오류 시 전체 transaction을 되돌려요.

구형 DB·archive는 이관하지 않아요. 개발 DB 초기화가 필요하면 서버를 멈추고 고정된 기본 개발 DB만 대상으로 하는 `npm run reset:dev`를 사용해요. 단일 패키지 JSON에는 전역 서재 폴더를 넣지 않으며 새로 저장한 자료는 미분류에서 시작해요.

[library-organization.test.ts](../tests/library-organization.test.ts)는 실제 임시 SQLite DB로 CAS·다중 이동 원자성·역할/개정 보존·폴더 삭제·자료 삭제 보호·archive 위조 거부·대표 이미지의 최신/과거 개정 분리를 검사해요. 이 검사는 브라우저의 전체 선택 정책이나 실제 공급자 의미 품질을 증명하지 않아요. 전체 UI·통합 실행의 완료 증거는 [현재 상태](../project-plan/CURRENT.md)를 기준으로 확인해요.
