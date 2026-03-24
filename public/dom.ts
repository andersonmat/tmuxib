function requireElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing #${id}`);
  }

  return element as T;
}

export const terminalElement = requireElement<HTMLDivElement>("terminal");
export const terminalFrame = requireElement<HTMLDivElement>("terminal-frame");
export const workspace = document.querySelector<HTMLDivElement>(".workspace");
export const windowTabs = requireElement<HTMLDivElement>("window-tabs");
export const paneTabs = requireElement<HTMLDivElement>("pane-tabs");
export const sessionPanel = requireElement<HTMLElement>("session-panel");
export const sessionControls = requireElement<HTMLElement>("session-controls");
export const sessionMeta = requireElement<HTMLDivElement>("session-meta");
export const sessionList = requireElement<HTMLDivElement>("session-list");
export const sessionSelect = requireElement<HTMLSelectElement>("session-select");
export const createToggleButton = requireElement<HTMLButtonElement>("create-toggle-button");
export const refreshButton = requireElement<HTMLButtonElement>("refresh-button");
export const splitVerticalButton = requireElement<HTMLButtonElement>("split-vertical-button");
export const splitHorizontalButton = requireElement<HTMLButtonElement>("split-horizontal-button");
export const fontSizeDecreaseButton = requireElement<HTMLButtonElement>("font-size-decrease-button");
export const fontSizeIncreaseButton = requireElement<HTMLButtonElement>("font-size-increase-button");
export const fontSizeValue = requireElement<HTMLElement>("font-size-value");
export const pasteButton = requireElement<HTMLButtonElement>("paste-button");
export const pasteForm = requireElement<HTMLFormElement>("paste-form");
export const pasteInput = requireElement<HTMLTextAreaElement>("paste-input");
export const pasteSendButton = requireElement<HTMLButtonElement>("paste-send-button");
export const pasteCancelButton = requireElement<HTMLButtonElement>("paste-cancel-button");
export const sessionForm = requireElement<HTMLFormElement>("session-form");
export const sessionNameInput = requireElement<HTMLInputElement>("session-name-input");
export const createSessionButton = requireElement<HTMLButtonElement>("create-session-button");
export const createCancelButton = requireElement<HTMLButtonElement>("create-cancel-button");
