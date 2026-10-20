import { t, translateMessage, useI18n } from './i18n.js';
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { LoadingState } from './LoadingState.js';

class PanelErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

/** Create once at module scope so loading cannot change a mounted panel's identity. */
export function deferredPanel<Props extends object>(
  label: string,
  loader: () => Promise<{ default: ComponentType<Props> }>,
  wrapFallback?: (content: ReactNode, props: Props) => ReactNode
) {
  const Panel = lazy(loader);
  return function DeferredPanel(props: Props) {
    useI18n();
    const wrap = (content: ReactNode) => (wrapFallback ? wrapFallback(content, props) : content);
    return (
      <PanelErrorBoundary
        fallback={wrap(
          <LoadingState
            presentation="region"
            loading={false}
            error={t('shared.panelFailureHelp')}
            errorLabel={t('shared.panelFailure')}
          />
        )}
      >
        <Suspense
          fallback={wrap(
            <LoadingState
              presentation="region"
              label={t('shared.panelLoading', { label: translateMessage(label) })}
            />
          )}
        >
          <Panel {...props} />
        </Suspense>
      </PanelErrorBoundary>
    );
  };
}
