import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';

async function navigation(page:Page,name:string) {
  const button=name==='새 이야기'?page.getByRole('complementary').getByRole('button',{name,exact:true}):page.getByRole('button',{name,exact:true});
  if(!await button.isVisible()) await page.getByRole('button',{name:'탐색 메뉴',exact:true}).click();
  await button.click();
}
async function library(request:APIRequestContext):Promise<Library> {
  const response=await request.get('/api/library'); expect(response.ok()).toBeTruthy(); return response.json();
}
async function settings(page:Page) {
  await navigation(page,'설정');
  await page.getByTestId('connection-settings').locator('summary').first().click();
  await expect(page.getByLabel('연결 프로토콜')).toBeVisible();
  await page.getByLabel('연결 프로토콜').selectOption('sol-responses-v1');
}
function observe(page:Page) {
  const errors:string[]=[], forbidden:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\/(?:catalog|runs)(?:\?|$)/.test(request.url())) forbidden.push(request.url());});
  return {errors,forbidden};
}
async function register(page:Page,request:APIRequestContext,title:string,gateway:'llm-gateway'|'vercel') {
  await page.getByLabel('Sol 게이트웨이').selectOption(gateway);
  await page.getByLabel('연결 이름',{exact:true}).fill(title);
  await page.getByLabel('서버 환경변수 이름').fill('NARRATIVE_PROVIDER_SOL_BROWSER_SYNTHETIC');
  await page.getByLabel('이 연결 사용').check();
  await page.getByRole('button',{name:'연결 등록',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:title+' 연결 등록됨'})).toBeVisible();
  const connection=(await library(request)).connections.find(item=>item.title===title)!;
  expect(connection).toMatchObject({protocol:'sol-responses-v1',credentialEnv:'NARRATIVE_PROVIDER_SOL_BROWSER_SYNTHETIC',enabled:true});
  await page.getByLabel('모델 연결').selectOption(`${connection.id}@${connection.revision}`);
  await page.getByLabel('모델 프리셋 이름').fill(title+' 모델');
  await page.getByLabel('모델 ID',{exact:true}).fill(gateway==='vercel'?'openai/synthetic-sol':'synthetic-sol');
  return connection;
}
async function saveModel(page:Page,request:APIRequestContext,connection:Connection):Promise<ModelPreset> {
  await page.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:connection.title+' 모델 모델 프리셋 등록됨'})).toBeVisible();
  return (await library(request)).models.find(item=>item.connectionId===connection.id)!;
}

test('SOLUI01 desktop gateway and model registration persists selected story roles after reconnect without model calls', async ({page,context,request},info)=>{
  await page.setViewportSize({width:1440,height:1000}); const observed=observe(page); const title='합성 Sol desktop '+Date.now();
  await page.goto('/'); await settings(page);
  for(const [gateway,endpoint] of [['vercel','https://ai-gateway.vercel.sh/v1'],['llm-gateway','https://api.llmgateway.io/v1'],['openai','https://api.openai.com/v1']]) {
    await page.getByLabel('Sol 게이트웨이').selectOption(gateway); await expect(page.getByLabel('API 기본 주소')).toHaveValue(endpoint); await expect(page.getByLabel('API 기본 주소')).toHaveAttribute('readonly','');
  }
  const connection=await register(page,request,title,'llm-gateway');
  await page.getByLabel('Sol 문맥 제공').selectOption('preloaded'); await page.getByLabel('Sol 추가 도구 라운드').fill('3');
  await page.getByLabel('제출 원고의 정확한 문자열 교정 허용').check();
  await page.getByText('선택 옵션 · 모델이 지원할 때 사용',{exact:true}).click(); await page.getByLabel('Reasoning effort',{exact:true}).selectOption('max');
  await page.getByText('Sol 공급자 선택 옵션',{exact:true}).click(); await page.getByLabel('Service tier',{exact:true}).selectOption('flex'); await page.getByLabel('Verbosity',{exact:true}).selectOption('high'); await page.getByLabel('Reasoning summary',{exact:true}).selectOption('detailed'); await page.getByLabel('Encrypted reasoning 연속 요청에 사용').check();
  await page.getByLabel('Sol 문맥 제공').scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('sol-desktop-options.png')});
  const model=await saveModel(page,request,connection); expect(model).toMatchObject({reasoningEffort:'max',sol:{contextMode:'preloaded',maximumToolRounds:3,terminalLateCorrections:true,serviceTier:'flex',verbosity:'high',reasoningSummary:'detailed',includeEncryptedReasoning:true}});
  await page.keyboard.press('Escape'); await navigation(page,'새 이야기'); await page.getByLabel('새 이야기 이름').fill(title+' 이야기');
  const ref=`${model.id}@${model.revision}`; await page.getByLabel('시작 본문 모델').selectOption(ref); await page.getByLabel('시작 번역 모델').selectOption(ref); await page.getByRole('button',{name:'이야기 만들기',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('chat')).toBeTruthy(); const storyUrl=page.url(),chatId=new URL(storyUrl).searchParams.get('chat')!;
  await page.reload(); await expect(page.getByLabel('빠른 본문 모델')).toHaveValue(ref);
  const reconnected=await context.newPage(); await reconnected.setViewportSize({width:1440,height:1000}); await reconnected.goto(storyUrl); await reconnected.getByRole('button',{name:'이야기 설정',exact:true}).click(); await reconnected.getByRole('tab',{name:'모델',exact:true}).click();
  await expect(reconnected.getByLabel('원문 모델',{exact:true})).toHaveValue(ref); await expect(reconnected.getByLabel('번역 모델',{exact:true})).toHaveValue(ref); await reconnected.screenshot({path:info.outputPath('sol-desktop-restored-roles.png')});
  const detail=await (await request.get(`/api/chats/${chatId}`)).json() as ChatDetail; expect(detail.profile?.routes.main).toEqual({id:model.id,revision:model.revision}); expect(detail.runs).toEqual([]); expect(detail.attempts).toEqual([]); expect(detail.jobs).toEqual([]);
  expect((await library(request)).models.find(item=>item.id===model.id)).toEqual(model); expect(observed.errors).toEqual([]); expect(observed.forbidden).toEqual([]); await reconnected.close();
});

