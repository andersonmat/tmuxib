import { render } from "preact";

import { AppView } from "./app-view.js";
import { DEFAULT_CONNECTION_ISSUE, getConnectionIssueMessage, LOST_CONNECTION_ISSUE } from "./connection-issue.js";
import { nextSessionNameAfterRemoval, stableSessions } from "./session-order.js";
import { SessionRequestTracker } from "./session-request-tracker.js";
import { SessionSyncController } from "./session-sync.js";
import { createInitialRuntime, createInitialState, reduceState } from "./state.js";
import "./styles.css";
import {
  applyTerminalFontSize,
  fitTerminal,
  pasteFromClipboard,
  pasteTerminalText,
  protocol,
  readStoredTerminalFontSize,
  terminal
} from "./terminal.js";
import type { SocketPayload } from "../shared/terminal-protocol.js";
import type {
  ApiError,
  ClientState,
  DisconnectOptions,
  PaneSummary,
  RuntimeState,
  SessionSummary,
  StateAction,
  TmuxNotificationPayload,
  WindowSummary
} from "./types.js";
type SessionStatePayload = { windows: WindowSummary[]; panes: PaneSummary[] };
type HistoryMode = NonNullable<DisconnectOptions["historyMode"]>;

const SESSION_LIST_SYNC_INTERVAL_MS = 5000;
const SESSION_ROUTE_PREFIX = "/s/";
const LOCAL_RESIZE_ECHO_WINDOW_MS = 250;

const rootElement = requireElement<HTMLDivElement>("app");

let state: ClientState = createInitialState({
  terminalFontSize: readStoredTerminalFontSize()
});

const runtime: RuntimeState = createInitialRuntime();
const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});

let terminalFrameElement: HTMLDivElement | null = null;
let sessionNameInputElement: HTMLInputElement | null = null;
let pasteInputElement: HTMLTextAreaElement | null = null;
let pendingFitFrame = 0;
let pendingSettledFitFrame = 0;
let pendingFitForce = false;
let lastResizeCols: number | null = null;
let lastResizeRows: number | null = null;
const sessionRequests = new SessionRequestTracker();

const sessionSync = new SessionSyncController({
  getHasCurrentSession() {
    return Boolean(state.currentSession);
  },
  getIsDocumentHidden() {
    return document.hidden;
  },
  async loadSessions() {
    await loadSessions();
  },
  async loadSessionState() {
    await loadSessionState();
  },
  async refreshSessionListIfStale() {
    await refreshSessionListIfStale();
  },
  scheduleForceResize() {
    scheduleFit({ force: true });
  },
  reportError(error: unknown) {
    reportError(error);
  }
});

terminal.onData((data) => {
  sendMessage({ type: "input", data });
});

document.addEventListener("visibilitychange", reportActionError(async () => {
  if (!document.hidden) {
    await syncCurrentSession();
  }
}));

window.addEventListener("load", () => {
  scheduleFit();
});

window.addEventListener("popstate", reportActionError(async () => {
  const sessionName = readSessionFromLocation();

  if (!sessionName) {
    disconnectTerminal({ preserveTerminal: true, suppressReconnect: true, historyMode: "skip" });
    await loadSessions();
    return;
  }

  await openSession(sessionName, { preserveTerminal: true, historyMode: "skip" });
}));

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    scheduleFit();
  });
}

renderView();
void bootstrap().catch((error) => {
  reportError(error);
});

function dispatch(action: StateAction) {
  const nextState = reduceState(state, action);

  if (nextState === state) {
    return;
  }

  state = nextState;
  renderView();
}

function renderView() {
  render(
    <AppView
      state={state}
      terminalFrameRef={bindTerminalFrame}
      sessionNameInputRef={bindSessionNameInput}
      pasteInputRef={bindPasteInput}
      onToggleCreateForm={() => {
        setCreateFormVisible(!state.creatingSession);
      }}
      onRetryConnection={reportActionError(async () => {
        await retryConnection();
      })}
      onCreateSessionSubmit={reportActionError(async (event: Event) => {
        event.preventDefault();
        await createSession();
      })}
      onCreateSessionCancel={() => {
        setCreateFormVisible(false);
      }}
      onOpenSession={reportActionError(async (sessionName: string) => {
        await openSession(sessionName, { preserveTerminal: true, historyMode: "push" });
      })}
      onPasteToggle={reportActionError(async () => {
        await togglePasteComposer();
      })}
      onSplitPane={reportActionError(async (direction: "vertical" | "horizontal") => {
        await splitPane(direction);
      })}
      onUpdateTerminalFontSize={updateTerminalFontSize}
      onPasteSubmit={reportActionError(async (event: Event) => {
        event.preventDefault();
        await submitPaste();
      })}
      onPasteCancel={() => {
        setPasteComposerVisible(false);
        terminal.focus();
      }}
      onSelectWindow={reportActionError(async (windowIndex: number) => {
        await selectWindow(windowIndex);
      })}
      onSelectPane={reportActionError(async (paneId: string) => {
        await selectPane(paneId);
      })}
    />,
    rootElement
  );
}

