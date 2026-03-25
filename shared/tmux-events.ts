export interface TmuxNotificationPayload {
  type: "tmux";
  event: string;
  refreshState: boolean;
  refreshSessions: boolean;
  ignoreResizeEcho?: boolean;
  forceResize?: boolean;
  sessionName?: string;
}

interface TmuxEventPolicy {
  refreshState: boolean;
  refreshSessions: boolean;
  ignoreResizeEcho?: boolean;
  forceResize?: boolean;
  sessionNameParser?: (rest: string) => string | undefined;
}

const TMUX_EVENT_POLICIES: Record<string, TmuxEventPolicy> = {
  "pane-mode-changed": {
    refreshState: true,
    refreshSessions: false
  },
  "session-window-changed": {
    refreshState: true,
    refreshSessions: false,
    ignoreResizeEcho: true,
    forceResize: true
  },
  "window-add": {
    refreshState: true,
    refreshSessions: false,
    forceResize: true
  },
  "window-close": {
    refreshState: true,
    refreshSessions: false
  },
  "window-pane-changed": {
    refreshState: true,
    refreshSessions: false,
    ignoreResizeEcho: true
  },
  "window-renamed": {
    refreshState: true,
    refreshSessions: false
  },
  "layout-change": {
    refreshState: false,
    refreshSessions: false
  },
  "session-renamed": {
    refreshState: true,
    refreshSessions: true,
    sessionNameParser: (rest) => rest || undefined
  },
  "session-changed": {
    refreshState: true,
    refreshSessions: true,
    sessionNameParser: (rest) => restAfterTokens(rest, 1)
  },
  "client-session-changed": {
    refreshState: false,
    refreshSessions: false,
    sessionNameParser: (rest) => restAfterTokens(rest, 2)
  },
  "sessions-changed": {
    refreshState: false,
    refreshSessions: true
  },
  exit: {
    refreshState: true,
    refreshSessions: true
  }
};

export function parseTmuxControlNotification(line: string): TmuxNotificationPayload | null {
  if (!line.startsWith("%")) {
    return null;
  }

  const spaceIndex = line.indexOf(" ");
  const rawEvent = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1).trim();
  const event = rawEvent.slice(1);
  const policy = TMUX_EVENT_POLICIES[event];

  if (!policy) {
    return null;
  }

  return {
    type: "tmux",
    event,
    refreshState: policy.refreshState,
    refreshSessions: policy.refreshSessions,
    ignoreResizeEcho: policy.ignoreResizeEcho,
    forceResize: policy.forceResize,
    sessionName: policy.sessionNameParser?.(rest)
  };
}

function restAfterTokens(input: string, count: number) {
  let rest = input.trim();

  for (let index = 0; index < count; index += 1) {
    const spaceIndex = rest.indexOf(" ");
    if (spaceIndex === -1) {
      return undefined;
    }

    rest = rest.slice(spaceIndex + 1).trimStart();
  }

  return rest || undefined;
}
