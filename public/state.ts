import type { ClientState, PaneSummary, RuntimeState, SessionSummary, StateAction, WindowSummary } from "./types.js";

export function createInitialState(options: { terminalFontSize?: number } = {}): ClientState {
  return {
    currentSession: null,
    currentPane: null,
    windows: [],
    sessions: [],
    panes: [],
    creatingSession: false,
    showingPasteComposer: false,
    connectionIssue: null,
    terminalFontSize: options.terminalFontSize ?? 13
  };
}

export function createInitialRuntime(): RuntimeState {
  return {
    ws: null,
    reconnecting: false,
    suppressedSocket: null,
    syncTimer: 0,
    syncing: false,
    lastSessionListSyncAt: 0
  };
}

export function reduceState(currentState: ClientState, action: StateAction): ClientState {
  switch (action.type) {
    case "sessionsLoaded":
      return sameSessions(currentState.sessions, action.sessions)
        ? currentState
        : { ...currentState, sessions: action.sessions };

    case "setCurrentSession":
      return currentState.currentSession === action.sessionName
        ? currentState
        : { ...currentState, currentSession: action.sessionName };

    case "replaceSessionState": {
      const currentPane = deriveCurrentPane(action.panes, action.windows, currentState.currentPane);
      const sessions = replaceSessionWindowCount(currentState.sessions, currentState.currentSession, action.windows.length);

      if (
        sameWindows(currentState.windows, action.windows) &&
        samePanes(currentState.panes, action.panes) &&
        currentState.currentPane === currentPane &&
        sameSessions(currentState.sessions, sessions)
      ) {
        return currentState;
      }

      return {
        ...currentState,
        windows: action.windows,
        panes: action.panes,
        currentPane,
        sessions
      };
    }

    case "clearSessionState":
      return currentState.currentPane === null && currentState.windows.length === 0 && currentState.panes.length === 0
        ? currentState
        : {
            ...currentState,
            currentPane: null,
            windows: [],
            panes: []
          };

    case "disconnect":
      return {
        ...currentState,
        currentSession: action.clearSession ? null : currentState.currentSession,
        currentPane: null,
        showingPasteComposer: false,
        windows: [],
        panes: []
      };

    case "setCreatingSession":
      return currentState.creatingSession === action.visible
        ? currentState
        : { ...currentState, creatingSession: action.visible };

    case "setShowingPasteComposer":
      return currentState.showingPasteComposer === action.visible
        ? currentState
        : { ...currentState, showingPasteComposer: action.visible };

    case "setConnectionIssue":
      return currentState.connectionIssue === action.message
        ? currentState
        : { ...currentState, connectionIssue: action.message };

    case "setTerminalFontSize":
      return currentState.terminalFontSize === action.fontSize
        ? currentState
        : { ...currentState, terminalFontSize: action.fontSize };
  }
}

export function deriveCurrentPane(
  panes: PaneSummary[] = [],
  windows: WindowSummary[] = [],
  currentPane: string | null = null
) {
  if (panes.length === 0) {
    return null;
  }

  const activeWindow = windows.find((entry) => entry.active);
  const scopedPanes = activeWindow
    ? panes.filter((pane) => pane.windowIndex === activeWindow.index)
    : panes;

  if (scopedPanes.length === 0) {
    return panes[0]?.id ?? null;
  }

  const activePane = scopedPanes.find((pane) => pane.active);
  if (activePane) {
    return activePane.id;
  }

  if (currentPane && scopedPanes.some((pane) => pane.id === currentPane)) {
    return currentPane;
  }

  return scopedPanes[0]?.id ?? null;
}

export function visiblePanes(panes: PaneSummary[], windows: WindowSummary[]) {
  const activeWindowIndex = currentWindowIndex(windows);

  if (activeWindowIndex === null) {
    return panes;
  }

  return panes.filter((pane) => pane.windowIndex === activeWindowIndex);
}

export function currentWindowIndex(windows: WindowSummary[]) {
  return windows.find((entry) => entry.active)?.index ?? windows[0]?.index ?? null;
}

export function paneLabel(pane: PaneSummary) {
  if (pane.title && pane.title !== pane.command) {
    return pane.title;
  }

  return pane.command || pane.id;
}

function replaceSessionWindowCount(sessions: SessionSummary[], currentSession: string | null, windowCount: number) {
  if (!currentSession) {
    return sessions;
  }

  let changed = false;
  const nextSessions = sessions.map((session) => {
    if (session.name !== currentSession || session.windows === windowCount) {
      return session;
    }

    changed = true;
    return { ...session, windows: windowCount };
  });

  return changed ? nextSessions : sessions;
}

function sameSessions(left: SessionSummary[], right: SessionSummary[]) {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const other = right[index];
      return Boolean(
        other &&
        session.name === other.name &&
        session.windows === other.windows &&
        session.attached === other.attached &&
        session.created === other.created
      );
    })
  );
}

function sameWindows(left: WindowSummary[], right: WindowSummary[]) {
  return (
    left.length === right.length &&
    left.every((windowEntry, index) => {
      const other = right[index];
      return Boolean(
        other &&
        windowEntry.sessionName === other.sessionName &&
        windowEntry.index === other.index &&
        windowEntry.name === other.name &&
        windowEntry.active === other.active &&
        windowEntry.panes === other.panes
      );
    })
  );
}

function samePanes(left: PaneSummary[], right: PaneSummary[]) {
  return (
    left.length === right.length &&
    left.every((pane, index) => {
      const other = right[index];
      return Boolean(
        other &&
        pane.sessionName === other.sessionName &&
        pane.windowIndex === other.windowIndex &&
        pane.windowName === other.windowName &&
        pane.paneIndex === other.paneIndex &&
        pane.id === other.id &&
        pane.active === other.active &&
        pane.command === other.command &&
        pane.path === other.path &&
        pane.title === other.title
      );
    })
  );
}