async function bootstrap() {
  scheduleFit();
  await loadSessions();

  const requestedSession = readSessionFromLocation();

  if (requestedSession) {
    await openSession(requestedSession, { preserveTerminal: true, historyMode: "skip" });
    return;
  }

  if (state.sessions.length === 1) {
    await openSession(state.sessions[0].name, { preserveTerminal: true, historyMode: "replace" });
  }
}

async function loadSessions() {
  const requestId = sessionRequests.beginSessionListRequest();
  const previousSessions = state.sessions;
  const previousCurrentSession = state.currentSession;
  const { sessions } = await api<{ sessions: SessionSummary[] }>("/api/sessions");

  if (!sessionRequests.isLatestSessionListRequest(requestId)) {
    return;
  }

  const orderedSessions = stableSessions(sessions);
  runtime.lastSessionListSyncAt = Date.now();

  dispatch({ type: "sessionsLoaded", sessions: orderedSessions });

  if (!previousCurrentSession || state.currentSession !== previousCurrentSession) {
    return;
  }

  const stillExists = orderedSessions.some((session) => session.name === previousCurrentSession);

  if (stillExists) {
    return;
  }

  const fallbackSessionName = nextSessionNameAfterRemoval(previousSessions, orderedSessions, previousCurrentSession);

  if (fallbackSessionName) {
    await openSession(fallbackSessionName, { preserveTerminal: true, historyMode: "replace" });
    return;
  }

  disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
}

async function loadSessionState() {
  if (!state.currentSession) {
    clearSessionState();
    return;
  }

  const request = sessionRequests.beginSessionStateRequest(state.currentSession);

  try {
    const sessionState = await api<SessionStatePayload>(`/api/sessions/${encodeURIComponent(request.sessionName)}/state`);

    if (!sessionRequests.canApplySessionState(request, state.currentSession)) {
      return;
    }

    replaceSessionState(request.sessionName, sessionState);
  } catch (error) {
    if (!sessionRequests.canApplySessionState(request, state.currentSession)) {
      return;
    }

    if (readErrorStatus(error) === 404) {
      await loadSessions();
      return;
    }

    throw error;
  }
}

async function createSession() {
  const payload = {
    name: sessionNameInputElement?.value.trim() || undefined
  };

  const { session } = await api<{ session: SessionSummary }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (sessionNameInputElement) {
    sessionNameInputElement.value = "";
  }

  setCreateFormVisible(false);
  await loadSessions();
  await openSession(session.name, { preserveTerminal: true, historyMode: "push" });
}

async function togglePasteComposer() {
  if (!state.currentSession) {
    return;
  }

  const pasted = await pasteFromClipboard();

  if (pasted) {
    setPasteComposerVisible(false);
    return;
  }

  setPasteComposerVisible(true);
}

async function submitPaste() {
  if (!state.currentSession) {
    return;
  }

  const text = pasteInputElement?.value ?? "";

  if (!text) {
    setPasteComposerVisible(false);
    terminal.focus();
    return;
  }

  pasteTerminalText(text);

  if (pasteInputElement) {
    pasteInputElement.value = "";
  }

  setPasteComposerVisible(false);
}

async function refreshSessionListIfStale(force = false) {
  if (force || Date.now() - runtime.lastSessionListSyncAt >= SESSION_LIST_SYNC_INTERVAL_MS) {
    await loadSessions();
  }
}

function clearSessionState() {
  dispatch({ type: "clearSessionState" });
}

function replaceSessionState(sessionName: string, sessionState: SessionStatePayload) {
  if (state.currentSession !== sessionName) {
    return;
  }

  dispatch({
    type: "replaceSessionState",
    windows: sessionState.windows,
    panes: sessionState.panes
  });
}

