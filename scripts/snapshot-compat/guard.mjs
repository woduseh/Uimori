import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
if (!process.permission || process.permission.has('net') || process.permission.has('child'))
  throw new Error('Unsafe replay permissions');
function deny(object, keys, group) {
  for (const key of keys)
    Object.defineProperty(object, key, {
      value: () => {
        const operation = group + '.' + key;
        appendFileSync('blocked.jsonl', JSON.stringify(operation) + '\n');
        throw new Error('Replay blocked ' + operation);
      },
    });
}
deny(net.Socket.prototype, ['connect'], 'tcp');
deny(dgram, ['createSocket'], 'udp');
deny(
  childProcess,
  ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
  'process'
);
deny(globalThis, ['fetch'], 'network');
for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  deny(
    api,
    Object.getOwnPropertyNames(api).filter((key) => /^(lookup|resolve|reverse)/.test(key)),
    'dns'
  );
}
syncBuiltinESMExports();
