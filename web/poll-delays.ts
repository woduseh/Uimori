export const helperPollDelay = {
  conversation: { active: 1200, idle: 10_000 },
  sessions: { active: 2400, idle: 10_000 },
  task: 1200,
};

export const helperRefreshSpacing = 500;

export const activityPollDelay = { active: 2500, idle: 10_000 };
export const activityRefreshSpacing = 250;

export const contextJobPollDelay = 5000;

export const responseStreamPollDelay = { streaming: 120, waiting: 300, pushed: 2000 };

export const longestHelperPollDelay = Math.max(
  helperPollDelay.conversation.idle,
  helperPollDelay.sessions.idle
);

export const nativeInteractionRetryDelay = { first: 1000, longest: 10_000 };
