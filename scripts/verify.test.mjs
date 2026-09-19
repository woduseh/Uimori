import assert from 'node:assert/strict';
import test from 'node:test';
import { verificationSelection } from './verify.mjs';

test('legacy milestone names select explicitly local case groups', () => {
  for (const milestone of ['M1', 'M2']) {
    const selection = verificationSelection(['--milestone', milestone]);
    assert.equal(selection.milestone, `${milestone}-local`);
    assert.deepEqual(selection, verificationSelection(['--milestone', `${milestone}-local`]));
  }
});

test('case selection stays within its group and removes duplicate requests', () => {
  assert.deepEqual(verificationSelection(['--milestone', 'M1', '--case', 'P07,P07,P08']), {
    milestone: 'M1-local',
    cases: ['P07', 'P08'],
  });
  assert.throws(
    () => verificationSelection(['--milestone', 'M1', '--case', 'S01']),
    /Unknown case/
  );
});

test('missing and unknown selections fail before any work starts', () => {
  for (const args of [['--case'], ['--milestone'], ['--milestone', 'M9'], ['--unknown']])
    assert.throws(() => verificationSelection(args), /Unknown/);
});
