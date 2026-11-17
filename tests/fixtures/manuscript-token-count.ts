export async function manuscriptTokenCount(text: string) {
  const { get_encoding } = await import('tiktoken');
  const encoder = get_encoding('o200k_base');
  try {
    return encoder.encode(text).length;
  } finally {
    encoder.free();
  }
}
