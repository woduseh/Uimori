import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, copyFile, readdir, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium, expect } from '@playwright/test';
import {
  artifactRoot,
  newId,
  json,
  command,
  requireCommand,
  startServer,
  killOwned,
  browserPath,
  removeOwned,
  artifactScan,
} from './lib.mjs';

const git = promisify(execFile);
async function parallel(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--a' || args[2] !== '--b') {
  console.error(
    'Usage: node scripts/verify-worktrees.mjs --a <prepared-clean-checkout> --b <prepared-clean-checkout>'
  );
  process.exitCode = 2;
} else {
  const id = `worktrees-${newId()}`;
  const directory = path.join(artifactRoot, id);
  await mkdir(directory, { recursive: true });
  const children = new Set();
  const contexts = [];
  const entries = [];
  const summary = {
    status: 'FAIL',
    case: 'F01',
    startedAt: new Date().toISOString(),
    entries,
    failures: [],
    cleanup: [],
  };
  const deadline = setTimeout(() => {
    summary.failures.push('Worktree isolation deadline exceeded');
    for (const child of children)
      void killOwned(child).catch((error) => summary.failures.push(error.message));
    for (const context of contexts)
      void context.close().catch((error) => summary.failures.push(error.message));
  }, 60000);
  try {
    const paths = await Promise.all([realpath(args[1]), realpath(args[3])]);
    if (paths[0] === paths[1]) throw new Error('Two different checkout paths required');
    for (const [index, cwd] of paths.entries()) {
      const { stdout: status } = await git('git', ['-C', cwd, 'status', '--porcelain'], {
        windowsHide: true,
      });
      if (status.trim()) throw new Error(`Checkout is not clean: ${cwd}\n${status}`);
      const { stdout: head } = await git('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
        windowsHide: true,
      });
      const identity = await command(
        [
          '-e',
          'import("./scripts/lib.mjs").then(async m=>console.log(JSON.stringify(await m.assertBuild())))',
        ],
        { cwd, timeout: 10000 }
      );
      requireCommand(identity);
      const manifest = JSON.parse(identity.output.trim());
      const runDir = path.join(cwd, 'output', 'playwright', `${id}-${index}`);
      const runtime = path.join(runDir, 'runtime');
      const temp = path.join(runtime, 'temp');
      await mkdir(temp, { recursive: true });
      const env = {
        NR_DB: path.join(runtime, 'app.sqlite'),
        NR_PORT: '0',
        NR_BUILD_ID: manifest.buildId,
        NR_INSTANCE: `${id}-${index}`,
        NR_TEST_MODE: '1',
        TEMP: temp,
        TMP: temp,
      };
      entries.push({
        cwd,
        commit: head.trim(),
        cleanBefore: true,
        identity: manifest,
        runDir,
        runtime,
        temp,
        profile: path.join(runtime, 'browser-profile'),
        env,
      });
    }
    if (
      entries[0].identity.sourceHash !== entries[1].identity.sourceHash ||
      entries[0].commit !== entries[1].commit
    )
      throw new Error('Checkouts do not have the same source and commit identity');
    await parallel(
      entries.map(async (entry) => {
        const { ready, child } = await startServer(entry.env, entry.runDir, children, entry.cwd);
        entry.ready = ready;
        entry.pid = child.pid;
        await json(path.join(entry.runDir, 'ownership.json'), {
          runId: path.basename(entry.runDir),
          ownerPid: process.pid,
          directory: entry.runDir,
          active: true,
          children: [{ pid: child.pid, command: 'node dist/server/index.js' }],
        });
      })
    );
    if (
      entries[0].ready.url === entries[1].ready.url ||
      entries[0].env.NR_DB === entries[1].env.NR_DB ||
      entries[0].profile === entries[1].profile ||
      entries[0].temp === entries[1].temp
    )
      throw new Error('Worktree runtime isolation collision');
    await parallel(
      entries.map(async (entry, index) => {
        const context = await chromium.launchPersistentContext(entry.profile, {
          executablePath: browserPath(),
          headless: true,
          viewport: { width: 390, height: 844 },
          env: { ...process.env, TEMP: entry.temp, TMP: entry.temp },
        });
        contexts.push(context);
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(entry.ready.url, { timeout: 10000 });
        const title = `F01 합성 작업트리 ${index}`;
        await page.getByLabel('새 이야기 이름').fill(title);
        await page.getByRole('button', { name: '이야기 만들기' }).click();
        await page.getByLabel('다음 장면 요청').fill(`독립 작업트리 ${index}의 저녁 장면`);
        await page.getByRole('button', { name: '원문 생성', exact: true }).click();
        await expect(page.getByTestId('source')).toHaveCount(1, { timeout: 10000 });
        const response = await page.request.get(`${entry.ready.url}/api/chats`);
        const chats = await response.json();
        if (!response.ok() || chats.length !== 1 || chats[0].title !== title)
          throw new Error('Browser/API storage crossed worktree boundary');
        entry.chatId = chats[0].id;
        entry.sourceId = await page.getByTestId('source').getAttribute('data-source-id');
        entry.browserVersion = context.browser().version();
        await page.screenshot({
          path: path.join(directory, `worktree-${index}.png`),
          fullPage: true,
        });
        await context.close();
      })
    );
    if (entries[0].chatId === entries[1].chatId || entries[0].sourceId === entries[1].sourceId)
      throw new Error('Independent source/chat IDs collided');
    for (const entry of entries) {
      const result = await command(
        [
          '-e',
          'import("./scripts/lib.mjs").then(async m=>console.log(JSON.stringify(await m.assertBuild())))',
        ],
        { cwd: entry.cwd, timeout: 10000 }
      );
      requireCommand(result);
      if (JSON.parse(result.output.trim()).buildId !== entry.identity.buildId)
        throw new Error('Source/build changed during worktree test');
      const { stdout: status } = await git('git', ['-C', entry.cwd, 'status', '--porcelain'], {
        windowsHide: true,
      });
      if (status.trim()) throw new Error('Checkout became dirty during isolation test');
      entry.cleanAfter = true;
    }
  } catch (error) {
    summary.failures.push(error.message);
  } finally {
    clearTimeout(deadline);
    for (const context of contexts)
      try {
        await context.close();
      } catch (error) {
        summary.failures.push(`Browser cleanup: ${error.message}`);
      }
    for (const child of children)
      try {
        summary.cleanup.push(await killOwned(child));
      } catch (error) {
        summary.failures.push(`Process cleanup: ${error.message}`);
      }
    const liveChildren = [...children].filter(
      (child) => child.pid && child.exitCode === null && child.signalCode === null
    );
    if (liveChildren.length)
      summary.failures.push(
        `Owned children still running; all worktree runtimes retained: ${liveChildren.map((child) => child.pid).join(', ')}`
      );
    for (const [index, entry] of entries.entries())
      try {
        if (liveChildren.length) {
          await json(path.join(entry.runDir, 'ownership.json'), {
            runId: path.basename(entry.runDir),
            ownerPid: process.pid,
            directory: entry.runDir,
            active: true,
            cleanup: {
              status: 'FAIL',
              livePids: liveChildren.map((child) => child.pid),
              runtimeRetained: true,
            },
          });
          continue;
        }
        const evidenceDir = path.join(directory, `db-${index}`);
        await mkdir(evidenceDir, { recursive: true });
        for (const file of await readdir(entry.runtime))
          if (/\.sqlite(?:-wal|-shm)?$/.test(file))
            await copyFile(path.join(entry.runtime, file), path.join(evidenceDir, file));
        if (entry.sourceId) {
          const db = new DatabaseSync(path.join(evidenceDir, 'app.sqlite'), { readOnly: true });
          try {
            entry.persistedSourceCount = db
              .prepare('SELECT COUNT(*) AS count FROM sources')
              .get().count;
            if (entry.persistedSourceCount !== 1) {
              // biome-ignore lint/correctness/noUnsafeFinally: The runtime cleanup catch preserves this DB assertion alongside prior failures and retains the runtime.
              throw new Error('Reopened file SQLite did not preserve source');
            }
          } finally {
            db.close();
          }
        }
        await removeOwned(entry.runDir, entry.runtime);
        summary.cleanup.push({ removed: entry.runtime, retainedDB: evidenceDir });
        await json(path.join(entry.runDir, 'ownership.json'), {
          runId: path.basename(entry.runDir),
          ownerPid: process.pid,
          directory: entry.runDir,
          active: false,
          cleanup: { status: 'PASS' },
        });
      } catch (error) {
        summary.failures.push(`Runtime cleanup: ${error.message}`);
      }
    try {
      summary.artifactScan = await artifactScan(directory);
    } catch (error) {
      summary.failures.push(error.message);
    }
    summary.status = summary.failures.length ? 'FAIL' : 'PASS';
    summary.finishedAt = new Date().toISOString();
    await json(path.join(directory, 'summary.json'), summary);
    console.log(
      JSON.stringify(
        {
          status: summary.status,
          evidence: path.join(directory, 'summary.json'),
          failures: summary.failures,
        },
        null,
        2
      )
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
