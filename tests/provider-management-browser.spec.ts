import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import type { Chat, ChatDetail } from '../core/types.js';
import { generateKeyPairSync } from 'node:crypto';
import { defaultSolOptions } from '../core/sol-config.js';

async function api<T>(request:APIRequestContext,path:string,body?:unknown,method='POST'):Promise<T> {
  const response=body===undefined?await request.get('/api'+path):await request.fetch('/api'+path,{method,data:body});expect(response.ok(),await response.text()).toBeTruthy();return response.json();
}
const library=(request:APIRequestContext)=>api<Library>(request,'/library');
const connectionInput=(title:string)=>({title,protocol:'sol-responses-v1',endpoint:'http://127.0.0.1:9/v1',credentialEnv:'NARRATIVE_PROVIDER_PM_SYNTHETIC',enabled:true});
const modelInput=(connection:Connection,title:string)=>({title,connectionId:connection.id,connectionRevision:connection.revision,modelId:'synthetic-model',maxOutputTokens:8192,temperature:null,sol:defaultSolOptions(),enabled:true});
const connectionBody=(item:Connection,changes:Record<string,unknown>={})=>({title:item.title,protocol:item.protocol,endpoint:item.endpoint,credentialEnv:item.credentialEnv,enabled:item.enabled,...(item.requestTier?{requestTier:item.requestTier}:{}),expectedRevision:item.revision,...changes});
async function settings(page:Page) {
  await page.goto('/');const button=page.getByRole('button',{name:'설정',exact:true});if(!await button.isVisible())await page.getByRole('button',{name:'탐색 메뉴',exact:true}).click();await button.click();await page.getByRole('tab', { name: '연결과 모델', exact: true }).click();await expect(page.getByTestId('connection-editor')).toBeVisible();
}
function observe(page:Page) {
  const errors:string[]=[],generations:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&/\/(?:runs|translation|retranslate)$/.test(new URL(request.url()).pathname))generations.push(request.url());});return {errors,generations};
}

