import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';

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
    const wrap = (content: ReactNode) => (wrapFallback ? wrapFallback(content, props) : content);
    return (
      <PanelErrorBoundary
        fallback={wrap(
          <p role="alert">
            화면을 불러오지 못했어요. 작성 중인 내용은 먼저 보관하고 연결을 확인한 뒤 새로고침해
            주세요.
          </p>
        )}
      >
        <Suspense fallback={wrap(<p role="status">{label} 화면을 불러오는 중이에요…</p>)}>
          <Panel {...props} />
        </Suspense>
      </PanelErrorBoundary>
    );
  };
}
