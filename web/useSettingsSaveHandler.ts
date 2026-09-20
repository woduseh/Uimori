import { useEffect, useMemo, useRef } from 'react';

export type SettingsSaveHandler = () => Promise<boolean>;
export type SettingsSaveRegistration = (handler: SettingsSaveHandler | null) => void;

/** Expose the current editor operation without capturing an outdated draft. */
export function useSettingsSaveHandler(
  register: SettingsSaveRegistration | undefined,
  save: SettingsSaveHandler
) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    register?.(() => latest.current());
    return () => register?.(null);
  }, [register]);
}

/** Keep child save registrations stable while each editor exposes its latest draft. */
export function useSettingsSaveGroup(keys: readonly string[]) {
  const handlers = useRef<Record<string, SettingsSaveHandler | null>>({});
  const registrations = useMemo(
    () =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          (handler: SettingsSaveHandler | null) => {
            handlers.current[key] = handler;
          },
        ])
      ),
    [keys]
  );
  async function save(dirty: Record<string, boolean>) {
    for (const key of keys) {
      if (dirty[key] && !(await handlers.current[key]?.())) return false;
    }
    return true;
  }
  return { registrations, save };
}
