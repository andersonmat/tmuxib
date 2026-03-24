import type { SessionSummary } from "./types.js";

const sessionNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

export function stableSessions(sessions: SessionSummary[]) {
  return [...sessions].sort((left, right) => {
    return sessionNameCollator.compare(left.name, right.name);
  });
}

export function nextSessionNameAfterRemoval(
  previousSessions: SessionSummary[],
  nextSessions: SessionSummary[],
  removedSessionName: string
) {
  const stableNextSessions = stableSessions(nextSessions);

  if (stableNextSessions.length === 0) {
    return null;
  }

  const stablePreviousSessions = stableSessions(previousSessions);
  const removedSessionIndex = stablePreviousSessions.findIndex((session) => session.name === removedSessionName);

  if (removedSessionIndex === -1) {
    return stableNextSessions[0]?.name ?? null;
  }

  return stableNextSessions[removedSessionIndex]?.name ?? stableNextSessions[0]?.name ?? null;
}
