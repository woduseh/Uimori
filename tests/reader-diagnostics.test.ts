import { expect, test } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { readerRoutes } from '../server/reader-routes.js';

test('diagnostic lists omit payloads and single-attempt detail preserves stored payload and unknown cost', async () => {
  const directory = await mkdtemp(join(tmpdir(),'uimori-diagnostics-test-'));
  const store = new Store(join(directory,'test.sqlite'));
  const app = Fastify(); readerRoutes(app,store);
  try {
    const chat = store.createChat('Synthetic attempts');
    const other = store.createChat('Other synthetic chat');
    const payload = { synthetic: 'untrusted local request '.repeat(20000) };
    const id = store.product.mockAttempt(chat.id,null,null,'main',payload);
    store.product.mockAttempt(other.id,null,null,'main',{ other:true });
    const summary = await app.inject(`/api/chats/${chat.id}/attempts`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toHaveLength(1);
    expect(summary.json()[0]).not.toHaveProperty('request');
    expect(summary.json()[0]).not.toHaveProperty('response');
    expect(summary.json()[0]).not.toHaveProperty('rawUsage');
    expect(summary.json()[0].costUsd).toBe(null);
    const detail = await app.inject(`/api/attempts/${id}`);
    expect(detail.json().request).toEqual({mock:true,input:payload});
    expect(detail.body.length).toBeGreaterThan(summary.body.length*100);
    expect((await app.inject(`/api/chats/${chat.id}/jobs`)).json()).toEqual([]);
  } finally {
    await app.close(); store.close();
    const target=resolve(directory), within=relative(resolve(tmpdir()),target);
    if(isAbsolute(within)||within.startsWith('..')||!basename(target).startsWith('uimori-diagnostics-test-')) throw new Error('Unsafe cleanup');
    await rm(target,{recursive:true,force:true});
  }
});