function setCreateFormVisible(visible: boolean) {
  if (visible && state.showingPasteComposer) {
    dispatch({ type: "setShowingPasteComposer", visible: false });

    if (pasteInputElement) {
      pasteInputElement.value = "";
    }
  }

  dispatch({ type: "setCreatingSession", visible });

  if (visible) {
    sessionNameInputElement?.focus();
    sessionNameInputElement?.select();
  }
}

function setPasteComposerVisible(visible: boolean) {
  if (visible && state.creatingSession) {
    dispatch({ type: "setCreatingSession", visible: false });
  }

  if (!visible) {
    if (state.showingPasteComposer && pasteInputElement) {
      pasteInputElement.value = "";
    }

    dispatch({ type: "setShowingPasteComposer", visible: false });
    return;
  }

  dispatch({ type: "setShowingPasteComposer", visible: true });
  pasteInputElement?.focus();
  pasteInputElement?.select();
}

async function retryConnection() {
  const requestedSession = state.currentSession ?? readSessionFromLocation();

  await loadSessions();

  if (requestedSession) {
    await openSession(requestedSession, { preserveTerminal: true, historyMode: "replace" });
    return;
  }

  const fallbackSession = stableSessions(state.sessions)[0]?.name;
  if (fallbackSession) {
    await openSession(fallbackSession, { preserveTerminal: true, historyMode: "replace" });
  }
}

async function connectTerminal(
  sessionName: string,
  options: { preserveTerminal?: boolean; historyMode?: HistoryMode } = {}
) {
  if (runtime.ws) {
    runtime.suppressedSocket = runtime.ws;
    const previousSocket = runtime.ws;
    runtime.ws = null;
    previousSocket.close();
  }

  if (!options.preserveTerminal) {
    terminal.clear();
  }

  sessionRequests.advanceSessionGeneration();
  dispatch({ type: "setCurrentSession", sessionName });
  syncBrowserSession(sessionName, options.historyMode ?? "push");

  const ws = new WebSocket(buildTerminalSocketUrl(sessionName));
  runtime.ws = ws;
  lastResizeCols = null;
  lastResizeRows = null;
  terminal.focus();

  ws.addEventListener("open", () => {
    dispatch({ type: "setConnectionIssue", message: null });
  });

  ws.addEventListener("error", () => {
    if (runtime.ws === ws) {
      dispatch({ type: "setConnectionIssue", message: DEFAULT_CONNECTION_ISSUE });
    }
  });

  ws.addEventListener("message", async (event) => {
    if (runtime.ws !== ws) {
      return;
    }

    const payload = JSON.parse(event.data) as SocketPayload;

    if (payload.type === "ready") {
      dispatch({ type: "setConnectionIssue", message: null });
      dispatch({ type: "setCurrentSession", sessionName: payload.sessionName });
      syncBrowserSession(payload.sessionName, options.historyMode ?? "push");
      await Promise.all([loadSessionState(), refreshSessionListIfStale(true)]);
      scheduleFit({ force: true });
      return;
    }

    if (payload.type === "data") {
      terminal.write(payload.data);
      return;
    }

    if (payload.type === "tmux") {
      await handleTmuxNotification(payload);
      return;
    }

    if (payload.type === "error") {
      dispatch({ type: "setConnectionIssue", message: payload.message ?? DEFAULT_CONNECTION_ISSUE });
      reportError(payload.message ?? "terminal transport failed");
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true, clearSession: false, historyMode: "skip" });
      return;
    }

    if (payload.type === "exit") {
      await handleTerminalExit(ws, sessionName, payload.exitCode);
    }
  });

  ws.addEventListener("close", () => {
    if (runtime.suppressedSocket === ws) {
      runtime.suppressedSocket = null;
      return;
    }

    if (runtime.ws === ws && !runtime.reconnecting) {
      dispatch({ type: "setConnectionIssue", message: LOST_CONNECTION_ISSUE });
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true, clearSession: false, historyMode: "skip" });
      void loadSessions().catch((error) => {
        reportError(error);
      });
    }
  });
}

