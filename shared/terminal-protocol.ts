import type { TmuxNotificationPayload } from "./tmux-events";

export interface ReadyPayload {
  type: "ready";
  sessionName: string;
}

export interface DataPayload {
  type: "data";
  data: string;
}

export interface ErrorPayload {
  type: "error";
  message?: string;
}

export interface ExitPayload {
  type: "exit";
  exitCode?: number;
}

export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
  force?: boolean;
}

export interface InputMessage {
  type: "input";
  data: string;
}

export interface BridgePayload {
  type: "ready" | "data" | "exit" | "error";
  data?: string;
  exitCode?: number;
  signal?: number;
  message?: string;
}

export type SocketPayload = ReadyPayload | DataPayload | ErrorPayload | ExitPayload | TmuxNotificationPayload;
