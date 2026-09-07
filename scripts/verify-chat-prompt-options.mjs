import path from 'node:path';
import {artifactRoot,newId,json,assertBuild,startServer,killOwned,command,readReport,browserPath} from './lib.mjs';
const directory=path.join(artifactRoot,`chat-prompt-options-${newId()}`), children=new Set();
const summary={status:'FAIL',scope:'Synthetic chat creative option panel, explicit persistence, draft safety, CAS and responsive layout',limitations:['Fresh isolated SQLite with synthetic prompts; no provider calls or personal data.'],cleanup:'NOT_RUN'};
try {
  const identity=await assertBuild();
  const env={NR_DB:path.join(directory,'app.sqlite'),NR_PORT:'0',NR_INSTANCE:path.basename(directory),NR_BUILD_ID:identity.buildId,NR_TEST_MODE:'1',NR_ACCESS_TOKEN:'',NR_PROVIDER_ORIGINS:'',NR_BROWSER_PATH:browserPath(),NR_BROWSER_OUTPUT:path.join(directory,'browser')};
  await json(path.join(directory,'summary.json'),summary);
  const server=await startServer(env,directory,children);summary.server=server.ready;
  const report=path.join(directory,'playwright.json'),since=Date.now();
  const result=await command(['node_modules/@playwright/test/cli.js','test','tests/chat-prompt-options-browser.spec.ts','tests/product-browser.spec.ts','--grep','chat creative options|creative option CAS|P01 package','--reporter=json'],{env:{...env,NR_BASE_URL:server.ready.url,PLAYWRIGHT_JSON_OUTPUT_NAME:report},children,log:path.join(directory,'playwright.log')});
  summary.report=await readReport(report,since,'playwright');
  summary.status=result.code===0&&summary.report.passed>0?'PASS':'FAIL';
} catch(error){summary.error=error.message;}
finally {for(const child of children) await killOwned(child);summary.cleanup='PASS';await json(path.join(directory,'summary.json'),summary);console.log(JSON.stringify({directory,...summary},null,2));if(summary.status!=='PASS')process.exitCode=1;}