function disconnectTerminal(options: DisconnectOptions = {}) {
  const resolvedOptions: Required<Pick<DisconnectOptions, "preserveTerminal" | "suppressReconnect" | "clearSession">> & {
    historyMode: HistoryMode;
  } = {
    preserveTerminal: true,
    suppressReconnect: false,
    clearSession: true,
    historyMode: "replace",
    ...options
  };

  sessionSync.clear();

  if (resolvedOptions.suppressReconnect && runtime.ws) {
    runtime.suppressedSocket = runtime.ws;
  }

  if (runtime.ws) {
    const ws = runtime.ws;
    runtime.ws = null;
    ws.close();
  }

  lastResizeCols = null;
  lastResizeRows = null;
  sessionRequests.advanceSessionGeneration();

  dispatch({ type: "disconnect", clearSession: resolvedOptions.clearSession });

  if (resolvedOptions.clearSession) {
    syncBrowserSession(null, resolvedOptions.historyMode);
  }

  if (!resolvedOptions.preserveTerminal) {
    terminal.clear();
  }
}

async function splitPane(direction: "vertical" | "horizontal") {
  const sessionName = state.currentSession;

  if (!sessionName) {
    return;
  }

  const response = await api<SessionStatePayload>(`/api/sessions/${encodeURIComponent(sessionName)}/panes`, {
    method: "POST",
    body: JSON.stringify({
      direction,
      targetPane: state.currentPane ?? undefined
    })
  });

  replaceSessionState(sessionName, response);
  scheduleFit({ force: true });
}

async function selectWindow(windowIndex: number) {
  const sessionName = state.currentSession;

  if (!sessionName) {
    return;
  }

  const response = await api<SessionStatePayload>(
    `/api/sessions/${encodeURIComponent(sessionName)}/windows/${encodeURIComponent(String(windowIndex))}/select`,
    { method: "POST" }
  );

  replaceSessionState(sessionName, response);
  scheduleFit({ force: true });
  terminal.focus();
}

async function selectPane(paneId: string) {
  const sessionName = state.currentSession;

  if (!sessionName) {
    return;
  }

  const response = await api<SessionStatePayload>(
    `/api/sessions/${encodeURIComponent(sessionName)}/panes/${encodeURIComponent(paneId)}/select`,
    { method: "POST" }
  );

  replaceSessionState(sessionName, response);
  terminal.focus();
}

function updateTerminalFontSize(fontSize: number) {
  const nextFontSize = applyTerminalFontSize(fontSize);

  if (nextFontSize === state.terminalFontSize) {
    return;
  }

  dispatch({ type: "setTerminalFontSize", fontSize: nextFontSize });
  scheduleFit();
}

function sendMessage(payload: Record<string, unknown>) {
  if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  runtime.ws.send(JSON.stringify(payload));
}

function scheduleFit(options: { force?: boolean } = {}) {
  pendingFitForce = pendingFitForce || (options.force ?? false);

  if (pendingFitFrame || pendingSettledFitFrame) {
    return;
  }

  pendingFitFrame = window.requestAnimationFrame(() => {
    pendingFitFrame = 0;

    pendingSettledFitFrame = window.requestAnimationFrame(() => {
      pendingSettledFitFrame = 0;
      const force = pendingFitForce;
      pendingFitForce = false;

      const dimensions = fitTerminal();

      if (!dimensions) {
        return;
      }

      if (!force && lastResizeCols === dimensions.cols && lastResizeRows === dimensions.rows) {
        return;
      }

      lastResizeCols = dimensions.cols;
      lastResizeRows = dimensions.rows;
      runtime.lastLocalResizeAt = Date.now();

      sendMessage({
        type: "resize",
        cols: dimensions.cols,
        rows: dimensions.rows,
        force: force || undefined
      });
    });
  });
}

async function syncCurrentSession() {
  return sessionSync.run({ refreshSessions: false, ignoreHidden: false });
}

function requestSessionSync(options: { refreshSessions?: boolean; ignoreHidden?: boolean; forceResize?: boolean } = {}) {
  if (!state.currentSession) {
    return;
  }

  sessionSync.request(options);
}

async function handleTerminalExit(ws: WebSocket, sessionName: string, exitCode: number | undefined) {
  const shouldSuppress = runtime.suppressedSocket === ws;
  const reconnectSession = state.currentSession ?? sessionName;

  terminal.writeln(`\r\n[tmux client exited: ${exitCode}]`);
  disconnectTerminal({ preserveTerminal: true, suppressReconnect: true, clearSession: false });

  if (shouldSuppress || !reconnectSession) {
    return;
  }

  runtime.reconnecting = true;

  try {
    await loadSessions();

    if (state.currentSession && state.currentSession !== reconnectSession) {
      return;
    }

    const sessionStillExists = state.sessions.some((session) => session.name === reconnectSession);
    if (sessionStillExists) {
      await connectTerminal(reconnectSession, { preserveTerminal: true, historyMode: "replace" });
      return;
    }

    disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
  } finally {
    runtime.reconnecting = false;
  }
}

