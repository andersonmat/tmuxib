import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export const protocol = window.location.protocol === "https:" ? "wss" : "ws";
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 11;
export const MAX_TERMINAL_FONT_SIZE = 18;

const fontSizeStorageKey = "tmuxib:font-size";
const initialFontSize = readStoredTerminalFontSize();

export const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: '"IBM Plex Mono", "Aptos Mono", "Cascadia Mono", monospace',
  fontSize: initialFontSize,
  lineHeight: 1.25,
  // tmux owns history; disabling xterm scrollback avoids the extra right gutter
  // that the fit addon reserves for a client-side scrollbar.
  scrollback: 0,
  theme: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "rgba(189, 147, 249, 0.24)"
  }
});

const fitAddon = new FitAddon();
const isApplePlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

let mountedElement: HTMLDivElement | null = null;
let clipboardBindingsInstalled = false;

terminal.loadAddon(fitAddon);

type InternalTerminal = Terminal & {
  _core?: {
    _renderService: {
      clear(): void;
      dimensions: {
        css: {
          cell: {
            width: number;
            height: number;
          };
        };
      };
    };
  };
};

export function mountTerminal(element: HTMLDivElement | null) {
  if (!element || element === mountedElement) {
    return;
  }

  mountedElement = element;
  terminal.open(element);

  if (!clipboardBindingsInstalled) {
    installClipboardBindings(element);
    clipboardBindingsInstalled = true;
  }
}

export function clampTerminalFontSize(fontSize: number) {
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

export function readStoredTerminalFontSize() {
  try {
    const rawValue = window.localStorage.getItem(fontSizeStorageKey);
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
      return DEFAULT_TERMINAL_FONT_SIZE;
    }

    return clampTerminalFontSize(parsed);
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function applyTerminalFontSize(fontSize: number) {
  const nextFontSize = clampTerminalFontSize(fontSize);
  terminal.options.fontSize = nextFontSize;

  try {
    window.localStorage.setItem(fontSizeStorageKey, String(nextFontSize));
  } catch {
    // Local storage access can fail in hardened browser contexts.
  }

  return nextFontSize;
}

export function fitTerminal() {
  const dimensions = fitAddon.proposeDimensions();
  const internalTerminal = terminal as InternalTerminal;
  const renderService = internalTerminal._core?._renderService;

  if (!dimensions || !renderService) {
    return;
  }
  const cols = Math.floor(dimensions.cols);
  const rows = Math.floor(dimensions.rows);

  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) {
    return;
  }

  if (internalTerminal.cols !== cols || internalTerminal.rows !== rows) {
    renderService.clear();
    internalTerminal.resize(cols, rows);
  }

  return { cols, rows };
}

function installClipboardBindings(element: HTMLDivElement) {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") {
      return true;
    }

    if (shouldSelectAll(event)) {
      event.preventDefault();
      terminal.selectAll();
      return false;
    }

    if (shouldCopySelection(event)) {
      event.preventDefault();
      void copySelectionToClipboard();
      return false;
    }

    if (shouldPasteFromClipboard(event)) {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }

    return true;
  });

  element.addEventListener("copy", (event) => {
    if (!terminal.hasSelection() || !event.clipboardData) {
      return;
    }

    event.clipboardData.setData("text/plain", terminal.getSelection());
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });

  element.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");

    if (typeof text !== "string") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    terminal.focus();
    terminal.paste(text);
  }, { capture: true });
}

function shouldSelectAll(event: KeyboardEvent) {
  const key = event.key.toLowerCase();

  if (isApplePlatform) {
    return event.metaKey && !event.ctrlKey && !event.altKey && key === "a";
  }

  return event.ctrlKey && event.shiftKey && !event.altKey && key === "a";
}

function shouldCopySelection(event: KeyboardEvent) {
  if (!terminal.hasSelection()) {
    return false;
  }

  const key = event.key.toLowerCase();

  if (isApplePlatform) {
    return event.metaKey && !event.ctrlKey && !event.altKey && key === "c";
  }

  return event.ctrlKey && event.shiftKey && !event.altKey && key === "c";
}

function shouldPasteFromClipboard(event: KeyboardEvent) {
  if (event.altKey) {
    return false;
  }

  if (isApplePlatform) {
    return false;
  }

  if (!navigator.clipboard?.readText) {
    return false;
  }

  const key = event.key.toLowerCase();
  return (event.ctrlKey && event.shiftKey && key === "v") || (!event.ctrlKey && event.shiftKey && key === "insert");
}

async function copySelectionToClipboard() {
  const text = terminal.getSelection();

  if (!text) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      terminal.focus();
      return;
    } catch {
      // Fall back to execCommand for browsers that block async clipboard writes.
    }
  }

  const shadowTextarea = document.createElement("textarea");
  shadowTextarea.value = text;
  shadowTextarea.setAttribute("readonly", "true");
  shadowTextarea.tabIndex = -1;
  shadowTextarea.style.position = "fixed";
  shadowTextarea.style.left = "-9999px";
  shadowTextarea.style.top = "0";
  shadowTextarea.style.opacity = "0";

  document.body.append(shadowTextarea);
  shadowTextarea.select();

  try {
    document.execCommand("copy");
  } finally {
    shadowTextarea.remove();
    terminal.focus();
  }
}

export function pasteTerminalText(text: string) {
  terminal.focus();
  terminal.paste(text);
}

export async function pasteFromClipboard() {
  if (!navigator.clipboard?.readText) {
    return false;
  }

  try {
    const text = await navigator.clipboard.readText();

    if (!text) {
      terminal.focus();
      return true;
    }

    pasteTerminalText(text);
    return true;
  } catch {
    return false;
  }
}
