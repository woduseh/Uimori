import { afterEach, expect, test, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { VertexCredentialStore } from '../server/vertex-credentials.js';
import { createApp, type App } from '../server/app.js';
import { validateConnection } from '../core/transport.js';
import type { Connection } from '../core/product.js';

const dirs:string[]=[],apps:App[]=[];
const directory=()=>{const path=mkdtempSync(join(tmpdir(),'uimori-vertex-file-'));dirs.push(path);return path;};
const account={type:'service_account',project_id:'synthetic-project',client_email:'synthetic@synthetic-project.iam.gserviceaccount.com',private_key_id:'abcdef0123456789',
  private_key:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey,
  token_uri:'https://oauth2.googleapis.com/token',universe_domain:'googleapis.com'};
const endpoint='https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models';
const origins=['https://aiplatform.googleapis.com'];
const appAt=async(path:string,accessToken?:string)=>{const app=await createApp({dbPath:path,buildId:'synthetic-test',approvedOrigins:origins,...(accessToken?{accessToken}:{})});apps.push(app);return app;};
afterEach(async()=>{vi.restoreAllMocks();for(const app of apps.splice(0))await app.close();for(const path of dirs.splice(0)){const within=relative(resolve(tmpdir()),resolve(path));if(isAbsolute(within)||within.startsWith('..')||!basename(path).startsWith('uimori-vertex-file-'))throw new Error('Unsafe cleanup');rmSync(path,{recursive:true,force:true});}});

test('upload persists normalized file outside SQLite and survives app restart without network',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
  const oauth=vi.spyOn(GoogleAuth.prototype,'getAccessToken').mockRejectedValue(new Error('OAuth forbidden'));
  const db=join(directory(),'test.sqlite');let app=await appAt(db);
  const uploaded=await app.inject({method:'POST',url:'/api/provider-management/vertex-credentials',payload:{serviceAccount:{...account,extra:'discarded'}}});
  expect(uploaded.statusCode).toBe(200);const reference=uploaded.json();
  expect(reference).toEqual({credentialEnv:expect.stringMatching(/^NARRATIVE_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/),projectId:account.project_id,clientEmail:account.client_email});
  expect(uploaded.body).not.toContain('PRIVATE KEY');
  const saved=await app.inject({method:'POST',url:'/api/connections',payload:{title:'JSON Vertex',protocol:'vertex-gemini-v1',endpoint,credentialEnv:reference.credentialEnv,enabled:true,requestTier:'flex'}});
  expect(saved.statusCode).toBe(200);const connection=saved.json<Connection>();
  const files=readdirSync(db+'.vertex-credentials');expect(files).toHaveLength(1);
  const filename=join(db+'.vertex-credentials',files[0]!);expect(JSON.parse(readFileSync(filename,'utf8'))).not.toHaveProperty('extra');
  if(process.platform!=='win32')expect(statSync(filename).mode&0o777).toBe(0o600);
  expect((await app.inject(`/api/provider-management/connections/${connection.id}/readiness`)).json()).toMatchObject({credentialStatus:'configured'});
  for(const url of ['/api/library','/api/export']){const result=await app.inject(url);expect(result.statusCode).toBe(200);expect(result.body).not.toContain(account.private_key);expect(result.body).not.toContain('BEGIN PRIVATE KEY');}
  expect(readFileSync(db).includes(Buffer.from('BEGIN PRIVATE KEY'))).toBe(false);
  await app.close();apps.splice(apps.indexOf(app),1);app=await appAt(db);
  expect((await app.inject(`/api/provider-management/connections/${connection.id}/readiness`)).json()).toMatchObject({credentialStatus:'configured'});
  expect(fetch).not.toHaveBeenCalled();expect(oauth).not.toHaveBeenCalled();
});

test('resolver mints only for matching Vertex project and app store; token failures are sanitized',async()=>{
  const db=join(directory(),'first.sqlite'),store=new VertexCredentialStore(db),ref=store.upload(account).credentialEnv;
  const connection={id:'synthetic',protocol:'vertex-gemini-v1' as const,endpoint,credentialEnv:ref};
  const token=vi.spyOn(GoogleAuth.prototype,'getAccessToken').mockResolvedValue('synthetic-oauth-token');
  const signal=new AbortController().signal;
  expect(await store.resolve(ref,connection,signal)).toBe('synthetic-oauth-token');expect(token).toHaveBeenCalledTimes(1);
  await expect(store.resolve(ref,{...connection,protocol:'openai-chat-v1'},signal)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  await expect(store.resolve(ref,{...connection,endpoint:endpoint.replace('synthetic-project','another-project')},signal)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  await expect(new VertexCredentialStore(join(directory(),'other.sqlite')).resolve(ref,connection,signal)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  await expect(store.resolve(ref,undefined,signal)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  await expect(store.resolve(ref,connection,AbortSignal.abort())).rejects.toThrow('CANCELLED');
  expect(token).toHaveBeenCalledTimes(1);
  token.mockRejectedValue(new Error(account.private_key));
  await expect(store.resolve(ref,connection,signal)).rejects.toThrow(/^CREDENTIAL_UNAVAILABLE$/);
  expect(()=>validateConnection({...connection,protocol:'openai-chat-v1',endpoint:'http://127.0.0.1:1234/v1'},['http://127.0.0.1:1234'])).toThrow('INVALID_CREDENTIAL_REFERENCE');
});

test('upload is guarded and hostile service accounts never reach GoogleAuth or storage',async()=>{
  const oauth=vi.spyOn(GoogleAuth.prototype,'getAccessToken').mockRejectedValue(new Error('Network forbidden'));
  const db=join(directory(),'guard.sqlite'),app=await appAt(db,'synthetic-access-token');
  const url='/api/provider-management/vertex-credentials',payload={serviceAccount:account};
  expect((await app.inject({method:'POST',url,payload})).statusCode).toBe(401);
  const login=await app.inject({method:'POST',url:'/api/session',payload:{token:'synthetic-access-token'}});
  const cookie=String(login.headers['set-cookie']).split(';')[0]!;
  expect((await app.inject({method:'POST',url,payload,headers:{cookie,origin:'https://evil.example'}})).statusCode).toBe(403);
  for(const change of [{token_uri:'https://evil.example/token'},{universe_domain:'evil.example'},{type:'external_account'},{private_key:'not a key'}]){
    const result=await app.inject({method:'POST',url,headers:{cookie},payload:{serviceAccount:{...account,...change}}});expect(result.statusCode).toBe(400);expect(result.body).not.toContain(account.private_key);
  }
  expect((await app.inject({method:'POST',url,headers:{cookie},payload:{serviceAccount:{...account,extra:'x'.repeat(70*1024)}}})).statusCode).toBe(413);
  expect(oauth).not.toHaveBeenCalled();
  const uploaded=(await app.inject({method:'POST',url,headers:{cookie},payload})).json();
  const bad=await app.inject({method:'POST',url:'/api/connections',headers:{cookie},payload:{title:'Wrong project',protocol:'vertex-gemini-v1',endpoint:endpoint.replace('synthetic-project','another-project'),credentialEnv:uploaded.credentialEnv,enabled:true}});
  expect(bad.statusCode).toBe(400);
});