test('PMUI01 mobile template registration selects the connection, reports catalog failure honestly and saves manual options',async({page,request},info)=>{
  await page.setViewportSize({width:390,height:844});const title='PMUI01 '+Date.now(),observed=observe(page);await settings(page);
  const form=page.getByRole('form',{name:'연결 편집 양식'}),modelForm=page.getByRole('form',{name:'모델 편집 양식'});
  await page.getByRole('button',{name:'빠른 연결 시작',exact:true}).click();await page.getByRole('region',{name:'제공자 선택',exact:true}).getByRole('button',{name:/Sol · Responses/}).click();await form.getByLabel('연결 프로토콜').selectOption('sol-responses-v1');await expect(form.getByLabel('API 기본 주소')).toHaveValue('https://ai-gateway.vercel.sh/v1');
  await form.getByText('연결 템플릿 정보',{exact:true}).click();await expect(form.getByText(/sol-responses-v1 · v1/)).toBeVisible();await expect(form.getByText('2026-09-07',{exact:true})).toBeVisible();
  await form.getByLabel('Sol 게이트웨이').selectOption('local');await form.getByLabel('API 기본 주소').fill('http://127.0.0.1:9/v1');await form.getByLabel('연결 이름',{exact:true}).fill(title);await form.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_PM_SYNTHETIC');await form.getByLabel('이 연결 사용').check();await form.getByRole('button',{name:'연결 등록',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:title+' 연결 등록됨'})).toBeVisible();const connection=(await library(request)).connections.find(item=>item.title===title)!;expect(connection).toBeTruthy();
  await expect(modelForm.getByLabel('모델 연결')).toHaveValue(`${connection.id}@${connection.revision}`);await modelForm.getByText('연결 준비 상태와 목록 새로고침',{exact:true}).click();await expect(modelForm.getByRole('region',{name:'선택한 연결 준비 상태'})).toContainText('사용 전 설정 확인이 필요해요');
  // Only the UI's error handling is mocked; no outbound catalog request is sent.
  await page.route(`**/api/connections/${connection.id}/catalog`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...connection,catalogError:'CATALOG_UNAVAILABLE'})}));
  await modelForm.getByLabel('모델 ID',{exact:true}).fill('synthetic/manual-id');await modelForm.getByRole('button',{name:'모델 목록 새로고침',exact:true}).click();
  await expect(page.getByTestId('connection-editor').getByRole('alert')).toContainText('모델 목록을 확인하지 못했어요');await expect(page.getByRole('status').filter({hasText:'모델 목록 조회 완료'})).toHaveCount(0);await expect(modelForm.getByLabel('모델 ID',{exact:true})).toHaveValue('synthetic/manual-id');
  await modelForm.getByLabel('모델 프리셋 이름').fill(title+' 수동 모델');await modelForm.getByRole('button',{name:'고급 옵션',exact:true}).click();await modelForm.getByLabel('Sol 추가 도구 라운드').fill('2');await modelForm.getByText('기능 확인과 사용자 판단',{exact:true}).click();await modelForm.getByLabel('도구 호출 지원 판단').selectOption('yes');await modelForm.getByLabel('구조화 출력 지원 판단').selectOption('no');await modelForm.getByLabel('기능 판단 메모').fill('합성 사용자 판단 · 공급자 검증 결과 아님');
  for(const label of ['모델 프리셋 이름','모델 연결','모델 ID','Sol 문맥 제공','도구 호출 지원 판단','구조화 출력 지원 판단']){await modelForm.getByRole('button',{name:['모델 프리셋 이름','모델 연결','모델 ID'].includes(label)?'기본 정보':'고급 옵션',exact:true}).click();const control=modelForm.getByLabel(label,{exact:true});await control.scrollIntoViewIfNeeded();const box=await control.boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);}
  await modelForm.getByLabel('도구 호출 지원 판단').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('provider-management-mobile-capabilities.png')});await modelForm.getByRole('button',{name:'기본 정보',exact:true}).click();await modelForm.getByLabel('모델 프리셋 이름').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('provider-management-mobile-model.png')});await modelForm.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();await expect(page.getByRole('status').filter({hasText:title+' 수동 모델 모델 프리셋 등록됨'})).toBeVisible();
  const saved=(await library(request)).models.find(item=>item.title===title+' 수동 모델')!;expect(saved).toMatchObject({connectionId:connection.id,connectionRevision:1,modelId:'synthetic/manual-id',sol:{maximumToolRounds:2},userOverrides:{tools:true,structuredOutput:false,note:'합성 사용자 판단 · 공급자 검증 결과 아님'},source:{kind:'manual',connectionRevision:1,catalogUpdatedAt:null}});
  await expect(page.getByRole('region',{name:'등록한 모델 사용 방법'})).toContainText('기존 이야기는 이야기 설정 → 모델');expect(observed.errors).toEqual([]);expect(observed.generations).toEqual([]);
});

