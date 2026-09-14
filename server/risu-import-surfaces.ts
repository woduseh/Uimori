import {
  object,
  present,
  type RisuCard,
  type RisuCardExtension,
  type RisuCardInput,
} from './risu-import-card.js';
import type { RisuImportFinding } from '../core/risu-import.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/**
 * The configured surfaces a card carries that this import does not reproduce, each named under its
 * own code. Reporting them here is what keeps an extension key from disappearing without a notice.
 */
const SURFACES: {
  match: RegExp;
  code: string;
  level: RisuImportFinding['level'];
  message: string;
}[] = [
  {
    match: /^(?:viewScreen|inlayViewScreen)$/iu,
    code: 'view-screen',
    level: 'unsupported',
    message:
      '감정 표시·이미지 생성 같은 화면 표현 설정이 있어요. 이번 가져오기에서는 재현하지 않으며 격리된 패널로 별도 이식해야 해요.',
  },
  {
    match: /^(?:emotionImages|emotions|additionalAssets)$/iu,
    code: 'emotion-assets',
    level: 'unsupported',
    message:
      '확장 설정에 담긴 감정·추가 에셋 목록은 읽지 않고 원본 파일에만 보존해요. 카드 첨부(`assets`)에 들어 있는 감정·추가 이미지는 역할 없이 일반 이미지로만 들어와요.',
  },
  {
    match: /^utilityBot$/iu,
    code: 'utility-bot',
    level: 'info',
    message:
      '유틸리티 봇 설정은 가져오지 않아요. 이 자료는 일반 봇으로 등록하며 설정은 원본 파일에 보존해요.',
  },
  {
    match: /^license$/iu,
    code: 'card-license',
    level: 'info',
    message: '카드의 라이선스 표기는 자료 필드로 옮기지 않고 원본 파일에만 보존해요.',
  },
  {
    match: /^source$/iu,
    code: 'card-source',
    level: 'info',
    message: '카드의 출처 링크는 자료 필드로 옮기지 않고 원본 파일에만 보존해요.',
  },
  {
    match: /^(?:sd_prompt|sdData)$/iu,
    code: 'image-generation',
    level: 'info',
    message:
      '이미지 생성 프롬프트·설정은 가져오지 않아요. 이 앱의 이미지 생성 설정을 바꾸지 않으며 원본 파일에 보존해요.',
  },
  {
    match: /^depth_prompt$/iu,
    code: 'depth-prompt',
    level: 'info',
    message:
      '깊이 지정 프롬프트는 가져오지 않아요. RisuAI도 카드를 읽을 때 이 항목을 지우므로 원본 파일에만 보존해요.',
  },
];

/**
 * Walks the card's extension bags to name the executable or configured surfaces this import does
 * not carry over, and the module a CharX file embeds. Traversal only reads keys: nothing here runs
 * the code or settings it finds.
 */
export function scanRisuExtensionSurfaces({
  input,
  card,
  risu,
  findings,
}: {
  input: RisuCardInput;
  card: RisuCard;
  risu: RisuCardExtension;
  findings: RisuImportFindings;
}): void {
  // Traverse data only to identify executable/configured extension surfaces, never to execute them.
  const pending: unknown[] = [card.extensions];
  while (pending.length) {
    const current = object(pending.pop());
    for (const [key, value] of Object.entries(current)) {
      if (current === risu && ['customScripts', 'defaultVariables', 'triggerscript'].includes(key))
        continue;
      if (!present(value)) continue;
      // Risu writes viewScreen: 'none' for a card with no special screen, so nothing is dropped.
      if (/^viewScreen$/iu.test(key) && value === 'none') continue;
      if (/regex|customscript|triggerscript|lua|backgroundhtml|customcss|backgroundcss/iu.test(key))
        findings.add(
          'extension-code',
          'unsupported',
          '정규식·트리거·Lua·커스텀 화면 코드가 있어요. 이번 가져오기에서는 실행하지 않으며 별도 이식이 필요해요.'
        );
      else if (/^(risuai|risu|extensions)$/iu.test(key)) pending.push(value);
      else {
        const surface = SURFACES.find((item) => item.match.test(key));
        if (surface) findings.add(surface.code, surface.level, surface.message);
        else if (
          !/^(?:talkativeness|fav|favorite|moduleNoneImage|tags|creator|creation_date|modification_date)$/iu.test(
            key
          )
        )
          findings.add(
            'extension-settings',
            'unsupported',
            '추가 확장 설정이 있어요. 현재 가져오기에서 지원을 확인할 수 없어 별도 검토가 필요해요.'
          );
      }
    }
  }
  if ('embeddedModule' in input && input.embeddedModule) {
    findings.add(
      'embedded-module',
      'info',
      'CharX 내부 모듈의 로어·정규식·트리거를 이 자료의 내용으로 읽어요. 카드에 중복된 로어를 다시 추가하지 않으며 실행 지원 여부는 각각 안내해요.'
    );
    if (input.embeddedModule.assetCount)
      findings.add(
        'embedded-module-assets',
        'unsupported',
        '카드 첨부와 별개인 내부 모듈 에셋은 원본에 보존하며 자동 연결하지 않아요.'
      );
  }
}