async function handleTmuxNotification(payload: TmuxNotificationPayload) {
  if (payload.sessionName && payload.sessionName !== state.currentSession) {
    sessionRequests.advanceSessionGeneration();
    dispatch({ type: "setCurrentSession", sessionName: payload.sessionName });
    syncBrowserSession(payload.sessionName, "replace");
  }

  if (!state.currentSession) {
    if (payload.refreshSessions) {
      await loadSessions();
    }

    return;
  }

  if (!payload.refreshState && !payload.refreshSessions) {
    return;
  }

  if (payload.ignoreResizeEcho && Date.now() - runtime.lastLocalResizeAt < LOCAL_RESIZE_ECHO_WINDOW_MS) {
    return;
  }

  requestSessionSync({
    refreshSessions: payload.refreshSessions,
    ignoreHidden: true,
    forceResize: payload.forceResize
  });
}

async function openSession(
  sessionName: string,
  options: { preserveTerminal?: boolean; historyMode?: HistoryMode } = {}
) {
  const shouldReconnect = state.currentSession !== sessionName || !runtime.ws;

  if (!shouldReconnect) {
    syncBrowserSession(sessionName, options.historyMode ?? "push");
    terminal.focus();
    return;
  }

  await connectTerminal(sessionName, options);
}

function reportActionError<Args extends unknown[]>(action: (...args: Args) => Promise<void> | void) {
  return (...args: Args) => {
    try {
      const result = action(...args);
      if (result instanceof Promise) {
        void result.catch((error) => {
          reportError(error);
        });
      }
    } catch (error) {
      reportError(error);
    }
  };
}

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const connectionIssue = getConnectionIssueMessage(error, { isOnline: navigator.onLine });

  if (connectionIssue) {
    dispatch({ type: "setConnectionIssue", message: connectionIssue });
  }

  console.error(error);

  if (!connectionIssue) {
    terminal.writeln(`\r\n[error] ${message}`);
  }
}

function readErrorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

async function api<T>(path: string, init: RequestInit = {}) {
  const request: RequestInit = {
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  };

  let response: Response;

  try {
    response = await fetch(path, request);
  } catch (error) {
    const connectionIssue = getConnectionIssueMessage(error, { isOnline: navigator.onLine });

    if (connectionIssue) {
      dispatch({ type: "setConnectionIssue", message: connectionIssue });
      throw new Error(connectionIssue, { cause: error });
    }

    throw error;
  }

  dispatch({ type: "setConnectionIssue", message: null });
  const payload = await response.json().catch(() => ({} as Record<string, unknown>));

  if (!response.ok) {
    const error = new Error(
      typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`
    ) as ApiError;
    error.status = response.status;
    throw error;
  }

  return payload as T;
}

function readSessionFromLocation() {
  const match = window.location.pathname.match(/^\/s\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildSessionPath(sessionName: string | null) {
  return sessionName ? `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionName)}` : "/";
}

function syncBrowserSession(sessionName: string | null, historyMode: HistoryMode) {
  if (historyMode === "skip") {
    return;
  }

  const nextPath = buildSessionPath(sessionName);

  if (window.location.pathname === nextPath) {
    return;
  }

  const statePayload = sessionName ? { sessionName } : {};

  if (historyMode === "push") {
    window.history.pushState(statePayload, "", nextPath);
    return;
  }

  window.history.replaceState(statePayload, "", nextPath);
}

function buildTerminalSocketUrl(sessionName: string) {
  return `${protocol}://${window.location.host}/ws/terminal/${encodeURIComponent(sessionName)}`;
}

function bindTerminalFrame(element: HTMLDivElement | null) {
  if (terminalFrameElement === element) {
    return;
  }

  if (terminalFrameElement) {
    resizeObserver.unobserve(terminalFrameElement);
  }

  terminalFrameElement = element;

  if (terminalFrameElement) {
    resizeObserver.observe(terminalFrameElement);
  }
}

function bindSessionNameInput(element: HTMLInputElement | null) {
  sessionNameInputElement = element;
}

function bindPasteInput(element: HTMLTextAreaElement | null) {
  pasteInputElement = element;
}

function requireElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id}`);
  }

  return element as T;
}