test('PMUI02 connection clone requires review and stale edits retain their draft and CAS revision until explicit reload',async({page,request},info)=>{
  await page.setViewportSize({width:1440,height:1000});const title='PMUI02 '+Date.now(),observed=observe(page);const original=await api<Connection>(request,'/connections',connectionInput(title));await settings(page);const form=page.getByRole('form',{name:'연결 편집 양식'});
  await page.getByRole('button',{name:'연결 관리',exact:true}).click();await page.getByLabel('연결·모델 검색').fill(title);await page.getByRole('button',{name:title+' 연결 복제',exact:true}).click();await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(title+' 복사');await expect(form.getByLabel('이 연결 사용')).not.toBeChecked();await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue('NARRATIVE_PROVIDER_PM_SYNTHETIC');expect((await library(request)).connections.filter(item=>item.title.startsWith(title))).toHaveLength(1);
  await form.getByRole('button',{name:'연결 등록',exact:true}).click();await expect(page.getByRole('status').filter({hasText:title+' 복사 연결 등록됨'})).toBeVisible();const copied=(await library(request)).connections.find(item=>item.title===title+' 복사')!;expect(copied.id).not.toBe(original.id);expect(copied.enabled).toBe(false);expect((await library(request)).connections.find(item=>item.id===original.id)).toEqual(original);
  await page.getByRole('button',{name:'연결 관리',exact:true}).click();await page.getByRole('button',{name:title+' 연결 수정',exact:true}).click();await form.getByLabel('연결 이름',{exact:true}).fill(title+' 내 초안');
  const changed=await api<Connection>(request,`/connections/${original.id}`,connectionBody(original,{title:title+' 다른 변경'}),'PUT');await page.getByRole('button',{name:'목록 새로고침',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'목록을 새로 읽었어요'})).toBeVisible();await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(title+' 내 초안');await expect(form).toContainText('편집 기준 v1');
  const put=page.waitForRequest(request=>request.method()==='PUT'&&request.url().endsWith(`/connections/${original.id}`));await form.getByRole('button',{name:'연결 변경 저장',exact:true}).click();expect((await put).postDataJSON().expectedRevision).toBe(1);await expect(form.getByRole('alert')).toContainText('초안은 유지했어요');await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(title+' 내 초안');expect((await library(request)).connections.find(item=>item.id===original.id)).toEqual(changed);
  await form.screenshot({path:info.outputPath('provider-management-desktop-conflict.png')});await form.getByRole('button',{name:'최신 연결 다시 불러오기 · 초안 교체',exact:true}).click();await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(changed.title);await expect(form).toContainText('편집 기준 v2');await form.getByLabel('연결 이름',{exact:true}).fill(title+' 검토 완료');await form.getByRole('button',{name:'연결 변경 저장',exact:true}).click();await expect.poll(async()=>(await library(request)).connections.find(item=>item.id===original.id)?.revision).toBe(3);expect(observed.errors).toEqual([]);expect(observed.generations).toEqual([]);
});

test('PMUI03 model edit and clone preserve frozen connection versions; deactivation keeps pinned story roles and requires confirmation',async({page,request},info)=>{
  await page.setViewportSize({width:1440,height:1000});const title='PMUI03 '+Date.now(),observed=observe(page);const connection=await api<Connection>(request,'/connections',connectionInput(title));const original=await api<ModelPreset>(request,'/model-presets',modelInput(connection,title+' 원본'));
  const chat=await api<Chat>(request,'/chats',{title:title+' 기존 이야기'});const before=await api<ChatDetail>(request,`/chats/${chat.id}`);const profile=before.profile!;await api(request,`/chats/${chat.id}/profile`,{expectedRevision:profile.revision,attachments:profile.attachments,creative:profile.creative,routes:{...profile.routes,main:{id:original.id,revision:1}},image:false},'PUT');
  await api(request,`/connections/${connection.id}`,connectionBody(connection,{title:title+' 연결 최신판'}),'PUT');await settings(page);await page.getByLabel('연결·모델 검색').fill(title);await page.getByRole('button',{name:original.title+' 모델 수정',exact:true}).click();const form=page.getByRole('form',{name:'모델 편집 양식'});await expect(form.getByLabel('모델 연결')).toHaveValue(`${connection.id}@1`);await expect(form).toContainText('보관된 버전');await form.getByLabel('모델 프리셋 이름').fill(title+' 수정 모델');await form.getByRole('button',{name:'생성 설정',exact:true}).click();await form.getByLabel('최대 출력 토큰').fill('4096');await form.getByRole('button',{name:'모델 변경 저장',exact:true}).click();await expect.poll(async()=>(await library(request)).models.find(item=>item.id===original.id)?.revision).toBe(2);
  const changed=(await library(request)).models.find(item=>item.id===original.id)!;expect(changed.connectionRevision).toBe(1);expect((await api<ChatDetail>(request,`/chats/${chat.id}`)).profile?.routes.main).toEqual({id:original.id,revision:1});
  await page.getByRole('button',{name:changed.title+' 모델 복제',exact:true}).click();await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(changed.title+' 복사');expect((await library(request)).models.filter(item=>item.title.startsWith(title))).toHaveLength(1);await form.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();await expect.poll(async()=>(await library(request)).models.filter(item=>item.title.startsWith(title)).length).toBe(2);const copied=(await library(request)).models.find(item=>item.title===changed.title+' 복사')!;expect(copied.id).not.toBe(original.id);expect(copied).toMatchObject({connectionRevision:1,maxOutputTokens:4096,sol:original.sol});
  await page.getByRole('button',{name:changed.title+' 모델 비활성',exact:true}).click();const confirmation=page.getByRole('region',{name:'비활성 영향 확인'});await expect(confirmation).toContainText('기존 이야기가 고정한 모델 버전은 계속');expect((await library(request)).models.find(item=>item.id===original.id)?.enabled).toBe(true);await confirmation.getByRole('button',{name:'모델 비활성 확인',exact:true}).click();await expect.poll(async()=>(await library(request)).models.find(item=>item.id===original.id)?.enabled).toBe(false);
  await page.getByRole('button',{name:'연결 관리',exact:true}).click();await page.getByRole('button',{name:title+' 연결 최신판 연결 비활성',exact:true}).click();await expect(confirmation).toContainText('기존 이야기의 다음 호출도 차단');await confirmation.getByRole('button',{name:'비활성 취소',exact:true}).click();expect((await library(request)).connections.find(item=>item.id===connection.id)?.enabled).toBe(true);
  await page.keyboard.press('Escape');await page.goto(`/?chat=${chat.id}`);await expect(page.getByLabel('빠른 본문 모델')).toHaveValue(`${original.id}@1`);await page.getByRole('button',{name:'채팅 설정',exact:true}).click();await page.getByRole('tab',{name:'모델',exact:true}).click();await expect(page.getByLabel('원문 모델',{exact:true})).toHaveValue(`${original.id}@1`);await page.screenshot({path:info.outputPath('provider-management-pinned-model.png')});
  const after=await api<ChatDetail>(request,`/chats/${chat.id}`);expect(after.profile?.routes.main).toEqual({id:original.id,revision:1});expect(after.runs).toEqual([]);expect(after.attempts).toEqual([]);expect(observed.errors).toEqual([]);expect(observed.generations).toEqual([]);
});

