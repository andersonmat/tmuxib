import { render, type JSX } from "preact";

import { nextSessionNameAfterRemoval, stableSessions } from "./session-order.js";
import { createInitialRuntime, createInitialState, currentWindowIndex, paneLabel, reduceState, visiblePanes } from "./state.js";
import "./styles.css";
import {
  applyTerminalFontSize,
  fitTerminal,
  mountTerminal,
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

const rootElement = requireElement<HTMLDivElement>("app");

let state: ClientState = createInitialState({
  terminalFontSize: readStoredTerminalFontSize()
});

const runtime: RuntimeState = createInitialRuntime();
const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});

let workspaceElement: HTMLElement | null = null;
let terminalFrameElement: HTMLDivElement | null = null;
let sessionNameInputElement: HTMLInputElement | null = null;
let pasteInputElement: HTMLTextAreaElement | null = null;

terminal.onData((data) => {
  sendMessage({ type: "input", data });
  bumpSessionSync();
});

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

renderView();
void bootstrap();

function dispatch(action: StateAction) {
  const nextState = reduceState(state, action);

  if (nextState === state) {
    return;
  }

  state = nextState;
  renderView();
}

function renderView() {
  render(<AppView state={state} />, rootElement);
}

function AppView(props: { state: ClientState }) {
  const stableSessionEntries = stableSessions(props.state.sessions);
  const activeWindowIndex = currentWindowIndex(props.state.windows);
  const paneEntries = visiblePanes(props.state.panes, props.state.windows);
  const activePaneId = props.state.currentPane ?? paneEntries[0]?.id ?? null;
  const activeWindow = props.state.windows.find((entry) => entry.index === activeWindowIndex) ?? props.state.windows[0] ?? null;
  const activePane = paneEntries.find((pane) => pane.id === activePaneId) ?? paneEntries[0] ?? null;
  const sessionContext = currentSessionContext(props.state.currentSession, activeWindow, activePane);
  const hasSession = Boolean(props.state.currentSession);

  return (
    <div class="shell">
      <header id="session-panel" class="topbar" data-creating={String(props.state.creatingSession)}>
        <div class="topbar-shell">
          <div id="session-controls" class="topbar-main">
            <div class="session-cluster">
              <div class="session-context" aria-live="polite">
                <div class={`session-context-primary${sessionContext.hasSession ? "" : " is-empty"}`}>
                  {sessionContext.session}
                </div>
                <div class={`session-context-secondary${sessionContext.hasSession ? "" : " is-empty"}`}>
                  {sessionContext.detail}
                </div>
              </div>
            </div>
            <div class="toolbar-cluster">
              <button
                id="create-toggle-button"
                class="ghost create-toggle-button"
                type="button"
                data-active={String(props.state.creatingSession)}
                aria-expanded={props.state.creatingSession}
                onClick={() => {
                  setCreateFormVisible(!props.state.creatingSession);
                }}
              >
                Create Session
              </button>
              <div class="font-controls" role="group" aria-label="Terminal font size">
                <button
                  id="font-size-decrease-button"
                  class="ghost square"
                  type="button"
                  aria-label="Decrease terminal font size"
                  disabled={props.state.terminalFontSize <= 11}
                  onClick={() => {
                    updateTerminalFontSize(props.state.terminalFontSize - 1);
                  }}
                >
                  A-
                </button>
                <span id="font-size-value" class="font-size-value">{props.state.terminalFontSize}px</span>
                <button
                  id="font-size-increase-button"
                  class="ghost square"
                  type="button"
                  aria-label="Increase terminal font size"
                  disabled={props.state.terminalFontSize >= 18}
                  onClick={() => {
                    updateTerminalFontSize(props.state.terminalFontSize + 1);
                  }}
                >
                  A+
                </button>
              </div>
              <div class="pane-actions">
                <button
                  id="paste-button"
                  class="ghost mobile-only"
                  type="button"
                  aria-expanded={props.state.showingPasteComposer}
                  disabled={!hasSession}
                  onClick={handleAction(async () => {
                    if (!props.state.currentSession) {
                      return;
                    }

                    const pasted = await pasteFromClipboard();

                    if (pasted) {
                      setPasteComposerVisible(false);
                      bumpSessionSync(0);
                      return;
                    }

                    setPasteComposerVisible(true);
                  })}
                >
                  Paste
                </button>
                <button
                  id="split-vertical-button"
                  class="ghost"
                  type="button"
                  disabled={!hasSession}
                  onClick={handleAction(async () => {
                    await splitPane("vertical");
                  })}
                >
                  Below
                </button>
                <button
                  id="split-horizontal-button"
                  class="ghost"
                  type="button"
                  disabled={!hasSession}
                  onClick={handleAction(async () => {
                    await splitPane("horizontal");
                  })}
                >
                  Right
                </button>
              </div>
            </div>
          </div>

          <form
            id="session-form"
            class={`session-form${props.state.creatingSession ? "" : " hidden"}`}
            onSubmit={handleAction(async (event) => {
              event.preventDefault();

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
            })}
          >
            <input
              id="session-name-input"
              name="sessionName"
              type="text"
              placeholder="new session"
              autocomplete="off"
              aria-label="Session name"
              ref={bindSessionNameInput}
            />
            <div class="create-actions">
              <button id="create-session-button" class="primary" type="submit">Create</button>
              <button
                id="create-cancel-button"
                class="ghost"
                type="button"
                onClick={() => {
                  setCreateFormVisible(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>

          <div id="session-list" class="session-list">
            {stableSessionEntries.map((session) => (
              <button
                key={session.name}
                class="session-chip"
                type="button"
                data-active={String(session.name === props.state.currentSession)}
                aria-pressed={session.name === props.state.currentSession}
                onClick={handleAction(async () => {
                  await openSession(session.name, { preserveTerminal: true, historyMode: "push" });
                })}
              >
                <span class="session-chip-name">{session.name}</span>
                <span class="session-chip-count">{session.windows}</span>
              </button>
            ))}
          </div>

          <form
            id="paste-form"
            class={`paste-form mobile-only${props.state.showingPasteComposer ? "" : " hidden"}`}
            onSubmit={handleAction(async (event) => {
              event.preventDefault();

              if (!props.state.currentSession) {
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
              bumpSessionSync(0);
            })}
          >
            <textarea
              id="paste-input"
              name="pasteInput"
              rows={4}
              placeholder="paste"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              aria-label="Paste terminal input"
              ref={bindPasteInput}
            />
            <div class="create-actions">
              <button id="paste-send-button" class="primary" type="submit" disabled={!hasSession}>Send</button>
              <button
                id="paste-cancel-button"
                class="ghost"
                type="button"
                onClick={() => {
                  setPasteComposerVisible(false);
                  terminal.focus();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </header>

      <main class="workspace" ref={bindWorkspace}>
        <div class="tab-strip tab-strip-window">
          <div id="window-tabs" class="tab-list">
            {props.state.windows.map((windowEntry) => (
              <button
                key={`${windowEntry.sessionName}:${windowEntry.index}`}
                class="tab"
                type="button"
                data-active={windowEntry.index === activeWindowIndex ? "true" : undefined}
                onClick={handleAction(async () => {
                  await selectWindow(windowEntry.index);
                })}
              >
                {windowEntry.index}:{windowEntry.name}
              </button>
            ))}
          </div>
        </div>

        <div class="tab-strip tab-strip-pane">
          <div id="pane-tabs" class="tab-list">
            {paneEntries.map((pane) => (
              <button
                key={pane.id}
                class="tab"
                type="button"
                data-active={pane.id === activePaneId ? "true" : undefined}
                onClick={handleAction(async () => {
                  await selectPane(pane.id);
                })}
              >
                {paneLabel(pane)}
              </button>
            ))}
          </div>
        </div>

        <div id="terminal-frame" class="terminal-frame" ref={bindTerminalFrame}>
          <div id="terminal" ref={mountTerminal}></div>
        </div>
      </main>
    </div>
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
  const previousSessions = state.sessions;
  const previousCurrentSession = state.currentSession;
  const { sessions } = await api<{ sessions: SessionSummary[] }>("/api/sessions");
  runtime.lastSessionListSyncAt = Date.now();

  dispatch({ type: "sessionsLoaded", sessions });

  if (!previousCurrentSession || state.currentSession !== previousCurrentSession) {
    return;
  }

  const stillExists = sessions.some((session) => session.name === previousCurrentSession);

  if (stillExists) {
    return;
  }

  const fallbackSessionName = nextSessionNameAfterRemoval(previousSessions, sessions, previousCurrentSession);

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

  try {
    const sessionState = await api<SessionStatePayload>(`/api/sessions/${encodeURIComponent(state.currentSession)}/state`);
    replaceSessionState(sessionState);
  } catch (error) {
    if (readErrorStatus(error) === 404) {
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

function handleAction(action: (event: Event) => Promise<void> | void) {
  return (event: Event) => {
    try {
      const result = action(event);
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

function currentSessionContext(
  currentSession: string | null,
  activeWindow: WindowSummary | null,
  activePane: PaneSummary | null
) {
  if (!currentSession) {
    return {
      hasSession: false,
      session: "No session selected",
      detail: "Create a session or choose one below"
    };
  }

  return {
    hasSession: true,
    session: currentSession,
    detail: `${activeWindow ? `${activeWindow.index}:${activeWindow.name}` : "No window"} · ${activePane ? activePane.command || paneLabel(activePane) : "No command"}`
  };
}

function bindWorkspace(element: HTMLElement | null) {
  if (workspaceElement === element) {
    return;
  }

  if (workspaceElement) {
    resizeObserver.unobserve(workspaceElement);
  }

  workspaceElement = element;

  if (workspaceElement) {
    resizeObserver.observe(workspaceElement);
  }
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
