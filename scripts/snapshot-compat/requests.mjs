export function timeoutMs(url, overrideSeconds) {
  if (overrideSeconds !== undefined) return overrideSeconds * 1000;
  const pathname = url.split('?')[0];
  const heavy =
    pathname === '/api/backup' ||
    /^\/api\/backups\/[^/]+\/download$/u.test(pathname) ||
    pathname === '/api/uploads' ||
    pathname.endsWith('backup-archive');
  return (heavy ? 900 : 120) * 1000;
}

export async function sendWithRetry(fetchOnce, url, options, report, instance) {
  try {
    return await fetchOnce();
  } catch (error) {
    const connection = error instanceof TypeError && error.message === 'fetch failed';
    if ((options?.method ?? 'GET') !== 'GET' || !connection) throw error;
    report.retries.push({ url, instance, cause: String(error.cause?.code ?? error.cause) });
    return await fetchOnce();
  }
}

export async function request(instance, url, consume, options) {
  let response;
  try {
    response =
      url === '/api/diagnostics/metrics' && instance.initialMetrics
        ? instance.initialMetrics()
        : await instance.request(url, options);
    return await consume(response);
  } catch (cause) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw Object.assign(new Error(String(cause), { cause }), {
      url,
      method: options?.method ?? 'GET',
      instance: instance.name,
    });
  }
}

export async function attempt(report, phase, url, action, instance) {
  try {
    return await action();
  } catch (error) {
    report.errors.push({
      phase,
      url: error?.url ?? url,
      instance: error?.instance ?? instance,
      method: error?.method,
      error: String(error?.stack ?? error),
    });
    return undefined;
  }
}
