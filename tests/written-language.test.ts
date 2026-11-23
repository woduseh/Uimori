import { expect, test } from 'vitest';
import { isWrittenIn, WRITTEN_LANGUAGES, type WrittenLanguage } from '../core/written-language.js';

const samples: Record<WrittenLanguage | 'fr' | 'de' | 'es', string> = {
  ko: '비가 그친 골목에는 아직 물웅덩이가 남아 있었다. 서연은 우산을 접으며 가게 문을 밀었다. "늦었네." 카운터 뒤에서 민호가 고개도 들지 않고 말했다. 그녀는 대답 대신 젖은 코트를 벗어 의자에 걸었다.',
  en: 'The rain had stopped, but the alley still held its puddles. Seoyeon folded her umbrella and pushed the shop door open. "You are late," Minho said from behind the counter without looking up. She hung her wet coat on the chair instead of answering him.',
  ja: '雨は上がったが、路地にはまだ水たまりが残っていた。ソヨンは傘をたたんで店の扉を押した。「遅かったね」カウンターの奥でミンホが顔も上げずに言った。彼女は答える代わりに濡れたコートを脱いで椅子に掛けた。',
  zh: '雨已经停了，巷子里还留着水洼。书妍收起雨伞，推开了店门。“你来晚了。”柜台后面的敏浩头也不抬地说道。她没有回答，只是脱下湿透的外套，挂在椅子上，然后在窗边的位子坐了下来。',
  fr: 'La pluie avait cessé, mais la ruelle gardait encore ses flaques. Elle replia son parapluie et poussa la porte de la boutique. « Tu es en retard », dit-il derrière le comptoir sans lever les yeux. Elle accrocha son manteau mouillé à la chaise au lieu de répondre.',
  de: 'Der Regen hatte aufgehört, aber in der Gasse standen noch die Pfützen. Sie klappte ihren Schirm zusammen und drückte die Ladentür auf. „Du bist spät“, sagte er hinter der Theke, ohne aufzusehen. Statt zu antworten, hängte sie ihren nassen Mantel über den Stuhl.',
  es: 'La lluvia había cesado, pero el callejón aún guardaba sus charcos. Ella plegó el paraguas y empujó la puerta de la tienda. «Llegas tarde», dijo él detrás del mostrador sin levantar la vista. En lugar de responder, colgó su abrigo mojado en la silla.',
};

test('recognizes each language only in its own prose', () => {
  for (const [written, text] of Object.entries(samples))
    for (const language of WRITTEN_LANGUAGES)
      expect([written, language, isWrittenIn(text, language)]).toEqual([
        written,
        language,
        written === language,
      ]);
});

test('ignores markup, code and template expressions around the prose', () => {
  const wrapped = `<style>.status-panel { display: grid; color: rgb(10, 20, 30); font-family: serif; }</style>
<div class="status-panel" data-location="harbor district">{{img::harbor at night}}</div>
\`\`\`json
{"location": "harbor", "weather": "clear", "time": "late evening", "mood": "quiet and tense"}
\`\`\`
${samples.ko}`;
  expect(isWrittenIn(wrapped, 'ko')).toBe(true);
  expect(isWrittenIn(wrapped, 'en')).toBe(false);
});

test('keeps names and loanwords from another script inside the dominant language', () => {
  expect(isWrittenIn(`${samples.ko} Seoyeon은 Blue Harbor 카페의 단골이었다.`, 'ko')).toBe(true);
  expect(isWrittenIn(`${samples.en} The sign read 푸른 항구.`, 'en')).toBe(true);
});

test('does not claim a language for bilingual or very short text', () => {
  expect(isWrittenIn(`${samples.en}\n\n${samples.ko}`, 'ko')).toBe(false);
  expect(isWrittenIn(`${samples.en}\n\n${samples.ko}`, 'en')).toBe(false);
  expect(isWrittenIn('안녕하세요.', 'ko')).toBe(false);
  expect(isWrittenIn('<div class="panel"></div>', 'en')).toBe(false);
});
