import { stableSessions } from "./session-order.js";
import { currentWindowIndex, paneLabel, visiblePanes } from "./state.js";
import { mountTerminal } from "./terminal.js";
import type { ClientState, PaneSummary, WindowSummary } from "./types.js";

export interface AppViewProps {
  state: ClientState;
  terminalFrameRef(element: HTMLDivElement | null): void;
  sessionNameInputRef(element: HTMLInputElement | null): void;
  pasteInputRef(element: HTMLTextAreaElement | null): void;
  onToggleCreateForm(): void;
  onRetryConnection(event: Event): void;
  onCreateSessionSubmit(event: Event): void;
  onCreateSessionCancel(): void;
  onOpenSession(sessionName: string): void;
  onPasteToggle(): void;
  onSplitPane(direction: "vertical" | "horizontal"): void;
  onUpdateTerminalFontSize(fontSize: number): void;
  onPasteSubmit(event: Event): void;
  onPasteCancel(): void;
  onSelectWindow(windowIndex: number): void;
  onSelectPane(paneId: string): void;
}

export function AppView(props: AppViewProps) {
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
                  props.onToggleCreateForm();
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
                    props.onUpdateTerminalFontSize(props.state.terminalFontSize - 1);
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
                    props.onUpdateTerminalFontSize(props.state.terminalFontSize + 1);
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
                  onClick={() => {
                    props.onPasteToggle();
                  }}
                >
                  Paste
                </button>
                <button
                  id="split-vertical-button"
                  class="ghost"
                  type="button"
                  disabled={!hasSession}
                  onClick={() => {
                    props.onSplitPane("vertical");
                  }}
                >
                  Below
                </button>
                <button
                  id="split-horizontal-button"
                  class="ghost"
                  type="button"
                  disabled={!hasSession}
                  onClick={() => {
                    props.onSplitPane("horizontal");
                  }}
                >
                  Right
                </button>
              </div>
            </div>
          </div>

          {props.state.connectionIssue ? (
            <div class="connection-banner" role="status" aria-live="polite">
              <div class="connection-banner-copy">
                <span class="connection-banner-label">Connection</span>
                <span class="connection-banner-message">{props.state.connectionIssue}</span>
              </div>
              <button id="retry-connection-button" class="ghost" type="button" onClick={props.onRetryConnection}>
                Retry
              </button>
            </div>
          ) : null}

          <form
            id="session-form"
            class={`session-form${props.state.creatingSession ? "" : " hidden"}`}
            onSubmit={props.onCreateSessionSubmit}
          >
            <input
              id="session-name-input"
              name="sessionName"
              type="text"
              placeholder="new session"
              autocomplete="off"
              aria-label="Session name"
              ref={props.sessionNameInputRef}
            />
            <div class="create-actions">
              <button id="create-session-button" class="primary" type="submit">Create</button>
              <button
                id="create-cancel-button"
                class="ghost"
                type="button"
                onClick={() => {
                  props.onCreateSessionCancel();
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
                onClick={() => {
                  props.onOpenSession(session.name);
                }}
              >
                <span class="session-chip-name">{session.name}</span>
                <span class="session-chip-count">{session.windows}</span>
              </button>
            ))}
          </div>

          <form
            id="paste-form"
            class={`paste-form mobile-only${props.state.showingPasteComposer ? "" : " hidden"}`}
            onSubmit={props.onPasteSubmit}
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
              ref={props.pasteInputRef}
            />
            <div class="create-actions">
              <button id="paste-send-button" class="primary" type="submit" disabled={!hasSession}>Send</button>
              <button
                id="paste-cancel-button"
                class="ghost"
                type="button"
                onClick={() => {
                  props.onPasteCancel();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      </header>

      <main class="workspace">
        <div class="tab-strip tab-strip-window">
          <div id="window-tabs" class="tab-list">
            {props.state.windows.map((windowEntry) => (
              <button
                key={`${windowEntry.sessionName}:${windowEntry.index}`}
                class="tab"
                type="button"
                data-active={windowEntry.index === activeWindowIndex ? "true" : undefined}
                onClick={() => {
                  props.onSelectWindow(windowEntry.index);
                }}
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
                onClick={() => {
                  props.onSelectPane(pane.id);
                }}
              >
                {paneLabel(pane)}
              </button>
            ))}
          </div>
        </div>

        <div id="terminal-frame" class="terminal-frame" ref={props.terminalFrameRef}>
          <div id="terminal" ref={mountTerminal}></div>
        </div>
      </main>
    </div>
  );
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
