import { useEffect, useRef } from 'react';
import { interceptAppHistory } from './app-history.js';

export function useSettingsHistory(onBack: () => boolean, onClose: () => void) {
  const handlers = useRef({ onBack, onClose });
  handlers.current = { onBack, onClose };
  const close = useRef(() => onClose());
  useEffect(() => {
    const token = crypto.randomUUID();
    const base = history.state;
    const url = location.href;
    let closing = false;
    const enter = () => history.pushState({ ...base, uimoriSettings: token }, '', url);
    const owns = () => history.state?.uimoriSettings === token;
    enter();
    const pop = () => {
      if (owns()) return true;
      const samePage = location.href === url;
      const keep = !closing && handlers.current.onBack();
      if (keep) {
        if (!samePage) history.pushState(base, '', url);
        enter();
        return true;
      } else {
        handlers.current.onClose();
        return samePage;
      }
    };
    const stopIntercepting = interceptAppHistory(pop);
    close.current = () => {
      if (closing) return;
      if (owns()) {
        closing = true;
        history.back();
      } else handlers.current.onClose();
    };
    return () => {
      stopIntercepting();
      if (owns()) history.replaceState(base, '', url);
    };
  }, []);
  return () => close.current();
}
