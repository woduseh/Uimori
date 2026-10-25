#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const usage = `Usage:
  uimori tools [JSON | --input <file|->]
  uimori call <operation> [JSON | --input <file|->]
  uimori apply <relative-file-path>
  uimori refresh <relative-file-path>
  uimori export [JSON | --input <file|->] (main writing workspace)

JSON arguments must be an object. --input - reads JSON from stdin.
tools returns the app catalog or exact schemas (for example {"names":["resource.read"]}).
call uses the same app operations, revision checks and receipts as app.call.
refresh updates clean files in place; dirty files are preserved and latestPath is
a separate editable latest copy. Reconcile into latestPath, then apply latestPath.
`;
function input(args) {
  let text;
  if (args.length === 0) return {};
  if (args.length === 1) text = args[0];
  else if (args.length === 2 && args[0] === '--input')
    text = readFileSync(args[1] === '-' ? 0 : args[1], 'utf8');
  else throw Error('Expected JSON or --input <file|->');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw Error('JSON arguments must be an object');
  return parsed;
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help' || !command) {
    process.stdout.write(usage);
  } else {
    let payload;
    if ((command === 'apply' || command === 'refresh') && args.length === 1) {
      payload = { path: args[0] };
    } else if (command === 'tools' || command === 'export') {
      payload = { arguments: input(args) };
    } else if (command === 'call' && args[0] && !args[0].startsWith('--')) {
      payload = { name: args[0], arguments: input(args.slice(1)) };
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
