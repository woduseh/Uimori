import { useI18n } from './i18n.js';
import { useEffect, useRef } from 'react';
import { SIDE_PANEL_KEY_STEP } from './side-panel.js';

type Drag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  shell: HTMLElement | null;
};

export function SidePanelResizer({
  width,
  minimum,
  maximum,
  controls,
  onResize,
}: {
  width: number;
  minimum: number;
  maximum: number;
  controls: string;
  onResize: (width: number) => void;
}) {
  const { t } = useI18n();
  const drag = useRef<Drag | null>(null);
  const clamp = (value: number) => Math.round(Math.min(maximum, Math.max(minimum, value)));
  const show = (active: Drag, value: number) =>
    active.shell?.style.setProperty('--panel-w', `${value}px`);
  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    delete document.documentElement.dataset.panelResizing;
    if (commit && active.width !== active.startWidth) onResize(active.width);
    else show(active, active.startWidth);
  };
  useEffect(
    () => () => {
      if (drag.current) delete document.documentElement.dataset.panelResizing;
    },
    []
  );
  return (
    <div
      className="side-panel-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={t('chatsettings.m72')}
      aria-valuenow={width}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
          width,
          shell: event.currentTarget.closest('.app-shell'),
        };
        document.documentElement.dataset.panelResizing = '';
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        active.width = clamp(active.startWidth + active.startX - event.clientX);
        show(active, active.width);
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(true)}
      onKeyDown={(event) => {
        const next =
          event.key === 'ArrowLeft'
            ? width + SIDE_PANEL_KEY_STEP
            : event.key === 'ArrowRight'
              ? width - SIDE_PANEL_KEY_STEP
              : event.key === 'Home'
                ? minimum
                : event.key === 'End'
                  ? maximum
                  : null;
        if (next === null) return;
        event.preventDefault();
        const value = clamp(next);
        if (value !== width) onResize(value);
      }}
    />
  );
}
