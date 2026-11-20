export const helperPollDelay = {
  conversation: { active: 1200, idle: 10_000 },
  sessions: { active: 2400, idle: 10_000 },
};

export const longestHelperPollDelay = Math.max(
  helperPollDelay.conversation.idle,
  helperPollDelay.sessions.idle
);
