import { liveJourneyRetirement } from './retired-live-journey.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { root, newId, json, assertBuild, startServer, killOwned, browserPath } from './lib.mjs';
import { runLiveJourney } from './live-journey-browser.mjs';
import { parseLiveJourneyOptions, summarizeJourneyAttempts, selectResumePlan, readResumeDetail } from './live-journey-evidence.mjs';

// Historical candidate-UI runner is retained for interpreting its existing evidence.
// Stop before argument validation, source reads, output creation, build checks or authentication.
console.log(JSON.stringify(liveJourneyRetirement(process.argv.includes('--execute') ? 'execute' : 'preflight')));
process.exit(2);

const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{code});};
const safeCode=error=>/^[A-Z0-9_]+$/u.test(error?.code??'')?error.code:'LIVE_JOURNEY_FAILED';
const hash=value=>createHash('sha256').update(value).digest('hex');
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
const identity=async file=>{try{const bytes=await readFile(file);return{bytes:bytes.length,sha256:hash(bytes)};}catch(error){if(error.code==='ENOENT')return null;throw error;}};
let options;
try { options=parseLiveJourneyOptions(process.argv.slice(2)); }
catch(error) { console.error(safeCode(error)); process.exit(2); }
const sourceDirectory=path.resolve(root,options.source);const relative=path.relative(path.join(root,'output','live'),sourceDirectory);
check(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'LIVE_JOURNEY_SOURCE_OUTSIDE_EVIDENCE');
const runId=`live-journey-${newId()}`;const directory=path.join(root,'output','live',runId);const runtime=path.join(directory,'runtime');
const sourceDb=path.join(sourceDirectory,'runtime','evidence.sqlite');const dbPath=path.join(runtime,'evidence.sqlite');
await mkdir(directory,{recursive:true});
const summary={schema:1,runId,mode:options.execute?'execute':'preflight',status:'BLOCKED',startedAt:new Date().toISOString(),sourceEvidence:sourceDirectory,preflight:{networkRequests:0,authenticationAttempted:false},resumeChat:options.resumeChat,retranslateFirst:options.retranslateFirst,failures:[],cleanup:{status:'NOT_RUN'}};
const children=new Set();let sourceMutex;let sourceMutexHeld=false;let browser;let server;let baseline;let budgetModule;let limits;let build;let resumePlan;
const owner={runId,active:false,directory,dbPath,ownerPid:process.pid,children:[]};
const saveOwner=()=>json(path.join(directory,'ownership.json'),{...owner,children:[...children].map(child=>({pid:child.pid,exited:child.exitCode!==null||child.signalCode!==null}))});
const capture=file=>{const db=new DatabaseSync(file,{readOnly:true});try{
  const attempts=db.prepare('SELECT * FROM attempts ORDER BY rowid').all();const sources=db.prepare('SELECT * FROM sources ORDER BY rowid').all();
  return{attempts,sources,accounting:new budgetModule.ProviderBudget(db,limits).snapshot(),activeRuns:db.prepare("SELECT COUNT(*) AS count FROM runs WHERE status IN ('queued','running')").get().count,activeJobs:db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running')").get().count};
}finally{db.close();}};
try{
  build=await assertBuild();budgetModule=await import(pathToFileURL(path.join(root,'dist/server/provider-budget.js')).href);limits=budgetModule.parseLiveBudgetLimits(process.env);
  check(limits?.maxRequests===1000&&limits?.maxCostUsd===100,'LIVE_JOURNEY_APPROVED_LIMITS_REQUIRED');
  check(process.env.NR_VERTEX_REQUEST_TIER==='flex','LIVE_JOURNEY_FLEX_REQUIRED');
  check(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)$/u.test(process.env.NR_VERTEX_PROJECT??''),'NR_VERTEX_PROJECT_REQUIRED');
  check(process.env.GOOGLE_APPLICATION_CREDENTIALS&&(await stat(process.env.GOOGLE_APPLICATION_CREDENTIALS)).isFile(),'GOOGLE_APPLICATION_CREDENTIALS_FILE_REQUIRED');
  const previous=await readJson(path.join(sourceDirectory,'summary.json'));const sourceOwner=await readJson(path.join(sourceDirectory,'ownership.json'));
  check(previous.mode==='execute'&&previous.finishedAt&&sourceOwner.active===false&&sourceOwner.children.every(child=>child.exited),'LIVE_JOURNEY_CLOSED_SOURCE_REQUIRED');
  check(previous.approvedLimits?.maxRequests===limits.maxRequests&&previous.approvedLimits?.maxCostUsd===limits.maxCostUsd,'LIVE_JOURNEY_PRIOR_LIMITS_MISMATCH');
  baseline=capture(sourceDb);check(!baseline.activeRuns&&!baseline.activeJobs&&baseline.attempts.every(row=>row.status!=='running'),'LIVE_JOURNEY_SOURCE_ACTIVE');
  check(baseline.accounting.requestCount===(previous.afterAccounting??previous.accounting)?.requestCount,'LIVE_JOURNEY_PRIOR_LEDGER_MISMATCH');
  check(baseline.accounting.nextRequestAdmissible,baseline.accounting.blockedReason??'LIVE_JOURNEY_BUDGET_BLOCKED');
  if(options.resumeChat){
    check(previous.journey?.chat?.id===options.resumeChat,'LIVE_RESUME_REFERENCE_CHAT_MISMATCH');
    const required=['create_bot_in_library','create_persona_in_library','save_creative_preset','start_story_with_saved_choices'];
    check(required.every(name=>previous.journey.steps?.some(step=>step.name===name&&step.status==='PASS')),'LIVE_RESUME_INITIAL_STEPS_NOT_VERIFIED');
    const readOnly=new DatabaseSync(sourceDb,{readOnly:true});try{resumePlan=selectResumePlan(readResumeDetail(readOnly,options.resumeChat),options.resumeChat);}finally{readOnly.close();}
    summary.referenceEvidence={sourceEvidence:sourceDirectory,summaryPath:path.join(sourceDirectory,'summary.json'),summarySha256:hash(await readFile(path.join(sourceDirectory,'summary.json'))),originalStatus:previous.status,originalJourneyStatus:previous.journey.status,chatId:options.resumeChat,completedInitialSteps:required};
    summary.resumeTarget={runId:resumePlan.run.id,sourceId:resumePlan.source.id,sourceHash:resumePlan.source.hash,translationJobId:resumePlan.translation.id,completedChunkIds:resumePlan.completed.map(chunk=>chunk.id),failedChunkIds:resumePlan.failed.map(chunk=>chunk.id)};
  }
  summary.sourceDbBefore=await identity(sourceDb);summary.sourceWalBefore=await identity(sourceDb+'-wal');
  summary.identity=build;summary.approvedLimits=limits;summary.requestTier='flex';summary.beforeAccounting=baseline.accounting;summary.preflight.ready=true;
}catch(error){summary.preflight.ready=false;summary.failures.push(safeCode(error));}
if(!options.execute||!summary.preflight.ready){summary.status=summary.preflight.ready?'READY':'BLOCKED';summary.finishedAt=new Date().toISOString();summary.cleanup={status:'PASS',serverStarted:false};await json(path.join(directory,'summary.json'),summary);console.log(JSON.stringify({status:summary.status,evidence:path.join(directory,'summary.json'),failures:summary.failures}));process.exitCode=summary.status==='READY'?0:2;}
else{
  let stopping=false;const stop=()=>{stopping=true;for(const child of children)void killOwned(child).catch(()=>{});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    sourceMutex=new DatabaseSync(sourceDb+'.owner.sqlite');sourceMutex.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');sourceMutexHeld=true;
    check(JSON.stringify(await identity(sourceDb))===JSON.stringify(summary.sourceDbBefore)&&JSON.stringify(await identity(sourceDb+'-wal'))===JSON.stringify(summary.sourceWalBefore),'LIVE_JOURNEY_SOURCE_CHANGED');
    await mkdir(runtime,{recursive:true});await copyFile(sourceDb,dbPath,constants.COPYFILE_EXCL);if(summary.sourceWalBefore)await copyFile(sourceDb+'-wal',dbPath+'-wal',constants.COPYFILE_EXCL);
    check(JSON.stringify(await identity(dbPath))===JSON.stringify(summary.sourceDbBefore)&&JSON.stringify(await identity(dbPath+'-wal'))===JSON.stringify(summary.sourceWalBefore),'LIVE_JOURNEY_COPY_IDENTITY_MISMATCH');
    const copied=capture(dbPath);check(JSON.stringify(copied.attempts)===JSON.stringify(baseline.attempts)&&JSON.stringify(copied.sources)===JSON.stringify(baseline.sources),'LIVE_JOURNEY_COPY_CONTENT_MISMATCH');
    const instanceId=randomUUID();owner.active=true;await saveOwner();
    server=await startServer({NR_DB:dbPath,NR_PORT:'0',NR_INSTANCE:instanceId,NR_BUILD_ID:build.buildId,NR_TEST_MODE:'0',NR_ACCESS_TOKEN:'',NR_PROVIDER_ORIGINS:'https://aiplatform.googleapis.com',NR_VERTEX_REQUEST_TIER:'flex',NR_LIVE_MAX_REQUESTS:'1000',NR_LIVE_MAX_USD:'100'},directory,children);await saveOwner();
    const api=async(route,body)=>{const response=await fetch(server.ready.url+'/api'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000),redirect:'error'});check(response.ok,`LIVE_JOURNEY_APP_HTTP_${response.status}`);return response.json();};
    const health=await api('/health');check(health.vertexRequestTier==='flex'&&health.liveBudgetConfigured,'LIVE_JOURNEY_SERVER_TIER_MISMATCH');
    let main;let translation;
    if(options.resumeChat){main=resumePlan.run.snapshot.profile.models.main;translation=resumePlan.run.snapshot.profile.models.translation;}
    else{
      const connection=await api('/connections',{title:'Vertex Flex · 사용자 여정 검증',protocol:'vertex-gemini-v1',endpoint:`https://aiplatform.googleapis.com/v1/projects/${process.env.NR_VERTEX_PROJECT}/locations/global/publishers/google/models`,enabled:true,requestTier:'flex'});
      const createModel=title=>api('/model-presets',{title,connectionId:connection.id,connectionRevision:connection.revision,modelId:'gemini-3.8-flash',maxOutputTokens:8192,temperature:null,thinkingLevel:'MEDIUM',timeoutMs:900000});
      main=await createModel('Flex 본문 · 사용자 여정');translation=await createModel('Flex 번역 · 사용자 여정');
    }
    check(capture(dbPath).accounting.requestCount===baseline.accounting.requestCount,'LIVE_JOURNEY_SETUP_EXECUTED_MODEL');
    browser=await chromium.launch({executablePath:browserPath(),headless:true});const context=await browser.newContext({baseURL:server.ready.url,viewport:{width:390,height:844}});const page=await context.newPage();page.setDefaultTimeout(15000);
    let lastStep='';let lastCount=-1;
    summary.journey=await runLiveJourney({execute:true,page,baseURL:server.ready.url,output:path.join(directory,'browser'),mainModelRef:{id:main.id,revision:main.revision},translationModelRef:{id:translation.id,revision:translation.revision},resumeChat:options.resumeChat,retranslateFirst:options.retranslateFirst,referenceEvidence:summary.referenceEvidence,onCheckpoint:async report=>{
      check(!stopping,'LIVE_JOURNEY_INTERRUPTED');const ledger=capture(dbPath).accounting;check(ledger.requestCount<=limits.maxRequests&&ledger.accountedCostUsd<=limits.maxCostUsd,'LIVE_JOURNEY_BUDGET_BROKEN');
      const step=report.steps.at(-1);if(lastStep!==`${step?.name}:${step?.status}`||lastCount!==ledger.requestCount){lastStep=`${step?.name}:${step?.status}`;lastCount=ledger.requestCount;console.log(JSON.stringify({event:'journey.progress',step:step?.name,status:step?.status,totalRequests:ledger.requestCount}));}
      summary.afterAccounting=ledger;await json(path.join(directory,'summary.json'),summary);
    }});
    summary.status=summary.journey.status;check(summary.status==='PASS','LIVE_JOURNEY_BROWSER_NOT_PASS');await assertBuild();
  }catch(error){summary.failures.push(safeCode(error));if(summary.status!=='INCOMPLETE')summary.status='FAIL';}
  finally{
    const errors=[];try{await browser?.close();}catch{errors.push('BROWSER_CLEANUP_FAILED');}
    for(const child of children)try{await killOwned(child);}catch{errors.push('SERVER_CLEANUP_FAILED');}
    try{
      const after=capture(dbPath);summary.afterAccounting=after.accounting;summary.totalRequestCount=after.accounting.requestCount;Object.assign(summary,summarizeJourneyAttempts(baseline.attempts,after.attempts,baseline.accounting,after.accounting));
      check(JSON.stringify(after.attempts.slice(0,baseline.attempts.length))===JSON.stringify(baseline.attempts),'LIVE_JOURNEY_CHANGED_PRIOR_ATTEMPTS');
      check(JSON.stringify(after.sources.slice(0,baseline.sources.length))===JSON.stringify(baseline.sources),'LIVE_JOURNEY_CHANGED_PRIOR_SOURCES');
      const fresh=after.attempts.slice(baseline.attempts.length);summary.newAttempts=fresh.map(row=>({id:row.id,role:row.role,status:row.status,inputTokens:row.input_tokens,outputTokens:row.output_tokens,costUsd:row.cost_usd,error:row.error,rawUsage:row.raw_usage===null?null:JSON.parse(row.raw_usage),requestHeaders:JSON.parse(row.request).headers}));
      summary.preservation={priorAttempts:true,priorSources:true};
    }catch(error){errors.push(safeCode(error));}
    try{summary.originalEvidenceUnchanged=JSON.stringify(await identity(sourceDb))===JSON.stringify(summary.sourceDbBefore)&&JSON.stringify(await identity(sourceDb+'-wal'))===JSON.stringify(summary.sourceWalBefore);check(summary.originalEvidenceUnchanged,'LIVE_JOURNEY_ORIGINAL_CHANGED');}catch(error){errors.push(safeCode(error));}
    try{if(sourceMutexHeld)sourceMutex.exec('ROLLBACK');sourceMutex?.close();}catch{errors.push('SOURCE_MUTEX_CLEANUP_FAILED');}
    owner.active=[...children].some(child=>child.exitCode===null&&child.signalCode===null);await saveOwner();summary.cleanup={status:errors.length||owner.active?'FAIL':'PASS',serverStillRunning:owner.active,errors};
    if(errors.length||owner.active)summary.status='FAIL';summary.finishedAt=new Date().toISOString();await json(path.join(directory,'summary.json'),summary);
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);console.log(JSON.stringify({status:summary.status,evidence:path.join(directory,'summary.json'),totalRequests:summary.totalRequestCount,failures:summary.failures,cleanup:summary.cleanup}));if(summary.status!=='PASS')process.exitCode=1;
  }
}