test('PMUI04 a delayed readiness response cannot replace the currently selected connection status',async({page,request},info)=>{
  const title='PMUI04 '+Date.now(),first=await api<Connection>(request,'/connections',connectionInput(title+' 먼저')),second=await api<Connection>(request,'/connections',connectionInput(title+' 나중'));let release!:()=>Promise<void>,seen!:()=>void;const firstRequested=new Promise<void>(resolve=>{seen=resolve;});
  await page.route(`**/api/provider-management/connections/${first.id}/readiness`,async route=>{seen();await new Promise<void>(resolve=>{release=async()=>{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:false,originApproved:false,credentialStatus:'missing',catalogKind:'remote'})});resolve();};});});
  await page.route(`**/api/provider-management/connections/${second.id}/readiness`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:true,originApproved:true,credentialStatus:'configured',catalogKind:'remote'})}));
  await settings(page);await page.getByRole('button',{name:'새 모델 입력',exact:true}).click();const form=page.getByRole('form',{name:'모델 편집 양식'});await form.getByLabel('모델 연결').selectOption(`${first.id}@1`);await firstRequested;await form.getByText('연결 준비 상태와 목록 새로고침',{exact:true}).click();await form.getByLabel('모델 연결').selectOption(`${second.id}@1`);const readiness=form.getByRole('region',{name:'선택한 연결 준비 상태'});await expect(readiness).toContainText(second.title);await expect(readiness).toContainText('서버 설정 준비됨');await release();await expect(readiness).toContainText(second.title);await expect(readiness).not.toContainText('인증 참조 설정 필요');await readiness.screenshot({path:info.outputPath('provider-management-current-readiness.png')});
});


