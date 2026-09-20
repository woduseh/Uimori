import { evaluateNativeRisuFieldsInWorker } from './risu-native-cbs.js';
import { processNativeRisuTextInWorker, type NativeRisuTextInput } from './risu-native-render.js';
import { runNativeRisuWorker } from './risu-native-worker.js';

type PreparationInput = Pick<NativeRisuTextInput, 'native' | 'context'> & {
  fields: { key: string; fields: Record<string, string> }[];
  greeting?: string;
};

/** One clone of the full context, with the original field/message variable-write order. */
export function prepareNativeRisuTextInWorker(input: PreparationInput) {
  let variables = { ...input.context.variables };
  const issues: string[] = [];
  const fields: Record<string, Record<string, string>> = {};
  for (const entry of input.fields) {
    const result = evaluateNativeRisuFieldsInWorker({
      native: input.native,
      fields: entry.fields,
      context: { ...input.context, variables },
    });
    fields[entry.key] = result.fields;
    variables = result.variables;
    issues.push(...result.issues);
  }
  const process = (text: string, messageIndex: number) => {
    const result = processNativeRisuTextInWorker({
      native: input.native,
      text,
      mode: 'editprocess',
      context: { ...input.context, variables, messageIndex },
    });
    variables = result.variables;
    issues.push(...result.issues);
    return result.text;
  };
  const greeting = input.greeting === undefined ? undefined : process(input.greeting, -1);
  const texts = (input.context.messages ?? []).map((message, index) =>
    process(message.data, index)
  );
  return { fields, greeting, texts, variables, issues: [...new Set(issues)] };
}

export function prepareNativeRisuText(
  input: PreparationInput,
  signal?: AbortSignal,
  timeoutMs = 15_000
) {
  return runNativeRisuWorker<ReturnType<typeof prepareNativeRisuTextInWorker>>(
    new URL('./risu-native-prepare.js', import.meta.url),
    'prepareNativeRisuTextInWorker',
    input,
    timeoutMs,
    signal
  );
}
