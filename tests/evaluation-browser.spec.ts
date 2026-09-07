import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';
import { navigationAction } from './ui-navigation.js';

async function navigation(page:Page,name:string) {
  await navigationAction(page,name);
}
async function library(request:APIRequestContext):Promise<Library> {
  const response=await request.get('/api/library'); expect(response.ok()).toBeTruthy(); return response.json();
}
async function settings(page:Page) {
  await navigation(page,'설정');
  await page.getByRole('tab', { name: '연결과 모델', exact: true }).click();
  await page.getByRole('button',{name:'빠른 연결 시작',exact:true}).click();
  await page.getByRole('region',{name:'제공자 선택',exact:true}).getByRole('button',{name:/OpenAI · Responses/}).click();
  await expect(page.getByLabel('연결 프로토콜')).toBeVisible();
  await page.getByLabel('연결 프로토콜').selectOption('openai-responses-v1');
}
function observe(page:Page) {
  const errors:string[]=[], forbidden:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\/(?:catalog|runs)(?:\?|$)/.test(request.url())) forbidden.push(request.url());});
  return {errors,forbidden};
}
async function register(page:Page,request:APIRequestContext,title:string,gateway:'llm-gateway'|'vercel') {
  await page.getByLabel('API 기본 주소').fill(gateway==='vercel'?'https://ai-gateway.vercel.sh/v1':'https://api.llmgateway.io/v1');
  await page.getByLabel('연결 이름',{exact:true}).fill(title);
  await page.getByLabel('서버 환경변수 이름').fill('Evaluation_Browser_Key');
  await page.getByLabel('이 연결 사용').check();
  await page.getByRole('button',{name:'연결 등록',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:title+' 연결 등록됨'})).toBeVisible();
  const connection=(await library(request)).connections.find(item=>item.title===title)!;
  expect(connection).toMatchObject({protocol:'openai-responses-v1',credentialEnv:'Evaluation_Browser_Key',enabled:true});
  await page.getByLabel('모델 연결').selectOption(`${connection.id}`);
  await page.getByLabel('모델 프리셋 이름').fill(title+' 모델');
  await page.getByLabel('모델 ID',{exact:true}).fill(gateway==='vercel'?'openai/synthetic-evaluation':'synthetic-evaluation');
  return connection;
}
async function saveModel(page:Page,request:APIRequestContext,connection:Connection):Promise<ModelPreset> {
  await page.getByRole('button',{name:'모델 프리셋 등록',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:connection.title+' 모델 모델 프리셋 등록됨'})).toBeVisible();
  return (await library(request)).models.find(item=>item.connectionId===connection.id)!;
}

test('EVALUI01 desktop preset evaluation opt-in persists selected story roles after reconnect without model calls', async ({page,context,request},info)=>{
  await page.setViewportSize({width:1440,height:1000}); const observed=observe(page); const title='합성 평가 desktop '+Date.now();
  const bot=await request.post('/api/content',{data:{kind:'bot',title:`${title} bot`,description:'Synthetic evaluation navigation',text:'Synthetic keeper',loading:'pinned',relatedIds:[]}});expect(bot.ok()).toBeTruthy();
  await page.goto('/'); await settings(page);
  await expect(page.getByLabel('API 기본 주소')).toHaveValue('https://api.openai.com/v1');
  await expect(page.getByLabel('API 기본 주소')).toBeEditable();
  await expect(page.getByLabel('연결 프로토콜').locator('option[value="sol-responses-v1"]')).toHaveCount(0);
  const connection=await register(page,request,title,'llm-gateway');
  await page.getByRole('button',{name:'고급 옵션',exact:true}).click();await expect(page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용')).not.toBeChecked();await page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용').check();await page.getByLabel('평가 문맥 제공').selectOption('preloaded');await page.getByLabel('첫 case 라운드 추론').selectOption('economized'); await page.getByLabel('최대 평가 도구 라운드').fill('3');
  await page.getByLabel('제출 원고의 정확한 문자열 교정 허용').check();
  await page.getByRole('button',{name:'생성 설정',exact:true}).click(); await page.getByLabel('Reasoning Effort',{exact:true}).selectOption('high'); await page.getByRole('button',{name:'고급 옵션',exact:true}).click();
  await page.getByLabel('평가 문맥 제공').scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('evaluation-desktop-options.png')});
  const model=await saveModel(page,request,connection); expect(model).toMatchObject({reasoningEffort:'high',evaluationTools:{contextMode:'preloaded',approvalReasoningMode:'economized',maximumToolRounds:3,terminalLateCorrections:true,outputRecovery:true}});
  await page.keyboard.press('Escape'); await navigation(page,'새 이야기'); await page.getByLabel('새 채팅 이름').fill(title+' 이야기');
  const ref=`${model.id}`; await page.getByLabel('시작 본문 모델').selectOption(ref); await page.getByLabel('시작 번역 모델').selectOption(ref); await page.getByRole('button',{name:'채팅 만들기',exact:true}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('chat')).toBeTruthy(); const storyUrl=page.url(),chatId=new URL(storyUrl).searchParams.get('chat')!;
  await page.reload(); await expect(page.getByLabel('빠른 본문 모델')).toHaveValue(ref);
  const reconnected=await context.newPage(); await reconnected.setViewportSize({width:1440,height:1000}); await reconnected.goto(storyUrl); await reconnected.getByRole('button',{name:'채팅 설정',exact:true}).click(); await reconnected.getByRole('tab',{name:'모델',exact:true}).click();
  await expect(reconnected.getByLabel('원문 모델',{exact:true})).toHaveValue(ref); await expect(reconnected.getByLabel('번역 모델',{exact:true})).toHaveValue(ref); await reconnected.screenshot({path:info.outputPath('evaluation-desktop-restored-roles.png')});
  const detail=await (await request.get(`/api/chats/${chatId}`)).json() as ChatDetail; expect(detail.profile?.routes.main).toEqual({id:model.id}); expect(detail.runs).toEqual([]); expect(detail.attempts).toEqual([]); expect(detail.jobs).toEqual([]);
  expect((await library(request)).models.find(item=>item.id===model.id)).toEqual(model); expect(observed.errors).toEqual([]); expect(observed.forbidden).toEqual([]); await reconnected.close();
});

