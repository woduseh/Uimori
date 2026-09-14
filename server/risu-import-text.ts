import type { PromptTemplate } from '../core/prompt-program.js';
import { validatePackageIdentityTemplate } from '../core/package-identity.js';
import { RisuCbs } from './risu-cbs.js';
import { string } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/** How every authored field of a card is read: asset references resolved, CBS imported as far as
 *  the package template supports, and the rest preserved as plain text. */
export type RisuImportText = {
  /** Points asset references at the imported images and reports markup that stays text. */
  convert: (value: unknown) => string;
  /** Imports the supported CBS of one field as a template, or keeps name substitution only. */
  template: (value: string) => PromptTemplate | undefined;
};

export function createRisuImportText(
  assetUrls: Map<string, string>,
  findings: RisuImportFindings
): RisuImportText {
  const cbs = new RisuCbs(new Map(), { names: 'context' });
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
      findings.add(
        'dynamic-text',
        'unsupported',
        '지원하지 않는 CBS 또는 한도를 넘는 템플릿이 있어요. 해당 항목은 이름 치환만 적용하고 나머지 문법을 텍스트로 보존하며 별도 이식이 필요해요.'
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
    if (/\{#(?:if|each)|<script\b|risu-trigger|@@[A-Za-z]/iu.test(result))
      findings.add(
        'dynamic-markup',
        'unsupported',
        '로어 명령·HTML 동작은 자동 이식하지 않아요. 해당 문법은 텍스트로 남으며 별도 이식이 필요해요.'
      );
    return result;
  };
  return { convert, template };
}
