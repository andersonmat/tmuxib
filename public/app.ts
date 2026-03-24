import {
  createCancelButton,
  createToggleButton,
  fontSizeDecreaseButton,
  fontSizeIncreaseButton,
  pasteButton,
  pasteCancelButton,
  pasteForm,
  pasteInput,
  refreshButton,
  sessionForm,
  sessionNameInput,
  sessionSelect,
  splitHorizontalButton,
  splitVerticalButton,
  terminalFrame,
  workspace
} from "./dom.js";
import { renderApp } from "./render.js";
import { createInitialRuntime, createInitialState, reduceState } from "./state.js";
import {
  applyTerminalFontSize,
  fitTerminal,
  pasteFromClipboard,
  pasteTerminalText,
  protocol,
  readStoredTerminalFontSize,
  terminal
} from "./terminal.js";
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

interface ReadyPayload {
  type: "ready";
  sessionName: string;
}

interface DataPayload {
  type: "data";
  data: string;
}

interface ErrorPayload {
  type: "error";
  message?: string;
}

interface ExitPayload {
  type: "exit";
  exitCode?: number;
}

type SocketPayload = ReadyPayload | DataPayload | ErrorPayload | ExitPayload | TmuxNotificationPayload;
type SessionStatePayload = { windows: WindowSummary[]; panes: PaneSummary[] };
type HistoryMode = NonNullable<DisconnectOptions["historyMode"]>;

const SESSION_IDLE_SYNC_INTERVAL_MS = 1000;
const SESSION_HOT_SYNC_INTERVAL_MS = 200;
const SESSION_HOT_WINDOW_MS = 2500;
const SESSION_LIST_SYNC_INTERVAL_MS = 5000;
const SESSION_ROUTE_PREFIX = "/s/";

let state: ClientState = createInitialState({
  terminalFontSize: readStoredTerminalFontSize()
});

const runtime: RuntimeState = createInitialRuntime();

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});

resizeObserver.observe(terminalFrame);
if (workspace) {
  resizeObserver.observe(workspace);
}

terminal.onData((data) => {
  sendMessage({ type: "input", data });
  bumpSessionSync();
});

refreshButton.addEventListener("click", handleAction(async () => {
  await refreshView();
}));

createToggleButton.addEventListener("click", () => {
  setCreateFormVisible(!state.creatingSession);
});

createCancelButton.addEventListener("click", () => {
  setCreateFormVisible(false);
});

pasteButton.addEventListener("click", handleAction(async () => {
  if (!state.currentSession) {
    return;
  }

  const pasted = await pasteFromClipboard();

  if (pasted) {
    setPasteComposerVisible(false);
    bumpSessionSync(0);
    return;
  }

  setPasteComposerVisible(true);
}));

pasteCancelButton.addEventListener("click", () => {
  setPasteComposerVisible(false);
  terminal.focus();
});

sessionSelect.addEventListener("change", handleAction(async () => {
  const sessionName = sessionSelect.value;

  if (!sessionName) {
    disconnectTerminal({ preserveTerminal: true, suppressReconnect: true, historyMode: "replace" });
    return;
  }

  await openSession(sessionName, { preserveTerminal: true, historyMode: "push" });
}));

splitVerticalButton.addEventListener("click", handleAction(async () => {
  await splitPane("vertical");
}));

splitHorizontalButton.addEventListener("click", handleAction(async () => {
  await splitPane("horizontal");
}));

fontSizeDecreaseButton.addEventListener("click", () => {
  updateTerminalFontSize(state.terminalFontSize - 1);
});

fontSizeIncreaseButton.addEventListener("click", () => {
  updateTerminalFontSize(state.terminalFontSize + 1);
});

sessionForm.addEventListener("submit", handleAction(async (event) => {
  event.preventDefault();

  const payload = {
    name: sessionNameInput.value.trim() || undefined
  };

  const { session } = await api<{ session: SessionSummary }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  sessionNameInput.value = "";
  setCreateFormVisible(false);
  await loadSessions();
  await openSession(session.name, { preserveTerminal: true, historyMode: "push" });
}));

pasteForm.addEventListener("submit", handleAction(async (event) => {
  event.preventDefault();

  if (!state.currentSession) {
    return;
  }

  const text = pasteInput.value;

  if (!text) {
    setPasteComposerVisible(false);
    terminal.focus();
    return;
  }

  pasteTerminalText(text);
  pasteInput.value = "";
  setPasteComposerVisible(false);
  bumpSessionSync(0);
}));

