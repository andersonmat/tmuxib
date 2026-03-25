export type { TmuxNotificationPayload } from "../shared/tmux-events.js";

export interface SessionSummary {
  name: string;
  windows: number;
  attached: number;
  created: string;
}

export interface WindowSummary {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface PaneSummary {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  id: string;
  active: boolean;
  command: string;
  path: string;
  title: string;
}

export interface DisconnectOptions {
  preserveTerminal?: boolean;
  suppressReconnect?: boolean;
  clearSession?: boolean;
  historyMode?: "push" | "replace" | "skip";
}

export interface ClientState {
  currentSession: string | null;
  currentPane: string | null;
  windows: WindowSummary[];
  sessions: SessionSummary[];
  panes: PaneSummary[];
  creatingSession: boolean;
  showingPasteComposer: boolean;
  connectionIssue: string | null;
  terminalFontSize: number;
}

export interface ApiError extends Error {
  status?: number;
}

export interface RuntimeState {
  ws: WebSocket | null;
  reconnecting: boolean;
  suppressedSocket: WebSocket | null;
  lastSessionListSyncAt: number;
  lastLocalResizeAt: number;
}

export type StateAction =
  | {
      type: "sessionsLoaded";
      sessions: SessionSummary[];
    }
  | {
      type: "setCurrentSession";
      sessionName: string | null;
    }
  | {
      type: "replaceSessionState";
      windows: WindowSummary[];
      panes: PaneSummary[];
    }
  | {
      type: "clearSessionState";
    }
  | {
      type: "disconnect";
      clearSession: boolean;
    }
  | {
      type: "setCreatingSession";
      visible: boolean;
    }
  | {
      type: "setShowingPasteComposer";
      visible: boolean;
    }
  | {
      type: "setConnectionIssue";
      message: string | null;
    }
  | {
      type: "setTerminalFontSize";
      fontSize: number;
    };
