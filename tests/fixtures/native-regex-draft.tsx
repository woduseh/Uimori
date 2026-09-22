import { useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { ResourceEditorProvider } from '../../web/resource-editor.js';
import { NativeRisuRegexEditor } from '../../web/NativeRisuRegexEditor.js';
import '../../web/style.css';
import '../../web/native-editor.css';

export function mount() {
  function Harness() {
    const [value, setValue] = useState<unknown[]>([
      { comment: 'Rule', type: 'editdisplay', in: 'start', out: 'out' },
    ]);
    const [rawFields, setRawFields] = useState<Record<string, string>>({});
    const [restoreVersion, setRestoreVersion] = useState(0);
    const [pending, setPending] = useState(false);
    const [replacement, setReplacement] = useState(0);
    // Exercise the real draft context/buffer hook while keeping persistence outside this UI test.
    const provider = {
      state: { local: { rawFields }, restoreVersion },
      session: {
        setField: (path: string, text: string) =>
          setRawFields((current) =>
            current[path] === text ? current : { ...current, [path]: text }
          ),
        pendingField: () => {},
        prepareOnSave: () => () => {},
      },
      activate: () => {},
    } as unknown as ComponentProps<typeof ResourceEditorProvider>['value'];
    return (
      <ResourceEditorProvider value={provider}>
        <div className="native-editor">
          <button
            type="button"
            onClick={() => {
              setReplacement(replacement + 1);
              setValue([
                {
                  comment: 'Parent replacement',
                  type: 'editdisplay',
                  in: `parent-${replacement + 1}`,
                  out: 'parent output',
                  preserved: true,
                },
              ]);
            }}
          >
            부모 JSON 적용
          </button>
          <button
            type="button"
            onClick={() => {
              setValue([
                { comment: 'Remote', type: 'editinput', in: 'remote', out: 'remote output' },
              ]);
              setRawFields({ 'test.regex': '[remote unfinished' });
              setRestoreVersion(restoreVersion + 1);
            }}
          >
            원격 초안 복원
          </button>
          <NativeRisuRegexEditor
            value={value}
            onChange={setValue}
            draftPath="test.regex"
            onPendingChange={setPending}
          />
          <button type="button" disabled={pending}>
            Save
          </button>
          <output>{JSON.stringify(value)}</output>
        </div>
      </ResourceEditorProvider>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
