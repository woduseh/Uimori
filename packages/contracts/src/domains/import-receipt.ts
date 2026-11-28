export type NativeTransferReceipt = {
  id: string;
  created: boolean;
  digest: string;
  importedAt: string;
  summary: {
    contents: number;
    prompts: number;
    combinations: number;
    images: number;
    imageBytes: number;
  };
  items: {
    kind: 'content' | 'prompt-preset';
    key: string;
    title: string;
    category: 'bot' | 'persona' | 'module' | 'main' | 'translation';
    root: boolean;
    id: string;
    revision: number;
  }[];
};