test('PMUI07 quick setup selects a cached catalog model and keeps drafts across workspace pages',async({page,request},info)=>{
  const observed=observe(page);
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:width===390?844:1000});await settings(page);
    const title=`PMUI07 ${width} ${Date.now()}`,form=page.getByRole('form',{name:'연결 편집 양식'}),modelForm=page.getByRole('form',{name:'모델 편집 양식'});
    await page.getByRole('button',{name:'빠른 연결 시작',exact:true}).click();await expect(page.getByRole('list',{name:'빠른 연결 진행'})).toContainText('1 제공자');
    await page.getByText('개발·검사용 연결',{exact:true}).click();await page.getByRole('button',{name:'로컬 fixture로 설정',exact:true}).click();
    await form.getByLabel('연결 이름',{exact:true}).fill(title);await form.getByLabel('로컬 endpoint').fill('http://127.0.0.1:9/turn');
    await page.getByRole('button',{name:'모델 프리셋',exact:true}).click();await expect(form).not.toBeVisible();await page.getByRole('button',{name:'연결 관리',exact:true}).click();
    await page.getByRole('button',{name:'연결 편집 이어서 · '+title,exact:true}).click();await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(title);
    await form.getByRole('button',{name:'연결 등록',exact:true}).click();await expect(modelForm).toBeVisible();
    const connection=(await library(request)).connections.find(item=>item.title===title)!;expect(connection).toBeTruthy();
    const catalog=[{id:'synthetic/catalog-alpha',name:title+' Alpha',capabilities:{},priceRevision:null},{id:'synthetic/catalog-beta',name:title+' Beta',capabilities:{},priceRevision:null}];let catalogRequests=0;
    // Return synthetic catalog data at the app route; never contact any provider.
    await page.route(`**/api/connections/${connection.id}/catalog`,route=>{catalogRequests++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...connection,catalog,catalogError:null,catalogUpdatedAt:'2026-09-07T00:00:00.000Z'})});});
    await modelForm.getByText('연결 준비 상태와 목록 새로고침',{exact:true}).click();await modelForm.getByRole('button',{name:'모델 목록 새로고침',exact:true}).click();await modelForm.getByLabel('모델 목록 검색').fill('catalog-beta');
    const picker=modelForm.getByRole('region',{name:'저장된 모델 목록에서 선택'});await expect(picker.getByRole('button')).toHaveCount(1);await picker.getByRole('button',{name: new RegExp(title+' Beta')}).click();
    await expect(modelForm.getByLabel('모델 프리셋 이름')).toHaveValue(title+' Beta');await expect(modelForm.getByLabel('모델 ID',{exact:true})).toHaveValue('synthetic/catalog-beta');
    await modelForm.getByRole('button',{name:'생성 설정',exact:true}).click();await modelForm.getByLabel('최대 출력 토큰').fill('1024');
    await page.getByRole('button',{name:'연결 관리',exact:true}).click();await expect(modelForm).not.toBeVisible();await page.getByRole('button',{name:'모델 프리셋',exact:true}).click();
    await page.getByRole('button',{name:'모델 편집 이어서 · '+title+' Beta',exact:true}).click();await expect(modelForm.getByLabel('최대 출력 토큰')).toHaveValue('1024');
    await modelForm.getByRole('button',{name:'기본 정보',exact:true}).click();await expect(modelForm.getByLabel('모델 ID',{exact:true})).toHaveValue('synthetic/catalog-beta');
    const dialog=page.getByRole('dialog',{name:'설정',exact:true});expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`provider-management-catalog-${width}.png`)});
    await modelForm.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();await expect(page.getByRole('region',{name:'저장한 모델 프리셋'})).toBeVisible();await expect(modelForm).not.toBeVisible();
    await expect.poll(async()=>(await library(request)).models.find(item=>item.title===title+' Beta')).toMatchObject({modelId:'synthetic/catalog-beta',connectionId:connection.id,maxOutputTokens:1024});expect(catalogRequests).toBe(1);
  }
  expect(observed.errors).toEqual([]);expect(observed.generations).toEqual([]);
});


