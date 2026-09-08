import { useEffect, useRef } from 'react';
import { interceptAppHistory } from './app-history.js';

/** One same-URL entry lets Back be handled before the underlying chat navigation. */
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
        // A history-menu jump can cross several chat entries. Keep a matching base
        // beneath the retained modal so a later Close cannot reveal a different URL.
        if (!samePage) history.pushState(base, '', url);
        enter();
        return true;
      } else {
        // Only our same-URL step belongs to this modal. Older chat navigation must
        // continue to useStory/main so the address and visible chat stay together.
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
