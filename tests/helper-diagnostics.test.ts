import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { helperArgumentDiagnostic } from '../server/helper-diagnostics.js';

test('argument previews redact secrets and inline attachments before truncation', () => {
  const args = {
    command:
      'echo Bearer synthetic-credential; api_key="inline-secret"; echo data:image/png;base64,aW1hZ2UtYnl0ZXM=',
    password: 'synthetic-password',
    nested: { base64: 'cGl4ZWxz' },
    content: '본문'.repeat(1500),
  };
  const diagnostic = helperArgumentDiagnostic(args);
  expect(diagnostic).toMatchObject({
    argsChars: JSON.stringify(args).length,
    argsSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
    argsTruncated: true,
    argsRedacted: true,
  });
  expect(diagnostic.argsPreview.length).toBeLessThanOrEqual(1024);
  expect(diagnostic.argsPreview).not.toContain('synthetic-credential');
  expect(diagnostic.argsPreview).not.toContain('synthetic-password');
  expect(diagnostic.argsPreview).not.toContain('inline-secret');
  expect(diagnostic.argsPreview).not.toContain('aW1hZ2UtYnl0ZXM');
  expect(diagnostic.argsPreview).not.toContain('cGl4ZWxz');
});

test('deep valid arguments cannot fail the tool while preparing a diagnostic preview', () => {
  let args: any = {};
  for (let i = 0; i < 3000; i++) args = { child: args };
  const original = JSON.stringify(args);
  const diagnostic = helperArgumentDiagnostic(args);
  expect(diagnostic).toMatchObject({
    argsPreview: '[argument preview unavailable]',
    argsChars: original.length,
    argsSha256: createHash('sha256').update(original).digest('hex'),
    argsTruncated: true,
    argsRedacted: true,
  });
});
