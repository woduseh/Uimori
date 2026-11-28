import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareRead, portable } from './snapshot-compat/compare.mjs';
import { rulesForCommit } from './snapshot-compat/reviewed-changes.mjs';
import { commit } from './snapshot-compat/rules/v0.18.1.mjs';

test('reviewed scene label removal still reports adjacent manuscript loss and every restore difference', async () => {
  const route = '/api/chats/:/manuscript',
    url = '/api/chats/chat/manuscript';
  const before = {
    status: 200,
    headers: {},
    body: { scenes: [{ label: 'scene', text: 'authored' }] },
  };
  const after = { status: 200, headers: {}, body: { scenes: [{}] } };
  const report = { rules: rulesForCommit(commit), comparisons: 0, differences: [] };
  for (const phase of ['old-new', 'old-restore', 'new-restore']) {
    await compareRead(phase, url, before, after, report, report.differences, route);
    assert.deepEqual(
      report.differences.splice(0).map((x) => x.path),
      phase === 'old-new'
        ? ['$["body"]["scenes"][0]["text"]']
        : ['$["body"]["scenes"][0]["label"]', '$["body"]["scenes"][0]["text"]']
    );
  }
  before.body.scenes = { 0: { label: 'author object key' } };
  after.body.scenes = { 0: {} };
  await compareRead('old-new', url, before, after, report, report.differences, route);
  assert.equal(report.differences.length, 1);
  assert.equal(report.rules.find((r) => r.id === 'manuscript-label').absorbed, 1);
});

test('illustration links follow their imported resource while a switched image remains a finding', () => {
  function archive(id, image) {
    const role = 'bot',
      localProfile = 'lead';
    const profileId =
      'default:' + createHash('sha256').update([id, role, localProfile].join(':')).digest('hex');
    const reference = {
      id: profileId,
      name: 'Lead',
      appearance: 'Dark hair',
      referenceRef: 'package:' + id + ':bot:' + image,
    };
    return {
      manifest: {
        resources: {
          contents: [
            {
              key: 'content-1',
              source: {
                id,
                package: {
                  nativeRisu: {
                    card: {
                      extensions: { uimori: { illustrationProfiles: [{ id: localProfile }] } },
                    },
                  },
                },
              },
            },
          ],
          prompts: [],
        },
        backup: {
          chats: [
            {
              transcript: { packageAttachments: [{ id, role }] },
              state: {
                illustrationReferences: {
                  references: [],
                  images: [],
                  characterProfiles: [reference],
                },
              },
            },
          ],
        },
      },
    };
  }
  assert.deepEqual(portable(archive('old', 'portrait')), portable(archive('new', 'portrait')));
  assert.notDeepEqual(portable(archive('old', 'portrait')), portable(archive('new', 'landscape')));
});

test('chat import normalizes fresh revisions but reports any replaced start title', () => {
  const archive = (title) => ({
    manifest: {
      resources: {
        prompts: [],
        contents: [
          {
            key: 'bot',
            modules: [],
            source: {
              id: 'bot',
              revision: 2,
              package: {
                id: 'bot',
                revision: 2,
                nativeRisu: { card: { first_mes: 'hello' } },
                starts: [{ id: 'start-0', title, text: 'hello', mode: 'authored' }],
              },
            },
          },
        ],
      },
      backup: { chats: [] },
    },
  });
  const imported = archive('기본 첫 메시지');
  Object.assign(imported.manifest.resources.contents[0].source, { revision: 1 });
  Object.assign(imported.manifest.resources.contents[0].source.package, {
    modules: [],
    revision: 1,
  });
  assert.deepEqual(portable(archive('기본 첫 메시지'), true), portable(imported));
  assert.notDeepEqual(portable(archive('기본 시작문'), true), imported);
  assert.notDeepEqual(portable(archive('My opening'), true), imported);
});
