import {
  object,
  present,
  type RisuCard,
  type RisuCardExtension,
  type RisuCardInput,
} from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

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
      if (/regex|customscript|triggerscript|lua|backgroundhtml|customcss|backgroundcss/iu.test(key))
        findings.add(
          'extension-code',
          'unsupported',
          '정규식·트리거·Lua·커스텀 화면 코드가 있어요. 이번 가져오기에서는 실행하지 않으며 별도 이식이 필요해요.'
        );
      else if (/^(risuai|risu|extensions)$/iu.test(key)) pending.push(value);
      else if (
        !/^(?:talkativeness|fav|favorite|moduleNoneImage|depth_prompt|sd_prompt|additionalAssets|emotionImages|viewScreen|utilityBot|license|source|tags|creator|creation_date|modification_date)$/iu.test(
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
