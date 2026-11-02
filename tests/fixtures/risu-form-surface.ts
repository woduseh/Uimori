import { prepareRisuMessage } from '../../web/risu-message.js';
import { mountRisuMessageSurface } from '../../web/risu-message-surface.js';

export function mount() {
  const app = document.getElementById('mount')!;
  app.innerHTML = `
    <button id="preview" type="button">Toggle preview</button>
    <button id="revision" type="button">Next revision</button>
    <button id="fail" type="button">Fail next action</button>
    <output id="calls">[]</output><p id="state" role="alert"></p>
    <div class="risu-message-surface"></div>
  `;
  const prepared = prepareRisuMessage(`
    <form risu-form="설문" action="https://example.invalid/upload" method="post">
      <label>이름 <input name="name" required></label>
      <label><input type="checkbox" name="tags" value="독서" checked>독서</label>
      <label><input type="checkbox" name="tags" value="산책" checked>산책</label>
      <input name="__proto__" value="안전">
      <input data-test-clobber value="함수 이름도 입력값">
      <label>파일 <input type="file" name="attachment"></label>
      <button type="submit" name="submit" value="확인" formaction="https://example.invalid/other">보내기</button>
      <button type="submit" risu-trigger="choose" risu-id="선택-하나">직접 선택</button>
      <button type="submit" risu-trigger="choose-empty" risu-id="">빈 선택</button>
      <button type="submit" risu-btn="press">버튼 선택</button>
    </form>
    <form action="https://example.invalid/plain"><button type="submit">일반 제출</button></form>
    <script>window.badScriptExecuted = true</script><iframe src="https://example.invalid/frame"></iframe>
  `);
  const calls: unknown[] = [];
  const output = app.querySelector('#calls')!;
  const state = app.querySelector('#state')!;
  const view = mountRisuMessageSurface(
    app.querySelector<HTMLElement>('.risu-message-surface')!,
    prepared,
    (next) => {
      state.textContent = next.issue;
    }
  );
  let revision = 0;
  let disabled = false;
  let fail = false;
  const update = () =>
    view.updateAction({
      revision: String(revision),
      disabled,
      action: async (kind, name, payload) => {
        calls.push({ kind, name, ...(payload ?? {}) });
        output.textContent = JSON.stringify(calls);
        if (fail) {
          fail = false;
          throw new Error('Synthetic action failure');
        }
      },
    });
  app.querySelector('#preview')!.addEventListener('click', () => {
    disabled = !disabled;
    update();
  });
  app.querySelector('#revision')!.addEventListener('click', () => {
    revision++;
    update();
  });
  app.querySelector('#fail')!.addEventListener('click', () => {
    fail = true;
  });
  update();
}