test('PMUI08 Vertex JSON upload validates locally and saves only the returned credential reference',async({page,request},info)=>{
  await page.setViewportSize({width:390,height:844});await settings(page);const title='PMUI08 '+Date.now(),observed=observe(page);
  await page.getByRole('button',{name:'빠른 연결 시작',exact:true}).click();await page.getByRole('region',{name:'제공자 선택',exact:true}).getByRole('button',{name:/Vertex AI/}).click();
  const form=page.getByRole('form',{name:'연결 편집 양식'}),upload=form.getByRole('region',{name:'Vertex 서비스 계정 JSON'}),file=upload.getByLabel('Vertex 키 JSON 파일');
  const originalEndpoint='https://aiplatform.googleapis.com/v1/projects/synthetic-original/locations/global/publishers/google/models';
  await form.getByLabel('연결 이름',{exact:true}).fill(title);await form.getByLabel('Vertex endpoint').fill(originalEndpoint);await form.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_SYNTHETIC_ORIGINAL');
  const projectId='synthetic-project',clientEmail='test@synthetic-project.iam.gserviceaccount.com';let uploads=0;let uploadBody:unknown;
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/provider-management/vertex-credentials')){uploads++;uploadBody=r.postDataJSON();}});
  for(const [body,message] of [['{broken','파일 형식을 확인해 주세요'],[JSON.stringify({project_id:projectId}),'type이 service_account'],[' '.repeat(64*1024+1),'64 KB 이하']]) {
    await file.setInputFiles({name:'synthetic-invalid.json',mimeType:'application/json',buffer:Buffer.from(body)});await expect(upload.getByRole('alert')).toContainText(message);
    await expect(form.getByLabel('연결 이름',{exact:true})).toHaveValue(title);await expect(form.getByLabel('Vertex endpoint')).toHaveValue(originalEndpoint);await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue('NARRATIVE_PROVIDER_SYNTHETIC_ORIGINAL');expect(uploads).toBe(0);
  }
  // Fresh synthetic RSA material exercises real isolated file storage; no OAuth or Vertex call is needed.
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const serviceAccount={type:'service_account',project_id:projectId,client_email:clientEmail,private_key:privateKey,private_key_id:'a'.repeat(40),token_uri:'https://oauth2.googleapis.com/token'};
  const uploaded=page.waitForResponse(r=>r.url().endsWith('/api/provider-management/vertex-credentials')&&r.request().method()==='POST');
  await file.setInputFiles({name:'synthetic-service-account.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(serviceAccount))});await expect(upload.getByRole('status')).toContainText(projectId);
  const uploadResponse=await uploaded;expect(uploadResponse.ok()).toBeTruthy();const {credentialEnv}=await uploadResponse.json() as {credentialEnv:string};expect(credentialEnv).toMatch(/^NARRATIVE_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/);
  expect(uploads).toBe(1);expect(uploadBody).toEqual({serviceAccount});await expect(form.getByLabel('서버 환경변수 이름')).toHaveValue(credentialEnv);
  const endpoint=`https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models`;await expect(form.getByLabel('Vertex endpoint')).toHaveValue(endpoint);
  expect(await page.getByRole('dialog',{name:'설정',exact:true}).evaluate(node=>node.outerHTML)).not.toContain(serviceAccount.private_key);await expect(file).toHaveValue('');
  await upload.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('provider-management-vertex-upload-mobile.png')});
  const posted=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/api/connections'));await form.getByRole('button',{name:'연결 등록',exact:true}).click();
  expect((await posted).postDataJSON()).toMatchObject({credentialEnv,endpoint,title,protocol:'vertex-gemini-v1'});
  await expect.poll(async()=>(await library(request)).connections.find(item=>item.title===title)).toMatchObject({credentialEnv,endpoint});
  expect(JSON.stringify(await library(request))).not.toContain('BEGIN PRIVATE KEY');expect(observed.errors).toEqual([]);expect(observed.generations).toEqual([]);
});

