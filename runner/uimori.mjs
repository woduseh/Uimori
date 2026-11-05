#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const usage = `Usage:
  uimori tools [operation | --query text | --names name1,name2 | JSON | --input <file|->]
  uimori call <operation> [--key value ... | JSON | --input <file|->]
  uimori apply <relative-file-path>
  uimori refresh <relative-file-path>
  uimori export [JSON | --input <file|->]

Simple --camelCase and --kebab-case flags map to schema fields and are typed against the
operation's actual schema. Arrays and nested objects use JSON or --input. JSON arguments must be
an object; --input - reads stdin. Use uimori tools <operation> for its exact schema.
Examples:
  uimori tools --query appearance
  uimori tools resource.patch
  uimori export '{"scope":"library","id":"<content-id>"}'
  uimori call resource.read --kind content --id <content-id>
  uimori call resource.patch --input patch.json
`;

function input(args) {
  if (!args.length) return {};
  let parsed;
  if (args.length === 2 && args[0] === '--input') {
    parsed = JSON.parse(readFileSync(args[1] === '-' ? 0 : args[1], 'utf8'));
  } else if (args.length === 1 && args[0].trimStart().startsWith('{')) {
    parsed = JSON.parse(args[0]);
  } else {
    parsed = {};
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if (!/^--[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*$/u.test(flag ?? '') || value === undefined)
        throw Error(`Expected --key value pairs, JSON or --input <file|->. See uimori --help.`);
      const key = flag.slice(2).replace(/-([a-z0-9])/gu, (_, letter) => letter.toUpperCase());
      if (Object.hasOwn(parsed, key)) throw Error(`Repeated option ${flag}`);
      parsed[key] = value;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('JSON arguments must be an object');
  return parsed;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (
    !command || command === '--help' || command === 'help' ||
    (args.length === 1 && args[0] === '--help') ||
    (command === 'call' && args.length === 2 && args[1] === '--help')
  ) {
    process.stdout.write(usage);
  } else {
    let payload;
    if ((command === 'apply' || command === 'refresh') && args.length === 1) {
      payload = { path: args[0] };
    } else if (command === 'tools') {
      payload = args.length === 1 && !args[0].startsWith('-') && !args[0].trimStart().startsWith('{')
        ? { arguments: { names: [args[0]] } }
        : args.length && args[0].startsWith('--') && args[0] !== '--input'
          ? { flagArguments: input(args) }
          : { arguments: input(args) };
    } else if (command === 'export') {
      payload = { arguments: input(args) };
    } else if (command === 'call' && args[0] && !args[0].startsWith('--')) {
      const callArgs = args.slice(1);
      payload = {
        name: args[0],
        ...(callArgs.length && callArgs[0].startsWith('--') && callArgs[0] !== '--input'
          ? { flagArguments: input(callArgs) }
          : { arguments: input(callArgs) }),
      };
    } else throw Error(usage);

    if (!process.env.UIMORI_TASK_ID || !process.env.UIMORI_TOOL_ID || !process.env.UIMORI_BRIDGE_SOCKET)
      throw Error('uimori commands run inside an active data.exec workspace');
    const body = JSON.stringify({
      taskId: process.env.UIMORI_TASK_ID,
      toolId: process.env.UIMORI_TOOL_ID,
      ...payload,
    });
    if (Buffer.byteLength(body) > 16_000_000) throw Error('SHELL_INPUT_TOO_LARGE');
    const req = request({
      socketPath: process.env.UIMORI_BRIDGE_SOCKET,
      path: '/' + command,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.pipe(process.stdout, { end: false });
      res.on('end', () => {
        process.stdout.write('\n');
        if (res.statusCode !== 200) process.exitCode = 1;
      });
      res.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    });
    req.setTimeout(35000, () => req.destroy(Error('Uimori request timed out')));
    req.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    req.end(body);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
