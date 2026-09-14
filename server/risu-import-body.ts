import type { ContentPackage } from '../core/content-package.js';
import type { PromptTemplate } from '../core/prompt-program.js';
import { string, type RisuCard } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';
import type { RisuImportText } from './risu-import-text.js';

/**
 * Reads the card's own prose: the description and dialogue examples that become the package body,
 * and the global note that becomes extra writing guidance. Fields Uimori does not carry over are
 * reported here rather than merged into the body.
 */
export function importRisuBody({
  card,
  cardText,
  findings,
}: {
  card: RisuCard;
  cardText: RisuImportText;
  findings: RisuImportFindings;
}): {
  body: string;
  bodyTemplate?: PromptTemplate;
  instructions: ContentPackage['instructions'];
} {
  const body = [
    cardText.convert(card.description),
    string(card.mes_example)
      ? `Authored dialogue examples (not actual chat history):\n${cardText.convert(card.mes_example)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const bodyTemplate = cardText.template(body);
  if (string(card.personality) || string(card.scenario))
    findings.add(
      'legacy-character-fields',
      'info',
      '성격·시나리오 필드는 가져오기 대상에서 제외하며 원본 파일에 보존해요. 봇 설명이나 모델 입력에 합치지 않아요.'
    );
  if (string(card.system_prompt))
    findings.add(
      'main-prompt-override',
      'info',
      '낡은 메인 프롬프트 덮어쓰기 기능은 지원하지 않아요. 이 항목은 원본 파일에만 보존하며 선택한 작문 프롬프트를 유지해요.'
    );
  const instructions: ContentPackage['instructions'] = [];
  if (string(card.post_history_instructions)) {
    // The selected Uimori prompt already supplies its own instructions. A reference to the
    // replaced Risu note has no separate insertion target and must not duplicate that prompt.
    const guidance = cardText.convert(
      string(card.post_history_instructions).replaceAll('{{original}}', '')
    );
    if (guidance.trim()) {
      const template = cardText.template(guidance);
      instructions.push({
        id: 'writing-guidance',
        target: 'main',
        text: guidance,
        ...(template ? { template } : {}),
      });
    }
    findings.add(
      'global-note-as-guidance',
      'info',
      '글로벌 노트는 봇의 추가 작문 지침으로 가져와요. 기존 프롬프트나 전역 설정을 덮어쓰지 않으며, {{original}} 참조는 중복 삽입하지 않아요. 원래 내용과 삽입 위치는 원본 파일에 보존해요.'
    );
  }
  return { body, ...(bodyTemplate ? { bodyTemplate } : {}), instructions };
}

/** Reads the first message and its alternates as the package's authored starts. */
export function importRisuGreetings({
  card,
  cardText,
  findings,
}: {
  card: RisuCard;
  cardText: RisuImportText;
  findings: RisuImportFindings;
}): NonNullable<ContentPackage['starts']> {
  const greetings = [
    card.first_mes,
    ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []),
  ];
  return greetings.flatMap((greeting, index) => {
    if (!string(greeting).trim()) return [];
    const sourceText = cardText.convert(greeting);
    const template = cardText.template(sourceText);
    if (template && /\{\{(?:char|user)\}\}/iu.test(sourceText))
      findings.add(
        'start-names',
        'info',
        '시작문의 {{char}}·{{user}}는 시작을 확정할 때 선택한 봇·페르소나 이름으로 표시해요.'
      );
    return [
      {
        id: `start-${index}`,
        title: index === 0 ? '기본 시작문' : `시작문 ${index + 1}`,
        mode: 'authored' as const,
        text: sourceText,
        ...(template ? { template } : {}),
      },
    ];
  });
}
