import { lazy, Suspense, type ComponentProps } from 'react';
import { LoadingState } from './LoadingState.js';
import { uiMessage } from './ui-message.js';

const Surface = lazy(() => import('./StoryUi.js').then((module) => ({ default: module.StoryUi })));

export function StoryUi(props: ComponentProps<typeof Surface>) {
  return (
    <Suspense
      fallback={
        <LoadingState presentation="placeholder" label={uiMessage('reader.loadingResult')} />
      }
    >
      <Surface {...props} />
    </Suspense>
  );
}
