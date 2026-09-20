export function jevProbePassed(entry) {
  if (entry.expected === 'budget-rejected')
    return (
      entry.errorCode === 'JEV_INPUT_BUDGET' &&
      entry.attemptCount === 0 &&
      entry.transportCount === 0
    );
  return (
    entry.status === 'completed' &&
    entry.attemptCount === 1 &&
    entry.transportCount === 1 &&
    entry.wholeStateMatches === true
  );
}
