import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const TabsSlot = createContext<HTMLElement | null | undefined>(undefined);

export function EditorFrame({
  header,
  notice,
  children,
}: {
  header: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  const [tabs, setTabs] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <div className="editor-frame-top">
        {header}
        <div ref={setTabs} className="editor-frame-tabs" />
        {notice}
      </div>
      <TabsSlot.Provider value={tabs}>{children}</TabsSlot.Provider>
    </>
  );
}

export function EditorFrameTabs({ children }: { children: ReactNode }) {
  const slot = useContext(TabsSlot);
  if (slot === undefined) return children;
  return slot ? createPortal(children, slot) : null;
}
