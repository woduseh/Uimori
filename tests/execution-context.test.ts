import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { executionContext } from '../core/execution-context.js';
import { defaultProfile } from '../core/product.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { compiledPackages } from '../core/package-context.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { evaluatePromptExpression } from '../core/prompt-program.js';
import type { ContentPackage } from '../core/content-package.js';
import type { RunSnapshot } from '../core/types.js';

function snapshot(): RunSnapshot {
  return {
    chatId: 'chat',
    branchId: 'branch',
    parentRevision: null,
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'Continue',
    history: [],
    resources: [],
    profile: { ...defaultProfile('chat'), contents: [], models: {} },
  };
}
function pkg(id = 'module'): ContentPackage {
  return {
    version: 1,
    id,
    revision: 1,
    title: id,
    description: '',
    controls: [{ id: 'enabled', label: 'Enabled', type: 'boolean', default: false }],
    lore: [],
    instructions: [],
    transforms: [],
  };
}
describe('frozen execution context and module insertion', () => {
  it('preserves typed defaults and fixed clocks without reading wall time or mutating the snapshot', () => {
    const s = snapshot(),
      p = pkg();
    s.profile!.packages = [p];
    s.profile!.packageAttachments = [{ id: p.id, revision: 1, role: 'module' }];
    s.executionClock = { iso: '2026-09-07T01:02:03.000Z', unix: 1788742923 };
    s.packageStates = [
      {
        instanceId: 'module:module',
        packageId: p.id,
        packageRevision: 1,
        role: 'module',
        behaviorRevision: 1,
        schemaVersion: 1,
        stateRevision: 2,
        state: { count: 0, enabled: false, people: [{ name: 'A' }, { name: 'B' }] },
        draws: { die: 4 },
      },
    ];
    const before = JSON.stringify(s),
      runtime = executionContext(s, 'main', s.profile!.packageAttachments[0]);
    expect(evaluatePromptExpression({ context: ['state', 'count'] }, {}, { runtime })).toBe(0);
    expect(evaluatePromptExpression({ context: ['options', 'enabled'] }, {}, { runtime })).toBe(
      false
    );
    expect(evaluatePromptExpression({ context: ['draws', 'die'] }, {}, { runtime })).toBe(4);
    expect(runtime.time).toEqual({ ...s.executionClock, timezone: 'UTC' });
    expect(JSON.stringify(s)).toBe(before);
    delete s.executionClock;
    expect(executionContext(s).time).toEqual({ iso: null, unix: null, timezone: 'UTC' });
  });
  it('uses the main history projection and reports a bounded recent window', () => {
    const s = snapshot(),
      raw =
        'Visible.\n\n@hsTitle: Note\n⟦Library @ Morning @ Companion⟧\n\nHIDDEN_SENTINEL in a notebook.\n@hs\n\nAfter.\n<EvaluationReport><RevisionReport>[88]<DevelopmentReport>EVALUATION_SENTINEL.</EvaluationReport>';
    const hash = createHash('sha256').update(raw).digest('hex');
    s.sourceSegments = createSourceSegmentFixture({
      excludeAsides: true,
      excludeAnnotations: true,
    });
    s.history = [{ revision: 'source', text: raw }];
    s.logicalHistory = [
      {
        id: 'source:source',
        role: 'assistant',
        text: raw,
        sourceRevision: 'source',
        sourceHash: hash,
      },
    ];
    const encoded = JSON.stringify(executionContext(s));
    expect(encoded).toContain('Visible.');
    expect(encoded).not.toContain('HIDDEN_SENTINEL');
    expect(encoded).not.toContain('EVALUATION_SENTINEL');
    delete s.sourceSegments;
    s.logicalHistory = Array.from({ length: 120 }, (_, i) => ({
      id: String(i),
      role: 'user',
      text: 'x'.repeat(1000),
    }));
    const history = executionContext(s).history as any;
    expect(history.total).toBe(120);
    expect(history.truncated).toBe(true);
    expect(history.recent.length).toBe(60);
    expect(history.recent[0].id).toBe('60');
  });
  it('excludes disabled persona data and provider credentials from the main runtime', () => {
    const s = snapshot(),
      p = pkg('persona');
    p.body = 'PERSONA_PRIVATE';
    p.identity = { name: 'Persona', description: 'PERSONA_PRIVATE' };
    s.profile!.packages = [p];
    s.profile!.packageAttachments = [{ id: p.id, revision: 1, role: 'persona' }];
    s.profile!.personaReference = false;
    s.resources = [
      {
        id: 'package:persona:persona:lore:x',
        chatId: s.chatId,
        kind: 'lore',
        revision: 1,
        title: 'PERSONA_PRIVATE',
        description: 'PERSONA_PRIVATE',
        text: 'PERSONA_PRIVATE',
      },
    ];
    s.profile!.models.main = {
      id: 'm',
      revision: 1,
      title: 'Model',
      connectionId: 'c',
      modelId: 'not-a-capability-test',
      maxOutputTokens: 100,
      temperature: null,
      connection: {
        id: 'c',
        revision: 1,
        title: 'Connection',
        protocol: 'anthropic-messages-v1',
        endpoint: 'https://secret.invalid',
        credentialEnv: 'SECRET_ENV',
        enabled: true,
        catalog: [
          {
            id: 'not-a-capability-test',
            name: 'Model',
            capabilities: { tools: true },
            priceRevision: null,
          },
        ],
        catalogError: null,
      },
    };
    const text = JSON.stringify(executionContext(s));
    expect(text).not.toContain('PERSONA_PRIVATE');
    expect(text).not.toContain('secret.invalid');
    expect(text).not.toContain('SECRET_ENV');
    expect((executionContext(s).model as any).capabilities).toEqual({
      tools: true,
      prefill: false,
    });
    expect(JSON.stringify(executionContext(s, 'translation'))).toContain('PERSONA_PRIVATE');
  });
  it('renders dynamic people and inserts scoped module instructions once at a declared slot', () => {
    const s = snapshot(),
      p = pkg();
    p.instructions = [
      {
        id: 'roster',
        target: 'main',
        position: 'roster',
        text: 'fallback',
        template: [
          {
            kind: 'each',
            source: { literal: [{ name: 'A' }, { name: 'B' }] },
            as: 'person',
            body: [
              { kind: 'value', expression: { local: 'person', path: ['name'] } },
              { kind: 'text', text: ';' },
            ],
          },
        ],
      },
    ];
    s.profile!.packages = [p];
    s.profile!.packageAttachments = [{ id: p.id, revision: 1, role: 'module' }];
    const skipped = compileSnapshotPrompt(s).promptCompilation!;
    expect(skipped.warnings).toContain(
      `PACKAGE_INSTRUCTION_UNAVAILABLE:${JSON.stringify({ instanceId: 'module:module', instructionId: 'roster', code: 'PACKAGE_INSERTION_SLOT_MISSING' })}`
    );
    expect(JSON.stringify(skipped.messages)).not.toContain('A;B;');
    s.profile!.promptPresets = {
      main: {
        id: 'p',
        revision: 1,
        title: 'Prompt',
        role: 'main',
        program: {
          version: 1,
          controls: [],
          blocks: [
            {
              id: 'before',
              title: 'Before',
              kind: 'message',
              role: 'system',
              template: [{ kind: 'text', text: 'BEFORE' }],
            },
            { id: 'roster', title: 'Roster', kind: 'slot', role: 'system', slot: 'roster' },
            {
              id: 'after',
              title: 'After',
              kind: 'message',
              role: 'system',
              template: [{ kind: 'text', text: 'AFTER' }],
            },
            { id: 'turn', title: 'Turn', kind: 'current' },
          ],
        },
      },
    };
    expect(compiledPackages(s, 'main')[0].instructions[0].position).toBe('roster');
    const contents = compileSnapshotPrompt(s).promptCompilation!.messages.map((m) =>
      m.content.map((c) => c.text).join('')
    );
    expect(contents.filter((t) => t.includes('A;B;'))).toHaveLength(1);
    expect(contents.indexOf('BEFORE')).toBeLessThan(contents.indexOf('A;B;'));
    expect(contents.indexOf('A;B;')).toBeLessThan(contents.indexOf('AFTER'));
  });
  it('omits only absent-slot instructions while preserving other positions, host instructions and provenance', () => {
    const s = snapshot(),
      first = pkg('first'),
      second = pkg('second');
    first.instructions = [
      { id: 'plain-one', target: 'main', text: 'PLAIN_ONE' },
      { id: 'alpha-one', target: 'main', position: 'alpha', text: 'ALPHA_ONE' },
      { id: 'beta-one', target: 'main', position: 'beta', text: 'BETA_ONE' },
    ];
    second.instructions = [
      { id: 'alpha-two', target: 'main', position: 'alpha', text: 'ALPHA_TWO' },
      { id: 'plain-two', target: 'main', text: 'PLAIN_TWO' },
      { id: 'beta-two', target: 'main', position: 'beta', text: 'BETA_TWO' },
    ];
    s.profile!.packages = [first, second];
    s.profile!.packageAttachments = [first, second].map((p) => ({
      id: p.id,
      revision: 1,
      role: 'module',
    }));
    const program = {
      version: 1 as const,
      controls: [],
      blocks: [
        {
          id: 'alpha',
          title: 'Alpha',
          kind: 'slot' as const,
          role: 'system' as const,
          slot: 'alpha',
        },
        { id: 'beta', title: 'Beta', kind: 'slot' as const, role: 'system' as const, slot: 'beta' },
        { id: 'current', title: 'Current', kind: 'current' as const },
      ],
    };
    const expected = compileSnapshotPrompt(s, program).promptCompilation!;
    first.instructions.splice(1, 0, {
      id: 'missing-one',
      target: 'main',
      position: 'absent',
      text: 'OMITTED_ONE',
    });
    second.instructions.splice(2, 0, {
      id: 'missing-two',
      target: 'main',
      position: 'absent',
      text: 'OMITTED_TWO',
    });
    const before = structuredClone(s);
    const actual = compileSnapshotPrompt(s, program).promptCompilation!;
    expect(s).toEqual(before);
    expect(actual.messages).toEqual(expected.messages);
    expect(actual.trace).toEqual(expected.trace);
    expect(
      actual.warnings.filter((warning) => warning.startsWith('PACKAGE_INSTRUCTION_UNAVAILABLE:'))
    ).toEqual(
      ['first', 'second'].map(
        (id, index) =>
          `PACKAGE_INSTRUCTION_UNAVAILABLE:${JSON.stringify({ instanceId: `${id}:module`, instructionId: index === 0 ? 'missing-one' : 'missing-two', code: 'PACKAGE_INSERTION_SLOT_MISSING' })}`
      )
    );
    const messages = actual.messages.map((message) =>
      message.content.map((part) => part.text).join('')
    );
    expect(messages).toContain('ALPHA_ONE\n\nALPHA_TWO');
    expect(messages).toContain('BETA_ONE\n\nBETA_TWO');
    expect(messages.indexOf('ALPHA_ONE\n\nALPHA_TWO')).toBeLessThan(
      messages.indexOf('BETA_ONE\n\nBETA_TWO')
    );
    const text = JSON.stringify(actual.messages);
    expect(text).not.toContain('OMITTED_');
    expect(text.indexOf('PLAIN_ONE')).toBeLessThan(text.indexOf('PLAIN_TWO'));
  });
});
