/** Public runtime metadata. No credentials, private paths or raw provider errors. */
export type CodexRuntimeStatus = {
  available: boolean;
  authenticated: boolean;
  authMode: 'chatgpt' | 'apikey' | null;
  error: string | null;
  login: { id: string; verificationUrl: string; userCode: string } | null;
  planType: string | null;
  credits?: { balance: number | null; hasCredits: boolean; unlimited: boolean } | null;
  limits: {
    name: string;
    usedPercent: number;
    resetsAt: number | null;
    windowDurationMins: number | null;
  }[];
};
