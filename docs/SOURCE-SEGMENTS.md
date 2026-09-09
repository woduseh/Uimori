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

`line`은 한 줄 경계를, `inline`은 본문 안의 경계를 인식해요. 줄 경계의 `title:true`는 시작 마커 뒤의 제목을 읽어요. 선택적 `scene:{open,close,separator}`와 `portrait:{open,close}`는 구간 내부의 장면 정보와 초상 참조를 표시해요. 문법은 정규식이나 실행 코드가 아닌 길이 제한이 있는 리터럴이에요. 최대 32개 규칙과 128자 경계를 허용해요. 코드 펜스·CRLF·잘못 닫힌 구간을 구분하고, 손상된 구간은 진단과 저장 원문으로 표시해요.

`when`, `excludeWhen`, `expandedWhen`은 같은 패키지 옵션을 읽는 `PromptExpression`이며 boolean 결과가 필요해요. `when`은 규칙 사용 여부를, 나머지는 제외·기본 펼침 값을 정해요. 편집기는 규칙 초안을 검증 후 적용하고, 조건식은 native JSON으로 작성할 수 있어요. 동일한 규칙의 중복은 합치지만 ID나 마커가 충돌하는 선언은 거부해요.

`expanded`는 화면 상태이고 `exclude`는 요청 정책이에요. 둘은 독립적이에요. `keepLastMessages`는 현재 이력의 논리 메시지 범위에서 최근 N개만 유지하며 0–10,000을 허용해요. 작성된 도입문에는 존재하지 않는 사용자 요청을 추가하지 않아요. 고정된 다섯 메시지 정책은 없어요.

저장 원문·hash는 바꾸지 않아요. 모델 이력·조회·검색·요약에는 같은 제외 범위와 파생 viewHash를 사용해요. 제외 대상인데 경계를 확인할 수 없는 손상은 빈 성공 결과로 통과시키지 않아요. 요약한 출처 범위와 원문시점 정책을 검증하며 구간 내용을 특정 인물이 안다고 추론하지 않아요. 패키지 설정 변경은 과거 Run의 정책을 바꾸지 않아요. 새 Run의 전송 범위는 현재 장착과 옵션으로 결정하므로 규칙을 해제하면 과거 원문의 해당 구간도 새 요청에 포함될 수 있어요. 이때 기존 요약은 변경된 범위와 viewHash 검증을 통과해야 재사용해요.

번역은 전체 원문을 일반 텍스트로 번역하며 구간 마커·초상 참조·대응 범위의 보존을 성공 조건으로 검사하지 않아요. Reader는 번역문 전체를 표시하고 번역문 안에 원문의 구간·이미지 위치를 추정하지 않아요. source/hash 귀속은 계속 검사해요. 원문 보기의 구간 정책과 읽기 권한은 유지하며, 보관 복원은 현재 Run과 과거 이력 항목의 정책을 각각 원래 snapshot과 대조하고 포크는 source/run ID와 hash 관계를 함께 연결해요.

구현은 `core/source-segments.ts`, `core/package-source-segments.ts`, `core/source-context.ts`, `web/SourceSegmentsReader.tsx`와 `server/snapshot-archive.ts`에 있어요. 합성 회귀는 `tests/source-segments.test.ts`, `tests/source-context.test.ts`, `tests/source-segments-integration.test.ts` 및 구간 Reader·브라우저 검사예요. 구형 전용 패키지의 자동 변환이나 실제 작품 의미 품질을 보장하지 않아요.
