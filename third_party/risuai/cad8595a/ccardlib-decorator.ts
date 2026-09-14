// SPDX-License-Identifier: MIT
// Decorator parser of @risuai/ccardlib 0.4.2 (npm), the character-card spec package RisuAI depends on
// at commit cad8595aa39620df4246f56918f0962c2aa0263a (src/ts/process/lorebook.svelte.ts:300 calls it as
// `CCardLib.decorator.parse`).
// Source: https://cdn.jsdelivr.net/npm/@risuai/ccardlib@0.4.2/dist/index.js
//   (SHA-256 of that file: 6570967d77e20c26981a54c833b10c9d983d27954422658c76535422e8e2556b)
//   Declaration: https://cdn.jsdelivr.net/npm/@risuai/ccardlib@0.4.2/dist/index.d.ts:22
//   (SHA-256: e91c0791c3d9b2956c93d14f3cfb6c0957c25742fe59c3452ccb6a34e23f72d4)
// Copyright (c) the ccardlib authors; the package names "kwaroran" as its author. MIT licensed.
//   The package ships no LICENSE file, so no license text could be copied below this header. Its only
//   licensing statement is the package.json field `"license": "MIT"`, quoted here verbatim; the SPDX
//   line above records it. See ./ccardlib-types.ts for the same note at greater length.
// Modifications for Uimori:
//   - Only `parseDecorators` is copied. The published file is minified and bundles the whole package
//     (card version checks, V1/V2/V3 conversion, lorebook conversion); none of that is copied here.
//   - The minified source was expanded back to readable form. Its one-letter locals were renamed:
//     `t`->data, `i`->hook, `r`->lines, `n`->previousRejected, `d`->index, `h`->line, `g`->space,
//     `e`->name, `v`->args, `b`->arg. No statement, condition or order was changed.
//   - TypeScript annotations were added to match the published declaration
//     `parseDecorators(data: string, hook: (name: string, args: string[]) => boolean | void): string`.
//   - `var` semantics were preserved by using `let`/`const` on the same bindings.
//
// Behaviour worth stating explicitly, because ./lorebook.ts and its tests depend on it:
//   - Decorators are only recognised in the leading run of lines. The first line that does not start
//     with `@@` ends the block, and everything from that line on (later `@@` lines included) is body.
//   - Names are NOT lowercased and not otherwise normalised. `@@Depth 3` reaches the hook as `Depth`,
//     which RisuAI's switch does not match, so decorator names are effectively case-sensitive.
//   - Arguments are the part after the first space, split on `,`, each trimmed, empties dropped. So
//     `@@additional_keys a, b` yields `['a','b']` and a decorator with no argument yields `[]`.
//   - `@@@name` is an "else" decorator: it runs only when the previous decorator line was rejected
//     (the hook returned exactly `false`). `@@@end` is rewritten to `@@end` before that test, so it
//     always runs.
//   - A bare `@@` (empty name) is consumed without calling the hook and clears the rejected flag.
//   - The returned body is trimmed at both ends, and the whole input is trimmed before splitting.

/**
 * Splits a lorebook entry's content into its leading `@@` decorator block and the remaining body,
 * calling `hook` for every decorator. Returning `false` from the hook marks that decorator rejected,
 * which enables a following `@@@` fallback line.
 */
export function parseDecorators(
  data: string,
  hook: (name: string, args: string[]) => boolean | void
): string {
  const lines = data.trim().split('\n');
  let previousRejected = false;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].trim();
    if (line === '@@@end') {
      line = '@@end';
    }
    if (line.startsWith('@@')) {
      if (line.startsWith('@@@') && !previousRejected) {
        continue;
      }
      let space = line.indexOf(' ');
      if (space === -1) {
        space = line.length;
      }
      const name = line.slice(line.startsWith('@@@') ? 3 : 2, space);
      const args = line
        .slice(space)
        .split(',')
        .map((arg) => arg.trim())
        .filter((arg) => arg !== '');
      if (name !== '') {
        previousRejected = hook(name, args) === false;
      } else {
        previousRejected = false;
      }
    } else {
      return lines.slice(index).join('\n').trim();
    }
  }
  return '';
}
