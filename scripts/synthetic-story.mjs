import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { get_encoding } from 'tiktoken';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';

/** Current native authoring format, shared by manual storage measurements. */
export function createSyntheticBot(store, { loreCount = 0 } = {}) {
  const card = {
    name: 'Synthetic measurement bot',
    description: '',
    creator_notes: '',
    ...(loreCount
      ? {
          character_book: {
            entries: Array.from({ length: loreCount }, (_, index) => ({
              comment: `합성 항구 자료 ${index + 1}`,
              keys: [`합성자료${index + 1}`],
              enabled: true,
              content: (
                `항구 자료 ${index + 1}. ` +
                '이 기록은 성능 측정만을 위한 합성 설정이다. 등대의 교대 시간과 배의 출항 순서는 장부에 적으며, 인물의 추측과 확인한 사실은 구분한다. '.repeat(
                  8
                )
              ).slice(0, 300),
            })),
          },
        }
      : {}),
  };
  const pkg = projectNativeRisuPackage(
    {
      version: 2,
      id: 'measurement',
      revision: 1,
      title: card.name,
      description: '',
      lore: [],
      nativeRisu: {
        version: 1,
        card,
        assets: [],
        sourceHash: createHash('sha256').update(JSON.stringify(card)).digest('hex'),
      },
    },
    'bot'
  ).pkg;
  return store.product.content({
    kind: 'bot',
    title: card.name,
    description: '',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });
}

const koreanParagraphs = [
  '미라는 비가 그친 부두에서 오래된 장부를 펼쳤다. 선장이 약속한 날짜와 창고지기가 기억하는 날짜는 달랐다. 그녀는 어느 쪽도 지우지 않고 두 진술 옆에 물음표를 남겼다.',
  '등대의 창문에는 아직 저녁빛이 걸려 있었다. 서준은 젖은 밧줄을 풀면서 바람이 바뀌었다고 말했다. 그러나 바다 쪽 깃발은 조금 전과 같은 방향으로 흔들렸고, 두 사람은 다시 관측하기로 했다.',
  '시장 끝의 찻집에서는 늦은 손님을 위해 물을 끓이고 있었다. 주인은 항구를 떠난 사람의 이름을 기억했지만 행선지는 알지 못했다. 미라는 그 짧은 대답을 기록하고, 더 묻기 전에 상대의 잔이 비기를 기다렸다.',
  '문을 닫은 창고 앞에는 서로 다른 크기의 발자국이 남아 있었다. 누가 먼저 지나갔는지는 쉽게 판단할 수 없었다. 서준은 발자국의 방향과 물웅덩이의 위치만 그렸고, 범인을 정하는 말은 쓰지 않았다.',
  '밤이 깊어지자 바람은 골목 사이에서 낮게 울었다. 두 사람은 오늘 확인한 일과 아직 모르는 일을 따로 읽어 보았다. 약속을 지키려면 서둘러 결론을 내리는 것보다 다음 질문을 정확히 고르는 편이 나았다.',
  '새벽 배를 기다리는 아이는 등불의 기름이 부족하다고 걱정했다. 미라는 남은 양을 재고 교대할 사람에게 장부를 건넸다. 모든 사정이 해결된 것은 아니었지만, 적어도 누구에게 무엇을 맡겼는지는 분명해졌다.',
];

/** Deterministic public synthetic prose; exact tokens are measured outside the timed paths. */
export function syntheticStoryScenes(count, { longStory = false, targetTokens = 7500 } = {}) {
  const tokenizer = get_encoding('o200k_base');
  const tokens = (text) => tokenizer.encode(text, [], []).length;
  try {
    return Array.from({ length: count }, (_, index) => {
      let text;
      if (longStory) {
        const parts = [`제${index + 1}장: 항구의 기록\n\n`];
        let estimated = tokens(parts[0]);
        for (let paragraph = 0; estimated < targetTokens; paragraph++) {
          const part = `${index + 1}장 ${paragraph + 1}번째 기록. ${koreanParagraphs[paragraph % koreanParagraphs.length]}\n\n`;
          parts.push(part);
          estimated += tokens(part);
        }
        text = parts.join('').trimEnd();
      } else {
        text = (
          'Scene ' +
          index +
          '. ' +
          'A traveler records the river and the lantern. '.repeat(200)
        ).slice(0, 8000);
      }
      const tokenCount = tokens(text);
      if (longStory)
        assert.ok(tokenCount >= targetTokens * 0.98 && tokenCount <= targetTokens * 1.04);
      return {
        request: longStory ? `제${index + 1}장의 일을 이어서 기록해 주세요.` : 'Scene ' + index,
        text,
        translation: null,
        metrics: {
          utf16Chars: text.length,
          utf8Bytes: Buffer.byteLength(text),
          tokens: tokenCount,
          sha256: createHash('sha256').update(text).digest('hex'),
          language: longStory ? 'ko' : 'en',
          tokenizer: 'o200k_base',
        },
      };
    });
  } finally {
    tokenizer.free();
  }
}
