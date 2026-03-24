export interface TmuxNotificationPayload {
  type: "tmux";
  event: string;
  refreshState: boolean;
  refreshSessions: boolean;
  sessionName?: string;
}

export function parseTmuxControlNotification(line: string): TmuxNotificationPayload | null {
  if (!line.startsWith("%")) {
    return null;
  }

  const spaceIndex = line.indexOf(" ");
  const rawEvent = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1).trim();
  const event = rawEvent.slice(1);

  switch (event) {
    case "layout-change":
    case "pane-mode-changed":
    case "session-window-changed":
    case "window-add":
    case "window-close":
    case "window-pane-changed":
    case "window-renamed":
      return {
        type: "tmux",
        event,
        refreshState: true,
        refreshSessions: false
      };

    case "session-renamed":
      return {
        type: "tmux",
        event,
        sessionName: rest || undefined,
        refreshState: true,
        refreshSessions: true
      };

    case "session-changed":
      return {
        type: "tmux",
        event,
        sessionName: restAfterTokens(rest, 1),
        refreshState: true,
        refreshSessions: true
      };

    case "client-session-changed":
      return {
        type: "tmux",
        event,
        sessionName: restAfterTokens(rest, 2),
        refreshState: true,
        refreshSessions: true
      };

    case "sessions-changed":
    case "exit":
      return {
        type: "tmux",
        event,
        refreshState: event === "exit",
        refreshSessions: true
      };

    default:
      return null;
  }
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
