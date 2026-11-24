export const helperPollDelay = {
  conversation: { active: 1200, idle: 10_000 },
  sessions: { active: 2400, idle: 10_000 },
  task: 1200,
};

export const helperRefreshSpacing = 500;

export const longestHelperPollDelay = Math.max(
  helperPollDelay.conversation.idle,
  helperPollDelay.sessions.idle
);

export const nativeInteractionRetryDelay = { first: 1000, longest: 10_000 };
