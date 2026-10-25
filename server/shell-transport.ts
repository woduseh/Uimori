import { request } from 'node:http';

/** Shared UTF-8 Unix-socket transport for the existing isolated Linux runner. */
export function shellRunnerRpc(
  socketPath: string,
  path: string,
  payload: unknown,
  timeoutMs = 35_000,
  signal?: AbortSignal
): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(
      {
        socketPath,
        signal,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.setEncoding('utf8');
        let result = '';
        res.on('data', (chunk) => {
          result += chunk;
          // A 64KB binary preview can take six JSON bytes per decoded byte.
          if (result.length > 500_000) req.destroy(new Error('SHELL_RESULT_TOO_LARGE'));
        });
        res.once('error', reject);
        res.on('end', () => {
          try {
            const data = JSON.parse(result);
            if (res.statusCode !== 200 || data.error)
              reject(new Error(data.error ?? 'SHELL_REQUEST_FAILED'));
            else resolve(data);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('SHELL_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}
