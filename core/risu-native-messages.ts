import type { PromptRoleName } from './risu-prompt.js';

export type NativePromptMessage = { role: PromptRoleName; text: string };

/** Native example dialogue is message data, never part of the character description. */
export function nativeExampleMessages(
  text: string,
  charName: string,
  userName: string
): NativePromptMessage[] {
  const result: NativePromptMessage[] = [];
  let current: NativePromptMessage | undefined;
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (value.toLowerCase() === '<start>') {
      result.push({ role: 'system', text: '[Start a new chat]' });
      current = undefined;
      continue;
    }
    const speakers = [
      ['{{char}}', 'assistant'],
      ['<bot>', 'assistant'],
      [charName, 'assistant'],
      ['{{user}}', 'user'],
      ['<user>', 'user'],
      [userName, 'user'],
    ] as const;
    const speaker = speakers.find(
      ([name]) => name && value.toLowerCase().startsWith(`${name.toLowerCase()}:`)
    );
    if (speaker) {
      current = { role: speaker[1], text: value.slice(speaker[0].length + 1).trimStart() };
      result.push(current);
    } else if (current) current.text += `\n${value}`;
  }
  return result;
}

/** ChatML source remains native text; only its declared message boundaries are projected. */
export function nativeChatMlMessages(text: string): NativePromptMessage[] {
  if (!text.trim().startsWith('<|im_start|>')) throw new Error('RISU_NATIVE_CHATML_INVALID');
  return text
    .trim()
    .split('<|im_start|>')
    .filter(Boolean)
    .map((part) => {
      const match = /^(system|user|assistant)(?:<\|im_sep\|>|[ \r\n])/u.exec(part);
      if (!match) throw new Error('RISU_NATIVE_CHATML_ROLE');
      return {
        role: match[1] as PromptRoleName,
        text: part
          .slice(match[0].length)
          .trim()
          .replace(/<\|im_end\|>$/u, '')
          .replace(/<Thoughts>.+<\/Thoughts>/gsu, ''),
      };
    });
}
