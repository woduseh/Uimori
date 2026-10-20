#!/usr/bin/env node
import { request } from 'node:http';

const [command, path] = process.argv.slice(2);
if (command !== 'apply' || !path || !process.env.UIMORI_TASK_ID || !process.env.UIMORI_TOOL_ID) {
  console.error('Usage: uimori apply <relative-file-path>');
  process.exit(2);
}
const body = JSON.stringify({
  taskId: process.env.UIMORI_TASK_ID,
  toolId: process.env.UIMORI_TOOL_ID,
  path,
});
const req = request({
  socketPath: process.env.UIMORI_BRIDGE_SOCKET,
  path: '/apply', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
}, (res) => {
  let text = '';
  res.on('data', (chunk) => { text += chunk; });
  res.on('end', () => {
    process.stdout.write(text + '\n');
    if (res.statusCode !== 200) process.exitCode = 1;
  });
});
req.setTimeout(10000, () => req.destroy(Error('Apply request timed out')));
req.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
req.end(body);
