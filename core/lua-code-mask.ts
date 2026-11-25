export function luaCodeMask(code: string): string {
  const chars = code.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  const longBracket = (at: number) => /^\[(=*)\[/u.exec(code.slice(at, at + 64));
  while (i < code.length) {
    if (code.startsWith('--', i)) {
      const long = longBracket(i + 2);
      const end = long
        ? code.indexOf(`]${long[1]}]`, i + 2 + long[0].length)
        : code.indexOf('\n', i);
      const stop = end < 0 ? code.length : long ? end + long[1]!.length + 2 : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    const long = code[i] === '[' ? longBracket(i) : null;
    if (long) {
      const end = code.indexOf(`]${long[1]}]`, i + long[0].length);
      const stop = end < 0 ? code.length : end + long[1]!.length + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let k = i + 1;
      while (k < code.length && code[k] !== quote && code[k] !== '\n')
        k += code[k] === '\\' ? 2 : 1;
      blank(i, k + 1);
      i = k + 1;
      continue;
    }
    i++;
  }
  return chars.join('');
}