test('PMUI09 invalid hidden model fields receive focus and old deactivation confirmation cannot follow another draft',async({page,request})=>{
  const title='PMUI09 '+Date.now(),connection=await api<Connection>(request,'/connections',{title,protocol:'anthropic-messages-v1',endpoint:'https://api.anthropic.com/v1',credentialEnv:'NARRATIVE_PROVIDER_ANTHROPIC',enabled:true});
  await settings(page);await page.getByRole('button',{name:'새 모델 입력',exact:true}).click();let form=page.getByRole('form',{name:'모델 편집 양식'});
  await form.getByLabel('모델 연결').selectOption(`${connection.id}@1`);await form.getByLabel('모델 프리셋 이름').fill('');await form.getByLabel('모델 ID',{exact:true}).fill('');
  await form.getByRole('button',{name:'생성 설정',exact:true}).click();await form.getByLabel('최대 출력 토큰').fill('0');
  let modelWrites=0;page.on('request',r=>{if(['POST','PUT'].includes(r.method())&&new URL(r.url()).pathname.startsWith('/api/model-presets'))modelWrites++;});
  await form.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();await expect(form.getByRole('button',{name:'기본 정보',exact:true})).toHaveAttribute('aria-pressed','true');await expect(form.getByLabel('모델 프리셋 이름')).toBeFocused();
  await form.getByLabel('모델 프리셋 이름').fill(title+' 초안');await form.getByLabel('모델 ID',{exact:true}).fill('synthetic-model');await form.getByRole('button',{name:'생성 설정',exact:true}).click();await form.getByLabel('최대 출력 토큰').fill('4096');
  await form.getByRole('button',{name:'고급 옵션',exact:true}).click();const details=form.locator('details').filter({has:page.locator('summary',{hasText:'선택 옵션 · 모델이 지원할 때 사용'})});await details.locator('summary').click();
  await form.getByLabel('Thinking',{exact:true}).selectOption('enabled');await form.getByLabel('Thinking 토큰 예산').fill('512');await details.locator('summary').click();await form.getByRole('button',{name:'기본 정보',exact:true}).click();
  await form.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();await expect(form.getByRole('button',{name:'고급 옵션',exact:true})).toHaveAttribute('aria-pressed','true');await expect(details).toHaveAttribute('open','');await expect(form.getByLabel('Thinking 토큰 예산')).toBeFocused();expect(modelWrites).toBe(0);
  const a=await api<ModelPreset>(request,'/model-presets',{title:title+' A',connectionId:connection.id,connectionRevision:1,modelId:'synthetic-a',maxOutputTokens:4096,temperature:null,enabled:true});
  const b=await api<ModelPreset>(request,'/model-presets',{title:title+' B',connectionId:connection.id,connectionRevision:1,modelId:'synthetic-b',maxOutputTokens:4096,temperature:null,enabled:true});
  await settings(page);await page.getByRole('button',{name:a.title+' 모델 수정',exact:true}).click();form=page.getByRole('form',{name:'모델 편집 양식'});await form.getByRole('button',{name:'생성 설정',exact:true}).click();await form.getByLabel('새 모델 선택에 표시').uncheck();await form.getByRole('button',{name:'모델 변경 저장',exact:true}).click();
  const confirmation=page.getByRole('region',{name:'비활성 영향 확인'});await expect(confirmation).toContainText(a.title);await expect(form.getByLabel('최대 출력 토큰')).toBeDisabled();
  await page.getByRole('button',{name:'모델 프리셋',exact:true}).click();await expect(confirmation).toHaveCount(0);await page.getByRole('button',{name:b.title+' 모델 수정',exact:true}).click();
  const discard=page.getByRole('alertdialog',{name:'편집 중인 초안 확인'});await expect(discard).toBeVisible();await discard.getByRole('button',{name:'초안 버리고 계속',exact:true}).click();
  await expect(form.getByLabel('모델 프리셋 이름')).toHaveValue(b.title);await form.getByLabel('모델 프리셋 이름').fill(b.title+' 내 초안');await expect(confirmation).toHaveCount(0);expect((await library(request)).models.find(item=>item.id===a.id)).toEqual(a);expect((await library(request)).models.find(item=>item.id===b.id)).toEqual(b);expect(modelWrites).toBe(0);
});
