import { WRITTEN_LANGUAGES, type WrittenLanguage } from '#contracts';

export { WRITTEN_LANGUAGES, type WrittenLanguage };

export function isWrittenLanguage(value: unknown): value is WrittenLanguage {
  return WRITTEN_LANGUAGES.includes(value as WrittenLanguage);
}

const MIN_LETTERS = 40;
const DOMINANT_SHARE = 0.7;
const JAPANESE_KANA_SHARE = 0.1;
const CHINESE_KANA_SHARE = 0.02;
const ENGLISH_LATIN_SHARE = 0.9;
const ENGLISH_FUNCTION_WORD_SHARE = 0.2;

const NOT_PROSE =
  /```[\s\S]*?```|<(style|script)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<[^<>]*>|\{\{[\s\S]*?\}\}|https?:\/\/\S+/giu;

const ENGLISH_FUNCTION_WORDS = new Set(
  'the a an and or but of to in on at by for with from as is was are were be been it its he she his her him they them their you your i me my we our us that this these those not no had has have do did does would could will if then than so there what when who which into out up over'.split(
    ' '
  )
);

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function isWrittenIn(text: string, language: WrittenLanguage): boolean {
  const prose = text.replace(NOT_PROSE, ' ');
  const letters = count(prose, /\p{L}/gu);
  if (letters < MIN_LETTERS) return false;
  const hangul = count(prose, /\p{Script=Hangul}/gu);
  const kana = count(prose, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(prose, /\p{Script=Han}/gu);
  if (language === 'ko') return hangul / letters >= DOMINANT_SHARE;
  if (language === 'ja')
    return (kana + han) / letters >= DOMINANT_SHARE && kana / (kana + han) >= JAPANESE_KANA_SHARE;
  if (language === 'zh')
    return han / letters >= DOMINANT_SHARE && kana / (kana + han) <= CHINESE_KANA_SHARE;
  if (count(prose, /\p{Script=Latin}/gu) / letters < ENGLISH_LATIN_SHARE) return false;
  const words = prose.toLowerCase().match(/\p{Script=Latin}+/gu) ?? [];
  return (
    words.filter((word) => ENGLISH_FUNCTION_WORDS.has(word)).length / words.length >=
    ENGLISH_FUNCTION_WORD_SHARE
  );
}
