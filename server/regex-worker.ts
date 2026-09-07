import { parentPort, workerData } from 'node:worker_threads';
import type { RegexRule } from './presentation.js';

// This worker contains no evaluation of code, HTML, or replacement functions.
const { source, rules, maxOutput } = workerData as {
  source: string;
  rules: RegexRule[];
  maxOutput: number;
};
try {
  let text = source;
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    let output = '',
      cursor = 0;
    const append = (part: string) => {
      if (output.length + part.length > maxOutput) throw new Error('OUTPUT_LIMIT');
      output += part;
    };
    for (;;) {
      const match = regex.exec(text);
      if (!match) break;
      append(text.slice(cursor, match.index));
      append(rule.replacement);
      cursor = match.index + match[0].length;
      if (!regex.global) break;
      if (!match[0].length) {
        const cp = text.codePointAt(regex.lastIndex);
        regex.lastIndex += regex.unicode && cp !== undefined && cp > 0xffff ? 2 : 1;
      }
    }
    append(text.slice(cursor));
    text = output;
  }
  parentPort?.postMessage({ text });
} catch (error) {
  parentPort?.postMessage({
    error:
      error instanceof Error && error.message === 'OUTPUT_LIMIT'
        ? 'OUTPUT_LIMIT'
        : 'INVALID_PATTERN',
  });
}