test('EVALUI02 mobile 390px evaluation controls save only for opted-in presets and can be disabled', async ({page,request},info)=>{
  await page.setViewportSize({width:390,height:844}); const observed=observe(page); const title='합성 평가 mobile '+Date.now(); await page.goto('/'); await settings(page);
  await expect(page.getByLabel('API 기본 주소')).toBeEditable(); await page.getByLabel('API 기본 주소').fill('http://127.0.0.1:8080/v1');
  await page.getByLabel('서버 환경변수 이름').scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('evaluation-mobile-connection.png')});
  const connection=await register(page,request,title,'vercel');
  await page.getByRole('button',{name:'고급 옵션',exact:true}).click();await expect(page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용')).not.toBeChecked();await page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용').check();
  const labels=['모델 프리셋 이름','모델 ID','최대 출력 토큰','응답 제한 시간 (초)','평가 문맥 제공','최대 평가 도구 라운드'];
  for(const label of labels) {
    await page.getByRole('button',{name:['모델 프리셋 이름','모델 ID'].includes(label)?'기본 정보':['최대 출력 토큰','응답 제한 시간 (초)'].includes(label)?'생성 설정':'고급 옵션',exact:true}).click();
    const control=page.getByLabel(label,{exact:true}); await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
    const box=await control.boundingBox(); expect(box,label).not.toBeNull(); expect(box!.x,label).toBeGreaterThanOrEqual(0); expect(box!.x+box!.width,label).toBeLessThanOrEqual(390); expect(box!.width,label).toBeGreaterThan(120);
  }
  const horizontal=await page.getByRole('dialog',{name:'설정',exact:true}).evaluate(element=>({scroll:element.scrollWidth,width:element.clientWidth})); expect(horizontal.scroll).toBeLessThanOrEqual(horizontal.width+1);
  // Viewport containment alone missed a clipped native-select label in the first visual review.
  // Check the displayed choice as well; screenshots still need direct visual inspection.
  for(const label of ['평가 문맥 제공']) {
    const measured=await page.getByLabel(label,{exact:true}).evaluate(element=>{
      const select=element as HTMLSelectElement,style=getComputedStyle(select),canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
      context.font=style.font;return {text:context.measureText(select.selectedOptions[0].text).width,available:select.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-24};
    });
    expect(measured.text,label+' displayed choice fits before the native arrow').toBeLessThanOrEqual(measured.available);
  }
  // Capture the whole section laid out at 390px, including controls below the scroll fold.
  await page.getByRole('group',{name:'선택형 평가 도구',exact:true}).screenshot({path:info.outputPath('evaluation-mobile-options.png')});
  await page.getByText('기능 확인과 사용자 판단',{exact:true}).click();await page.getByLabel('도구 호출 지원 판단').selectOption('no');await expect(page.getByRole('button',{name:'모델 프리셋 등록',exact:true})).toBeDisabled();await expect(page.getByRole('alert').filter({hasText:'도구 호출을 미지원'})).toBeVisible();await page.getByLabel('도구 호출 지원 판단').selectOption('unknown');
  const model=await saveModel(page,request,connection); expect(model.evaluationTools).toEqual({contextMode:'model-selected',approvalReasoningMode:'configured',maximumToolRounds:8,terminalLateCorrections:false,outputRecovery:true});
  await page.reload(); await navigation(page,'설정');await page.getByRole('tab',{name:'연결과 모델',exact:true}).click(); await expect(page.getByText(title+' 모델',{exact:true})).toBeVisible(); expect((await library(request)).models.find(item=>item.id===model.id)).toEqual(model); expect(observed.errors).toEqual([]); expect(observed.forbidden).toEqual([]);
  await page.getByRole('button',{name:title+' 모델 모델 수정',exact:true}).click();await page.getByRole('button',{name:'고급 옵션',exact:true}).click();await expect(page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용')).toBeChecked();await page.getByLabel('이 모델 프리셋에 평가 도구 4개 사용').uncheck();await expect(page.getByLabel('평가 문맥 제공')).toHaveCount(0);await page.getByRole('button',{name:'모델 변경 저장',exact:true}).click();
  await expect.poll(async()=>{const latest=(await library(request)).models.find(item=>item.id===model.id)!;return {revision:latest.revision,evaluationTools:latest.evaluationTools??null};}).toEqual({revision:model.revision+1,evaluationTools:null});
});
