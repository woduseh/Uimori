import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { artifactRoot, newId, browserPath, json, removeOwned } from './lib.mjs';

export async function doctor(directory = path.join(artifactRoot, `doctor-${newId()}`)) {
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, 'doctor-temp'); await mkdir(temp, { recursive: true });
  const result = { status: 'FAIL', startedAt: new Date().toISOString(), platform: process.platform, os: os.release(), node: process.version, shell: process.env.PSModulePath ? 'PowerShell host environment' : 'direct Node child processes', checks: [] };
  let db; let server; let browser; let context;
  try {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('This checkout requires Node 24.x (node:sqlite).');
    await writeFile(path.join(temp, 'write-probe.txt'), 'synthetic write probe');
    result.checks.push({ name: 'writable-directory', status: 'PASS', path: temp });
    db = new DatabaseSync(path.join(temp, 'doctor.sqlite'));
    db.exec('CREATE TABLE probe(value INTEGER); BEGIN; INSERT INTO probe VALUES(7); ROLLBACK;');
    if (db.prepare('SELECT COUNT(*) AS count FROM probe').get().count !== 0) throw new Error('SQLite rollback failed');
    db.exec('BEGIN; INSERT INTO probe VALUES(9); COMMIT;'); db.close();
    db = new DatabaseSync(path.join(temp, 'doctor.sqlite'));
    if (db.prepare('SELECT value FROM probe').get().value !== 9) throw new Error('SQLite file reopen failed');
    result.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version; db.close(); db = undefined;
    result.checks.push({ name: 'file-sqlite-transaction-reopen', status: 'PASS' });
    server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><body><h1>로컬 실행 확인</h1></body></html>'); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    if (!(await fetch(url)).ok) throw new Error('localhost HTTP probe failed');
    result.checks.push({ name: 'localhost-bind-http', status: 'PASS', url });
    const executablePath = browserPath();
    if (executablePath && !existsSync(executablePath)) throw new Error('Browser executable missing');
    context = await chromium.launchPersistentContext(path.join(temp, 'browser-profile'), { executablePath, headless: true, viewport: { width: 390, height: 844 } });
    browser = context.browser();
    const page = await context.newPage(); await page.goto(url, { timeout: 10000 });
    if ((await page.locator('h1').innerText()) !== '로컬 실행 확인') throw new Error('Browser localhost page mismatch');
    result.browser = { name: 'chromium', version: browser.version(), executablePath: executablePath || 'Playwright managed browser', viewport: '390x844 emulator' };
    await page.screenshot({ path: path.join(directory, 'doctor-browser.png') });
    await context.close(); context = undefined; browser = undefined;
    result.checks.push({ name: 'browser-launch-and-local-page', status: 'PASS' });
    result.status = 'PASS';
  } catch (error) { result.status = 'BLOCKED'; result.error = error.message; }
  finally {
    try { db?.close(); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await removeOwned(directory, temp); result.cleanup = { status: 'PASS', removed: [temp], ownedLocalServerClosed: true, browserClosed: true }; }
    catch (error) { result.cleanup = { status: 'FAIL', error: error.message }; result.status = 'FAIL'; }
    result.finishedAt = new Date().toISOString(); await json(path.join(directory, 'doctor.json'), result);
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await doctor(); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'PASS') process.exitCode = 1;
}
