export const DEFAULT_CONNECTION_ISSUE = "Cannot connect to tmuxib. Check that it is running and reachable.";
export const LOST_CONNECTION_ISSUE = "Lost connection to tmuxib. Retry when the server is reachable.";
export const OFFLINE_CONNECTION_ISSUE = "You appear to be offline. tmuxib cannot connect until the network returns.";

export function getConnectionIssueMessage(error: unknown, options: { isOnline?: boolean } = {}) {
  if (options.isOnline === false) {
    return OFFLINE_CONNECTION_ISSUE;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  return /failed to fetch|fetch failed|networkerror|load failed|err_network|internet disconnected/i.test(error.message)
    ? DEFAULT_CONNECTION_ISSUE
    : null;
}
