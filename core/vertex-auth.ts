import { GoogleAuth } from 'google-auth-library';
import { ProviderContractError } from './transport.js';

const clients = new Map<string, GoogleAuth>();

/** Credentials stay in this server process. The SDK is used for tokens, never model retries. */
export async function vertexAccessToken(signal: AbortSignal): Promise<string> {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
  let client = clients.get(keyFile);
  if (!client) {
    client = new GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    clients.set(keyFile, client);
  }
  if (signal.aborted) throw new ProviderContractError('CANCELLED');
  const token = await new Promise<string | null | undefined>((resolve, reject) => {
    const abort = () => reject(new ProviderContractError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    client!
      .getAccessToken()
      .then(resolve, () => reject(new ProviderContractError('CREDENTIAL_UNAVAILABLE')))
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!token || /[\r\n]/u.test(token)) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
  signal.throwIfAborted();
  return token;
}
