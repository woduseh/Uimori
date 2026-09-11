# 패키지가 선언하는 원문 구간

`ContentPackage.sourceSegments`는 원문 일부의 접힘 표시와 모델 전송 제외 규칙이에요. 자료 이름·출처·문구는 실행 권한이나 지침을 만들지 않아요. 규칙을 장착하지 않은 원문은 마커처럼 보이는 문자열도 일반 텍스트예요. 구간 작성을 모델에 요청하는 지침은 패키지 `instructions` 또는 프롬프트가 소유해요.

아래는 외부 자료를 포함하지 않는 선언 예제예요.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "aside",
      "kind": "aside",
      "open": "[aside]",
      "close": "[/aside]",
      "match": "line",
      "label": "별도 장면",
      "expanded": false,
      "exclude": true
    },
    {
      "id": "report",
      "kind": "annotation",
      "open": "<Report>",
      "close": "</Report>",
      "match": "inline",
      "label": "검토 기록",
      "keepLastMessages": 3
    }
  ]
}
```

`line`은 한 줄 경계를, `inline`은 본문 안의 경계를 인식해요. 줄 경계의 `title:true`는 시작 마커 뒤의 제목을 읽어요. 선택적 `scene:{open,close,separator}`는 구간 첫 줄의 머리말을 2개 또는 3개 필드로 떼어 내며, Reader가 장소·때·시점으로 표시해요. 문법은 정규식이나 실행 코드가 아닌 길이 제한이 있는 리터럴이에요. 최대 32개 규칙과 128자 경계를 허용해요. 코드 펜스·CRLF·잘못 닫힌 구간을 구분하고, 손상된 구간은 진단과 저장 원문으로 표시해요.

`when`, `excludeWhen`, `expandedWhen`은 같은 패키지 옵션을 읽는 `PromptExpression`이며 boolean 결과가 필요해요. `when`은 규칙 사용 여부를, 나머지는 제외·기본 펼침 값을 정해요. 편집기는 규칙 초안을 검증 후 적용하고, 조건식은 native JSON으로 작성할 수 있어요. 동일한 규칙의 중복은 합치지만 ID나 마커가 충돌하는 선언은 거부해요.

`expanded`는 화면 상태이고 `exclude`는 요청 정책이에요. 둘은 독립적이에요. `keepLastMessages`는 현재 이력의 논리 메시지 범위에서 최근 N개만 유지하며 0–10,000을 허용해요. 작성된 도입문에는 존재하지 않는 사용자 요청을 추가하지 않아요. 고정된 다섯 메시지 정책은 없어요.

저장 원문·hash는 바꾸지 않아요. 모델 이력·조회·검색·요약에는 같은 제외 범위와 파생 viewHash를 사용해요. 제외 대상인데 경계를 확인할 수 없는 손상은 빈 성공 결과로 통과시키지 않아요. 요약한 출처 범위와 원문시점 정책을 검증해요. 구간은 표시 범위와 전송 범위만 정하고 어떤 서사적 의미도 만들지 않아요. 실행기는 구간이 있다는 이유로 시점·인물 지식 같은 지침을 요청에 넣지 않으며, 그런 의미가 필요하면 패키지 `instructions`나 선택한 프롬프트가 선언해요. 패키지 설정 변경은 과거 Run의 정책을 바꾸지 않아요. 새 Run의 전송 범위는 현재 장착과 옵션으로 결정하므로 규칙을 해제하면 과거 원문의 해당 구간도 새 요청에 포함될 수 있어요. 이때 기존 요약은 변경된 범위와 viewHash 검증을 통과해야 재사용해요.

번역은 전체 원문을 일반 텍스트로 번역하며 구간 마커·대응 범위의 보존을 성공 조건으로 검사하지 않아요. Reader는 번역문 전체를 표시하고 번역문 안에 원문의 구간·이미지 위치를 추정하지 않아요. 구간 Reader에는 구간별 번역을 받는 입력이 없어요. source/hash 귀속은 계속 검사해서 다른 원문 개정의 번역은 표시하지 않아요(`web/translation-display.ts`). 원문 보기의 구간 정책과 읽기 권한은 유지하며, 보관 복원은 현재 Run과 과거 이력 항목의 정책을 각각 원래 snapshot과 대조하고 포크는 source/run ID와 hash 관계를 함께 연결해요.

구간 초상 참조 기능은 제거했어요(2026-09-11). 규칙의 `portrait:{open,close}` 선언은 이제 `SEGMENT_FIELDS`로 거절하며, 그런 선언이 있는 패키지 JSON은 해당 필드를 지워야 저장돼요. 원문 안의 참조 줄은 사라지지 않고 일반 본문 텍스트로 남아 이스케이프해서 보여요. 저장 원문·hash·전송 범위는 이 변경으로 달라지지 않아요. 봇 대표 이미지(`ContentAvatar`), 일반 이미지 자동 배치, 장면 삽화는 그대로예요. 다시 붙이려면 대상 자산의 존재·소유 채팅·개정·hash 확인 규칙을 먼저 정해야 해요. 삽화(`web/image-placement.ts`)가 세 값이 모두 일치할 때만 이미지를 붙이는 것과 같은 이유예요.

패키지 표시 정규식(`transforms`)과의 조합은 이 장면의 원문을 기준으로 판정해요. 선언한 구간 경계가 이 원문에 실제로 있거나 구간 진단이 있을 때만 `target:'source'` 변환을 적용하지 않고 그 이유를 표시 응답의 `issues`로 알려요. 같은 조건에서도 `target:'translation'` 변환은 그대로 적용해요. 규칙은 있지만 이 원문에 해당 경계가 없으면 원문 변환도 정상 적용하고, 이때 화면은 구간 Reader가 아니라 일반 본문 경로로 표시해요. 서버 `server/package-presentation-routes.ts`와 Reader `web/SourceReader.tsx`는 같은 판정(`hasSourceSegmentBoundaries`)을 사용해요. 표시 변환은 저장 원문·hash·구간 전송 제외·이미지 귀속을 바꾸지 않아요.

`scene` 머리말은 유지해요. 초상 참조와 달리 화면에 실제로 연결된 유일한 구간 머리말이고, 임의 리터럴로 경계를 정하는 선언이라 특정 예제 없이도 설명돼요. 다만 구간 편집기에 입력란이 없어서 지금은 패키지 JSON으로만 선언할 수 있고, 필드는 2개 또는 3개여야 해요. 더 일반적인 메타데이터 엔진을 새로 만들 계획은 없어요.

구현은 `core/source-segments.ts`, `core/package-source-segments.ts`, `core/source-context.ts`, `web/SourceSegmentsReader.tsx`와 `server/snapshot-archive.ts`에 있어요. 합성 회귀는 `tests/source-segments.test.ts`, `tests/source-context.test.ts`, `tests/source-segments-integration.test.ts`, `tests/package-presentation.test.ts` 및 구간 Reader·브라우저 검사예요. 구형 전용 패키지의 자동 변환이나 실제 작품 의미 품질을 보장하지 않아요.
