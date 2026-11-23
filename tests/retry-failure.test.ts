import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { RetryFailure } from '../web/RetryFailure.js';

const render = (props: Partial<Parameters<typeof RetryFailure>[0]>) =>
  renderToStaticMarkup(
    createElement(RetryFailure, {
      status: 'failed',
      onDetails: () => {},
      onHistory: () => {},
      ...props,
    })
  );

test.each(['HELPER_RESPONSE_REFUSED:SAFETY', 'HELPER_RESPONSE_REFUSED', 'SAFETY'])(
  'a task that ended with %s says the provider refused',
  (error) => {
    expect(render({ error })).toContain('프로바이더가 응답을 거절했어요');
  }
);

test('an unknown failure keeps the general message', () => {
  expect(render({ error: 'UNEXPECTED_EOF' })).toContain('응답을 만들지 못했어요');
});

test('continuing a stopped task is offered before a retry from the start', () => {
  const markup = render({ error: 'HTTP_429', onResume: () => {}, onRetry: () => {} });
  expect(markup).toContain('>이어서 하기<');
  expect(markup.indexOf('>이어서 하기<')).toBeLessThan(markup.indexOf('>다시 시도<'));
});
