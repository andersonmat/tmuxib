const FIELD_SEPARATOR = "\u001f";

export interface TmuxSessionSummary {
  name: string;
  windows: number;
  attached: number;
  created: string;
}

export interface TmuxPaneSummary {
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

export interface TmuxWindowSummary {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_attached}",
  "#{t:session_created}"
].join(FIELD_SEPARATOR);

export const PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_active}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_title}"
].join(FIELD_SEPARATOR);

export const WINDOW_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{window_panes}"
].join(FIELD_SEPARATOR);

function lines(output: string) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function parseSessions(output: string): TmuxSessionSummary[] {
  return lines(output).map((line) => {
    const [name, windows, attached, created] = line.split(FIELD_SEPARATOR);
    return {
      name,
      windows: Number.parseInt(windows, 10),
      attached: Number.parseInt(attached, 10),
      created
    };
  });
}

export function parsePanes(output: string): TmuxPaneSummary[] {
  return lines(output).map((line) => {
    const [sessionName, windowIndex, windowName, paneIndex, id, active, command, path, title] =
      line.split(FIELD_SEPARATOR);

    return {
      sessionName,
      windowIndex: Number.parseInt(windowIndex, 10),
      windowName,
      paneIndex: Number.parseInt(paneIndex, 10),
      id,
      active: active === "1",
      command,
      path,
      title
    };
  });
}

export function parseWindows(output: string): TmuxWindowSummary[] {
  return lines(output).map((line) => {
    const [sessionName, index, name, active, panes] = line.split(FIELD_SEPARATOR);

    return {
      sessionName,
      index: Number.parseInt(index, 10),
      name,
      active: active === "1",
      panes: Number.parseInt(panes, 10)
    };
  });
}
