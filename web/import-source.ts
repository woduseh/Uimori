/** Read a chosen file once; the caller owns size limits, review, cancellation and adoption. */
export function readImportSource(file: File): Promise<{ name: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했어요. 다시 선택해 주세요.'));
    reader.onabort = () => reject(new Error('파일 읽기가 취소됐어요.'));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== 'string' || !data.includes(',')) {
        reject(new Error('파일 내용을 읽지 못했어요.'));
        return;
      }
      resolve({ name: file.name, base64: data.slice(data.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}
