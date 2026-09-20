import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeRisuRegexEditor } from '../../web/NativeRisuRegexEditor.js';
import '../../web/style.css';
import '../../web/product.css';
import '../../web/prompt-editor.css';
import '../../web/native-editor.css';

export function mount() {
  function Harness() {
    const [value, setValue] = useState<unknown[]>([
      {
        comment: 'First rule',
        in: '(hello)',
        find: '(hello)',
        out: '$1',
        replace: '$1',
        type: 'editdisplay',
        ableFlag: false,
        flag: 'gi<cbs><future_flag><order -2>',
        extra: { preserved: true },
      },
      { comment: 'Second rule', in: 'x', out: 'y', type: 'editinput' },
      { comment: 'Future rule', in: '', out: '', type: 'future_mode', unknown: [1, 2] },
    ]);
    const [pending, setPending] = useState(false);
    const [visible, setVisible] = useState(true);
    return (
      <div className="native-editor prompt-editor">
        <button type="button" onClick={() => setVisible(!visible)}>
          다른 탭
        </button>
        <div hidden={!visible}>
          <NativeRisuRegexEditor
            value={value}
            onChange={setValue}
            draftPath="test.regex"
            onPendingChange={setPending}
          />
        </div>
        <button type="button" disabled={pending}>
          Save
        </button>
        <output>{JSON.stringify(value)}</output>
      </div>
    );
  }
  createRoot(document.getElementById('mount')!).render(<Harness />);
}
