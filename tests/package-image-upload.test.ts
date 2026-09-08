import { afterEach, expect, test, vi } from 'vitest';
import { uploadPackageImage } from '../web/package-image-upload.js';

afterEach(() => vi.unstubAllGlobals());

test('profile and inline authoring share upload validation and preserve the requested use', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ hash: 'a'.repeat(64), mime: 'image/png' })));
  vi.stubGlobal('fetch', fetch);
  const file = new File([new Uint8Array([137, 80, 78, 71])], '  portrait.png', {
    type: 'image/png',
  });
  const image = await uploadPackageImage(file, new AbortController().signal, 'profile');
  expect(image).toMatchObject({
    title: 'portrait',
    mime: 'image/png',
    blobHash: 'a'.repeat(64),
    allowedUse: 'profile',
  });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/package-image-blobs');
  expect(JSON.parse(options.body)).toEqual({ mime: 'image/png', base64: 'iVBORw==' });
  for (const invalid of [
    new File([], 'empty.png', { type: 'image/png' }),
    new File(['text'], 'fake.svg', { type: 'image/svg+xml' }),
    new File([new Uint8Array(2_000_001)], 'large.png', { type: 'image/png' }),
  ])
    await expect(uploadPackageImage(invalid, new AbortController().signal, 'both')).rejects.toThrow(
      '2MB'
    );
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('cancel while reading a selected file prevents sending bytes to the server', async () => {
  let finish!: (bytes: ArrayBuffer) => void;
  const file = new File(['x'], 'pending.png', { type: 'image/png' });
  vi.spyOn(file, 'arrayBuffer').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const pending = uploadPackageImage(file, controller.signal, 'profile');
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  finish(new ArrayBuffer(1));
  await rejected;
  expect(fetch).not.toHaveBeenCalled();
});

test('an aborted late response and mismatched server MIME cannot become draft images', async () => {
  let finish!: (value: unknown) => void;
  const fetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const pending = uploadPackageImage(
    new File(['x'], 'pending.png', { type: 'image/png' }),
    controller.signal,
    'profile'
  );
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish({ hash: 'b'.repeat(64), mime: 'image/png' });
  await rejected;
  fetch.mockResolvedValue(
    new Response(JSON.stringify({ hash: 'b'.repeat(64), mime: 'image/jpeg' }))
  );
  await expect(
    uploadPackageImage(
      new File(['x'], 'wrong.png', { type: 'image/png' }),
      new AbortController().signal,
      'both'
    )
  ).rejects.toThrow('이미지 응답을 확인할 수 없어요.');
});
