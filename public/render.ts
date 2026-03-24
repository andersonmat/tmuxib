import {
  createSessionButton,
  createToggleButton,
  fontSizeDecreaseButton,
  fontSizeIncreaseButton,
  fontSizeValue,
  pasteButton,
  pasteForm,
  pasteSendButton,
  paneTabs,
  refreshButton,
  sessionControls,
  sessionForm,
  sessionList,
  sessionMeta,
  sessionPanel,
  sessionSelect,
  splitHorizontalButton,
  splitVerticalButton,
  windowTabs
} from "./dom.js";
import { currentWindowIndex, paneLabel, visiblePanes } from "./state.js";
import { MAX_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE } from "./terminal.js";
import type { ClientState, SessionSummary } from "./types.js";

interface RenderView {
  state: ClientState;
  createSessionSelectHandler: (sessionName: string) => EventListener;
  createWindowSelectHandler: (windowIndex: number) => EventListener;
  createPaneSelectHandler: (paneId: string) => EventListener;
}

export function renderApp(view: RenderView) {
  renderCreateMode(view.state);
  renderPasteComposer(view.state);
  renderSessionSelect(view.state);
  renderSessionMeta(view.state);
  renderSessionList(view.state, view.createSessionSelectHandler);
  renderFontSize(view.state);
  renderWindows(view.state, view.createWindowSelectHandler);
  renderPaneTabs(view.state, view.createPaneSelectHandler);
}

function renderCreateMode(state: ClientState) {
  const visible = state.creatingSession;
  sessionPanel.dataset.creating = String(visible);
  sessionControls.classList.toggle("hidden", visible);
  sessionMeta.classList.toggle("hidden", visible);
  sessionList.classList.toggle("hidden", visible);
  sessionForm.classList.toggle("hidden", !visible);
  createToggleButton.textContent = visible ? "−" : "+";
  createToggleButton.setAttribute("aria-expanded", String(visible));
  refreshButton.disabled = visible;
}

function renderPasteComposer(state: ClientState) {
  pasteForm.classList.toggle("hidden", !state.showingPasteComposer);
  pasteButton.setAttribute("aria-expanded", String(state.showingPasteComposer));
  pasteSendButton.disabled = !state.currentSession;
}

function renderSessionMeta(state: ClientState) {
  if (!state.currentSession) {
    sessionMeta.textContent = "";
    sessionMeta.classList.add("hidden");
    return;
  }

  const session = state.sessions.find((entry) => entry.name === state.currentSession);
  const activeWindow = state.windows.find((entry) => entry.active) ?? state.windows[0];
  const parts = [state.currentSession];

  if (typeof session?.windows === "number") {
    parts.push(`${session.windows} window${session.windows === 1 ? "" : "s"}`);
  }

  if (activeWindow) {
    parts.push(`${activeWindow.index}:${activeWindow.name}`);
  }

  sessionMeta.textContent = parts.join(" · ");
  sessionMeta.classList.remove("hidden");
}

function renderSessionSelect(state: ClientState) {
  sessionSelect.innerHTML = "";

  if (state.sessions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No sessions";
    option.selected = true;
    sessionSelect.append(option);
    sessionSelect.disabled = true;
    updateButtons(state);
    return;
  }

  sessionSelect.disabled = false;

  if (!state.currentSession) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Attach session";
    placeholder.selected = true;
    sessionSelect.append(placeholder);
  }

  for (const session of state.sessions) {
    const option = document.createElement("option");
    option.value = session.name;
    option.textContent = `${session.name} · ${session.windows}`;
    option.selected = session.name === state.currentSession;
    sessionSelect.append(option);
  }

  updateButtons(state);
}

function renderSessionList(state: ClientState, createSessionSelectHandler: (sessionName: string) => EventListener) {
  sessionList.innerHTML = "";

  if (state.sessions.length === 0) {
    return;
  }

  for (const session of orderedSessions(state.sessions, state.currentSession)) {
    const button = document.createElement("button");
    button.className = "session-chip";
    button.type = "button";
    button.dataset.active = String(session.name === state.currentSession);
    button.setAttribute("aria-pressed", String(session.name === state.currentSession));

    const name = document.createElement("span");
    name.className = "session-chip-name";
    name.textContent = session.name;

    const count = document.createElement("span");
    count.className = "session-chip-count";
    count.textContent = String(session.windows);

    button.append(name, count);
    button.addEventListener("click", createSessionSelectHandler(session.name));
    sessionList.append(button);
  }
}

function renderFontSize(state: ClientState) {
  fontSizeValue.textContent = `${state.terminalFontSize}px`;
  fontSizeDecreaseButton.disabled = state.terminalFontSize <= MIN_TERMINAL_FONT_SIZE;
  fontSizeIncreaseButton.disabled = state.terminalFontSize >= MAX_TERMINAL_FONT_SIZE;
}

function renderWindows(state: ClientState, createWindowSelectHandler: (windowIndex: number) => EventListener) {
  const activeWindowIndex = currentWindowIndex(state.windows);
  windowTabs.innerHTML = "";
  windowTabs.classList.toggle("is-empty", state.windows.length === 0);

  for (const windowEntry of state.windows) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.type = "button";
    tab.textContent = `${windowEntry.index}:${windowEntry.name}`;

    if (windowEntry.index === activeWindowIndex) {
      tab.dataset.active = "true";
    }

    tab.addEventListener("click", createWindowSelectHandler(windowEntry.index));
    windowTabs.append(tab);
  }
}

function renderPaneTabs(state: ClientState, createPaneSelectHandler: (paneId: string) => EventListener) {
  const panes = visiblePanes(state.panes, state.windows);
  const activePaneId = state.currentPane ?? panes[0]?.id ?? null;
  paneTabs.innerHTML = "";
  paneTabs.classList.toggle("is-empty", panes.length === 0);

  for (const pane of panes) {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.type = "button";
    tab.textContent = paneLabel(pane);

    if (pane.id === activePaneId) {
      tab.dataset.active = "true";
    }

    tab.addEventListener("click", createPaneSelectHandler(pane.id));
    paneTabs.append(tab);
  }

  updateButtons(state);
}

function updateButtons(state: ClientState) {
  const hasSession = Boolean(state.currentSession);
  splitVerticalButton.disabled = !hasSession;
  splitHorizontalButton.disabled = !hasSession;
  pasteButton.disabled = !hasSession;
  createSessionButton.disabled = false;
}

function orderedSessions(sessions: SessionSummary[], currentSession: string | null) {
  if (!currentSession) {
    return sessions;
  }

  return [...sessions].sort((left, right) => {
    if (left.name === currentSession) {
      return -1;
    }

    if (right.name === currentSession) {
      return 1;
    }

    return left.name.localeCompare(right.name);
  });
}