document.addEventListener("visibilitychange", handleAction(async () => {
  if (!document.hidden) {
    bumpSessionSync(0);
    await syncCurrentSession();
  }
}));

window.addEventListener("load", () => {
  scheduleFit();
});

window.addEventListener("popstate", handleAction(async () => {
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

render();
void bootstrap();

function dispatch(action: StateAction) {
  const nextState = reduceState(state, action);

  if (nextState === state) {
    return;
  }

  state = nextState;
  render();
}

function render() {
  renderApp({
    state,
    createSessionSelectHandler,
    createWindowSelectHandler,
    createPaneSelectHandler
  });
}

function createSessionSelectHandler(sessionName: string) {
  return handleAction(async () => {
    await openSession(sessionName, { preserveTerminal: true, historyMode: "push" });
  });
}

function createWindowSelectHandler(windowIndex: number) {
  return handleAction(async () => {
    await selectWindow(windowIndex);
  });
}

function createPaneSelectHandler(paneId: string) {
  return handleAction(async () => {
    await selectPane(paneId);
  });
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

async function refreshView() {
  await Promise.all([loadSessions(), loadSessionState()]);
}

async function loadSessions() {
  const { sessions } = await api<{ sessions: SessionSummary[] }>("/api/sessions");
  runtime.lastSessionListSyncAt = Date.now();

  if (state.currentSession) {
    const stillExists = sessions.some((session) => session.name === state.currentSession);

    if (!stillExists) {
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
    }
  }

  dispatch({ type: "sessionsLoaded", sessions });
}

async function loadSessionState() {
  if (!state.currentSession) {
    clearSessionState();
    return;
  }

  try {
    const sessionState = await api<SessionStatePayload>(`/api/sessions/${encodeURIComponent(state.currentSession)}/state`);
    replaceSessionState(sessionState);
  } catch (error) {
    if (readErrorStatus(error) === 404) {
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
      await loadSessions();
      return;
    }

    throw error;
  }
}

async function refreshSessionListIfStale(force = false) {
  if (force || Date.now() - runtime.lastSessionListSyncAt >= SESSION_LIST_SYNC_INTERVAL_MS) {
    await loadSessions();
  }
}

function clearSessionState() {
  dispatch({ type: "clearSessionState" });
}

function replaceSessionState(sessionState: SessionStatePayload) {
  dispatch({
    type: "replaceSessionState",
    windows: sessionState.windows,
    panes: sessionState.panes
  });
}

function setCreateFormVisible(visible: boolean) {
  if (visible && state.showingPasteComposer) {
    dispatch({ type: "setShowingPasteComposer", visible: false });
    pasteInput.value = "";
  }

  dispatch({ type: "setCreatingSession", visible });

  if (visible) {
    sessionNameInput.focus();
    sessionNameInput.select();
  }
}

function setPasteComposerVisible(visible: boolean) {
  if (visible && state.creatingSession) {
    dispatch({ type: "setCreatingSession", visible: false });
  }

  if (!visible) {
    if (state.showingPasteComposer) {
      pasteInput.value = "";
    }

    dispatch({ type: "setShowingPasteComposer", visible: false });
    return;
  }

  dispatch({ type: "setShowingPasteComposer", visible: true });
  pasteInput.focus();
  pasteInput.select();
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

  dispatch({ type: "setCurrentSession", sessionName });
  syncBrowserSession(sessionName, options.historyMode ?? "push");

  const ws = new WebSocket(buildTerminalSocketUrl(sessionName));
  runtime.ws = ws;
  terminal.focus();

  ws.addEventListener("open", () => {
    scheduleFit();
  });

  ws.addEventListener("message", async (event) => {
    if (runtime.ws !== ws) {
      return;
    }

    const payload = JSON.parse(event.data) as SocketPayload;

    if (payload.type === "ready") {
      dispatch({ type: "setCurrentSession", sessionName: payload.sessionName });
      syncBrowserSession(payload.sessionName, options.historyMode ?? "push");
      await Promise.all([loadSessionState(), refreshSessionListIfStale(true)]);
      startSessionSync();
      scheduleFit();
      return;
    }

    if (payload.type === "data") {
      terminal.write(payload.data);
      bumpSessionSync();
      return;
    }

    if (payload.type === "tmux") {
      await handleTmuxNotification(payload);
      return;
    }

    if (payload.type === "error") {
      reportError(payload.message ?? "terminal transport failed");
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
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
      disconnectTerminal({ preserveTerminal: true, suppressReconnect: true });
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

  stopSessionSync();

  if (resolvedOptions.suppressReconnect && runtime.ws) {
    runtime.suppressedSocket = runtime.ws;
  }

  if (runtime.ws) {
    const ws = runtime.ws;
    runtime.ws = null;
    ws.close();
  }

  dispatch({ type: "disconnect", clearSession: resolvedOptions.clearSession });

  if (resolvedOptions.clearSession) {
    syncBrowserSession(null, resolvedOptions.historyMode);
  }

  if (!resolvedOptions.preserveTerminal) {
    terminal.clear();
  }

  scheduleFit();
}

async function splitPane(direction: "vertical" | "horizontal") {
  if (!state.currentSession) {
    return;
  }

  const response = await api<SessionStatePayload>(`/api/sessions/${encodeURIComponent(state.currentSession)}/panes`, {
    method: "POST",
    body: JSON.stringify({
      direction,
      targetPane: state.currentPane ?? undefined
    })
  });

  replaceSessionState(response);
  scheduleFit();
}

async function selectWindow(windowIndex: number) {
  if (!state.currentSession) {
    return;
  }

  const response = await api<SessionStatePayload>(
    `/api/sessions/${encodeURIComponent(state.currentSession)}/windows/${encodeURIComponent(String(windowIndex))}/select`,
    { method: "POST" }
  );

  replaceSessionState(response);
  scheduleFit();
  terminal.focus();
}

async function selectPane(paneId: string) {
  if (!state.currentSession) {
    return;
  }

  const response = await api<SessionStatePayload>(
    `/api/sessions/${encodeURIComponent(state.currentSession)}/panes/${encodeURIComponent(paneId)}/select`,
    { method: "POST" }
  );

  replaceSessionState(response);
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

function scheduleFit() {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      fitTerminal();
      sendMessage({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows
      });
    });
  });
}

async function syncCurrentSession() {
  return syncSession({ refreshSessions: false, ignoreHidden: false });
}

async function syncSession(options: { refreshSessions?: boolean; ignoreHidden?: boolean } = {}) {
  const refreshSessions = options.refreshSessions ?? false;
  const ignoreHidden = options.ignoreHidden ?? false;

  if (!state.currentSession || runtime.syncing || (!ignoreHidden && document.hidden)) {
    return;
  }

  runtime.syncing = true;

  try {
    if (refreshSessions) {
      await loadSessions();
    }

    if (!state.currentSession) {
      return;
    }

    await loadSessionState();

    if (!refreshSessions) {
      await refreshSessionListIfStale();
    }
  } finally {
    runtime.syncing = false;
  }
}

function startSessionSync() {
  stopSessionSync();
  runtime.syncHotUntil = Date.now() + SESSION_HOT_WINDOW_MS;
  scheduleSessionSync(SESSION_HOT_SYNC_INTERVAL_MS);
}

function stopSessionSync() {
  if (runtime.syncTimer) {
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = 0;
  }

  runtime.syncing = false;
  runtime.syncHotUntil = 0;
}

function bumpSessionSync(delay = SESSION_HOT_SYNC_INTERVAL_MS) {
  if (!state.currentSession) {
    return;
  }

  runtime.syncHotUntil = Date.now() + SESSION_HOT_WINDOW_MS;

  if (runtime.syncTimer) {
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = 0;
  }

  scheduleSessionSync(delay);
}

function scheduleSessionSync(delay: number) {
  if (!state.currentSession || runtime.syncTimer) {
    return;
  }

  runtime.syncTimer = window.setTimeout(() => {
    runtime.syncTimer = 0;

    void syncCurrentSession()
      .catch((error) => {
        reportError(error);
      })
      .finally(() => {
        if (!state.currentSession) {
          return;
        }

        const nextDelay = Date.now() < runtime.syncHotUntil
          ? SESSION_HOT_SYNC_INTERVAL_MS
          : SESSION_IDLE_SYNC_INTERVAL_MS;

        scheduleSessionSync(nextDelay);
      });
  }, delay);
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
    dispatch({ type: "setCurrentSession", sessionName: payload.sessionName });
    syncBrowserSession(payload.sessionName, "replace");
  }

  if (!state.currentSession) {
    if (payload.refreshSessions) {
      await loadSessions();
    }

    return;
  }

  bumpSessionSync(0);
  await syncSession({
    refreshSessions: payload.refreshSessions,
    ignoreHidden: true
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

function handleAction(action: (event: Event) => Promise<void> | void): EventListener {
  return async (event) => {
    try {
      await action(event);
    } catch (error) {
      reportError(error);
    }
  };
}

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  terminal.writeln(`\r\n[error] ${message}`);
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

  const response = await fetch(path, request);
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
