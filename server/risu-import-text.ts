import type { PromptTemplate } from '../core/prompt-program.js';
import { validatePackageIdentityTemplate } from '../core/package-identity.js';
import { RisuCbs } from './risu-cbs.js';
import { scanRisuCompatUnsupported } from './compat/risu/cbs.js';
import { string } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/** How every authored field of a card is read: asset references resolved, CBS imported as far as
 *  the package template supports, and the rest preserved as plain text. */
export type RisuImportText = {
  /** Points asset references at the imported images and reports markup that stays text. */
  convert: (value: unknown) => string;
  /** Imports the supported CBS of one field as a template, or keeps name substitution only. */
  template: (value: string) => PromptTemplate | undefined;
  /** The exact stored texts whose preserved CBS the compat evaluator runs at generation time. */
  compatTexts: Set<string>;
};

export function createRisuImportText(
  assetUrls: Map<string, string>,
  findings: RisuImportFindings
): RisuImportText {
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  const compatTexts = new Set<string>();
  const template = (value: string): PromptTemplate | undefined => {
    if (!value.includes('{{')) return;
    try {
      const imported = validatePackageIdentityTemplate(cbs.template(value), [], () => {
        throw new Error('Unsupported imported context');
      });
      if (/\{\{(?!(?:char|user)\}\})/iu.test(value))
        findings.add(
          'template-cbs',
          'warning',
          '지원하는 CBS 읽기·계산·조건을 공통 템플릿으로 가져와요. 채팅의 공유 변수·자료 기본값·선택한 이름을 읽으며 템플릿 평가 자체는 변수를 쓰거나 코드를 실행하지 않아요. 원래 문법과 기본값은 자료에 보존해요.'
        );
      return imported;
    } catch {
      // The original text stays on the package and is evaluated at generation time instead of being
      // converted. `namesOnly` remains the stored template for the paths that have no receipt.
      compatTexts.add(value);
      findings.add(
        'compat-evaluation',
        'warning',
        '공통 템플릿으로 바꿀 수 없는 CBS는 원문 그대로 보존하고, 생성 시점에 Risu 호환 평가기가 채팅의 공유 변수와 선택한 이름을 기준으로 평가해요. 화면·자료 표시 기능은 빈 텍스트가 되고 어떤 기능이 그랬는지 함께 알려드려요.'
      );
      const unsupported = scanRisuCompatUnsupported(value);
      if (unsupported.length)
        findings.add(
          'compat-unsupported-names',
          'unsupported',
          `Uimori가 표현하지 않는 CBS 기능이 있어요: ${unsupported.slice(0, 20).join(', ')}${unsupported.length > 20 ? ' 외' : ''}. 해당 부분은 평가 결과가 빈 텍스트가 되고 원문은 자료에 보존해요.`
        );
      return cbs.namesOnly(value);
    }
  };
  const convert = (value: unknown): string => {
    let result = string(value);
    for (const [from, to] of assetUrls) result = result.replaceAll(from, to);
    if (/\{\{(?:char|user)\}\}/iu.test(result)) {
      findings.add(
        'identity-names',
        'info',
        '{{char}}·{{user}}는 공통 템플릿으로 가져와 선택한 봇·페르소나 이름을 적용해요. 원래 표기도 보존해요.'
      );
    }
    if (/(?<!\{)\{#(?:if|each)|<script\b|risu-trigger|@@[A-Za-z]/iu.test(result))
      findings.add(
        'dynamic-markup',
        'unsupported',
        '로어 명령·HTML 동작은 자동 이식하지 않아요. 해당 문법은 텍스트로 남으며 별도 이식이 필요해요.'
      );
    return result;
  };
  return { convert, template, compatTexts };
}