test('SOLUI02 mobile 390px Sol gateway and optional controls remain inside the viewport and save defaults', async ({page,request},info)=>{
  await page.setViewportSize({width:390,height:844}); const observed=observe(page); const title='합성 Sol mobile '+Date.now(); await page.goto('/'); await settings(page);
  await page.getByLabel('Sol 게이트웨이').selectOption('local'); await expect(page.getByLabel('API 기본 주소')).toBeEditable(); await page.getByLabel('API 기본 주소').fill('http://127.0.0.1:8080/v1');
  await page.getByLabel('서버 환경변수 이름').scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('sol-mobile-gateway.png')});
  const connection=await register(page,request,title,'vercel');
  await page.getByText('Sol 공급자 선택 옵션',{exact:true}).click();
  const labels=['모델 프리셋 이름','모델 ID','최대 출력 토큰','응답 제한 시간 (초)','Sol 문맥 제공','Sol 추가 도구 라운드','Service tier','Verbosity','Reasoning summary'];
  for(const label of labels) {
    const control=page.getByLabel(label,{exact:true}); await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
    const box=await control.boundingBox(); expect(box,label).not.toBeNull(); expect(box!.x,label).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width,label).toBeLessThanOrEqual(390); expect(box!.width,label).toBeGreaterThan(120);
  }
  const horizontal=await page.getByRole('dialog',{name:'설정',exact:true}).evaluate(element=>({scroll:element.scrollWidth,width:element.clientWidth})); expect(horizontal.scroll).toBeLessThanOrEqual(horizontal.width+1);
  // Viewport containment alone missed a clipped native-select label in the first visual review.
  // Check the displayed choice as well; screenshots still need direct visual inspection.
  for(const label of ['Sol 문맥 제공','Service tier','Verbosity','Reasoning summary']) {
    const measured=await page.getByLabel(label,{exact:true}).evaluate(element=>{
      const select=element as HTMLSelectElement,style=getComputedStyle(select),canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
      context.font=style.font;return {text:context.measureText(select.selectedOptions[0].text).width,available:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-24};
    });
    expect(measured.text,label+' displayed choice fits before the native arrow').toBeLessThanOrEqual(measured.available);
  }
  // Capture the whole section laid out at 390px, including controls below the scroll fold.
  await page.getByRole('group',{name:'Sol 도구와 출력',exact:true}).screenshot({path:info.outputPath('sol-mobile-options.png')});
  const model=await saveModel(page,request,connection); expect(model.sol).toEqual({contextMode:'model-selected',maximumToolRounds:8,terminalLateCorrections:false,includeEncryptedReasoning:true});
  await page.reload(); await settings(page); await expect(page.getByText(title+' 모델',{exact:true})).toBeVisible(); expect((await library(request)).models.find(item=>item.id===model.id)).toEqual(model); expect(observed.errors).toEqual([]); expect(observed.forbidden).toEqual([]);
});
